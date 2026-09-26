import type { AgentTool } from "@diffexai/diffex-agent-core";
import { Container, Text } from "@diffexai/diffex-tui";
import { Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, invalidArgText } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const UPDATE_PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;

export type UpdatePlanStatus = (typeof UPDATE_PLAN_STATUSES)[number];

export interface UpdatePlanItem {
	id: string;
	step: string;
	status: UpdatePlanStatus;
	success_criteria?: string[];
}

export type UpdatePlanToolInput =
	| {
			plan: UpdatePlanItem[];
			explanation?: string;
	  }
	| {
			update: { id: string; step?: string; status?: UpdatePlanStatus; success_criteria?: string[] };
			explanation?: string;
	  }
	| {
			clear: true;
			explanation?: string;
	  };

export type UpdatePlanToolDetails = Exclude<UpdatePlanToolInput, { update: unknown }>;

const updatePlanStatusSchema = Type.Unsafe<UpdatePlanStatus>({
	type: "string",
	enum: [...UPDATE_PLAN_STATUSES],
	description: "Status of this plan item.",
});

const updatePlanItemSchema = Type.Object(
	{
		id: Type.String({ description: "Stable step ID; retain it across edits and reordering." }),
		step: Type.String({ description: "Task step text." }),
		status: updatePlanStatusSchema,
		success_criteria: Type.Optional(Type.Array(Type.String(), { description: "Observable completion criteria." })),
	},
	{ additionalProperties: false },
);

const updatePlanSchema = Type.Object(
	{
		plan: Type.Optional(
			Type.Array(updatePlanItemSchema, {
				minItems: 1,
				description: "Full ordered plan snapshot. Keep existing IDs for retained steps.",
			}),
		),
		update: Type.Optional(
			Type.Object(
				{
					id: Type.String({ description: "ID of an existing step." }),
					step: Type.Optional(Type.String()),
					status: Type.Optional(updatePlanStatusSchema),
					success_criteria: Type.Optional(Type.Array(Type.String())),
				},
				{ additionalProperties: false },
			),
		),
		clear: Type.Optional(
			Type.Literal(true, {
				description: "Explicitly abandon and clear the current plan.",
			}),
		),
		explanation: Type.Optional(Type.String({ description: "Reason for changing or clearing the plan." })),
	},
	{ additionalProperties: false },
);

export const updatePlanToolSystemPromptContribution = {
	snippet: "persist an ordered plan with step IDs and optional success criteria",
	guidelines: [
		"Use update_plan for complex, ambiguous, dependent, long-running, or multi-part work, when the user requests a plan, or when checkpoints would improve collaboration; skip it for simple or immediately executable work.",
		"Write short, ordered, outcome-focused steps. Give each step a stable ID and add success_criteria for subtasks needing validation.",
		"Include final verification when correctness requires it.",
		"Update by ID at meaningful milestones; retain IDs when rewording, reordering, or changing status.",
		"Explain material replanning, omit explanations for routine progress, and use clear: true only when abandoning the checklist.",
		"Publishing the checklist communicates progress but does not execute, schedule, or prove completion of its steps.",
	],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpdatePlanStatus(value: unknown): value is UpdatePlanStatus {
	return typeof value === "string" && (UPDATE_PLAN_STATUSES as readonly string[]).includes(value);
}

function validateCriteria(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((criterion) => typeof criterion !== "string" || criterion.trim().length === 0)
	) {
		throw new Error(`${label} must be an array of non-empty strings.`);
	}
	return [...value];
}

function validatePlanSnapshot(rawPlan: unknown): UpdatePlanItem[] {
	if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
		throw new Error("Plan must contain at least one item.");
	}

	const plan: UpdatePlanItem[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < rawPlan.length; index++) {
		const rawItem = rawPlan[index];
		if (!isRecord(rawItem)) {
			throw new Error(`Plan item ${index + 1} must be an object.`);
		}
		const unexpectedField = Object.keys(rawItem).find(
			(field) => field !== "id" && field !== "step" && field !== "status" && field !== "success_criteria",
		);
		if (unexpectedField !== undefined) {
			throw new Error(`Plan item ${index + 1} contains unexpected field: ${unexpectedField}.`);
		}

		const { id, step, status } = rawItem;
		if (typeof id !== "string" || id.trim().length === 0) {
			throw new Error(`Plan item ${index + 1} id must be a non-empty string.`);
		}
		if (ids.has(id)) {
			throw new Error(`Duplicate plan item id: ${id}.`);
		}
		ids.add(id);
		if (typeof step !== "string" || step.trim().length === 0) {
			throw new Error(`Plan item ${index + 1} step must be a non-empty string.`);
		}
		if (!isUpdatePlanStatus(status)) {
			throw new Error(`Plan item ${index + 1} status must be pending, in_progress, or completed.`);
		}

		plan.push({
			id,
			step,
			status,
			...(Object.hasOwn(rawItem, "success_criteria")
				? {
						success_criteria: validateCriteria(
							rawItem.success_criteria,
							`Plan item ${index + 1} success_criteria`,
						),
					}
				: {}),
		});
	}

	const counts = countPlanStatuses(plan);
	if (counts.completed !== plan.length && counts.inProgress !== 1) {
		throw new Error("Unfinished plans must contain exactly one in_progress item.");
	}

	return plan;
}

export function parseUpdatePlanOperation(input: unknown): UpdatePlanToolInput {
	if (!isRecord(input)) {
		throw new Error("update_plan input must be an object.");
	}

	const unexpectedField = Object.keys(input).find(
		(field) => field !== "plan" && field !== "update" && field !== "clear" && field !== "explanation",
	);
	if (unexpectedField !== undefined) {
		throw new Error(`Unexpected update_plan field: ${unexpectedField}.`);
	}

	const hasPlan = Object.hasOwn(input, "plan");
	const hasUpdate = Object.hasOwn(input, "update");
	const hasClear = Object.hasOwn(input, "clear");
	if (Number(hasPlan) + Number(hasUpdate) + Number(hasClear) !== 1) {
		throw new Error("Provide exactly one update_plan operation: plan, update, or clear.");
	}

	const hasExplanation = Object.hasOwn(input, "explanation");
	if (hasExplanation && typeof input.explanation !== "string") {
		throw new Error("Explanation must be a string.");
	}
	const explanation = input.explanation as string | undefined;

	if (hasClear) {
		if (input.clear !== true) {
			throw new Error("Clear must be true.");
		}
		return hasExplanation ? { clear: true, explanation } : { clear: true };
	}
	if (hasUpdate) {
		if (!isRecord(input.update)) throw new Error("Update must be an object.");
		const unexpectedUpdateField = Object.keys(input.update).find(
			(field) => field !== "id" && field !== "step" && field !== "status" && field !== "success_criteria",
		);
		if (unexpectedUpdateField !== undefined) throw new Error(`Unexpected update field: ${unexpectedUpdateField}.`);
		const { id, step, status } = input.update;
		if (typeof id !== "string" || id.trim().length === 0) throw new Error("Update id must be a non-empty string.");
		if (step !== undefined && (typeof step !== "string" || step.trim().length === 0)) {
			throw new Error("Update step must be a non-empty string.");
		}
		if (status !== undefined && !isUpdatePlanStatus(status)) {
			throw new Error("Update status must be pending, in_progress, or completed.");
		}
		const hasCriteria = Object.hasOwn(input.update, "success_criteria");
		if (step === undefined && status === undefined && !hasCriteria)
			throw new Error("Update must change a step field.");
		const update = {
			id,
			...(step === undefined ? {} : { step }),
			...(status === undefined ? {} : { status }),
			...(hasCriteria
				? { success_criteria: validateCriteria(input.update.success_criteria, "Update success_criteria") }
				: {}),
		};
		return hasExplanation ? { update, explanation } : { update };
	}

	const plan = validatePlanSnapshot(input.plan);
	return hasExplanation ? { plan, explanation } : { plan };
}

export function resolveUpdatePlanOperation(
	input: unknown,
	currentPlan?: readonly UpdatePlanItem[],
): UpdatePlanToolDetails {
	const operation = parseUpdatePlanOperation(input);
	if (!("update" in operation)) return operation;
	if (!currentPlan) throw new Error("Cannot update a step without a current plan.");
	const index = currentPlan.findIndex((item) => item.id === operation.update.id);
	if (index < 0) throw new Error(`Unknown plan step id: ${operation.update.id}.`);
	const plan = currentPlan.map((item, itemIndex) => {
		if (itemIndex !== index) return item;
		const { success_criteria, ...changes } = operation.update;
		const updated = { ...item, ...changes };
		if (success_criteria !== undefined) {
			if (success_criteria.length === 0) delete updated.success_criteria;
			else updated.success_criteria = success_criteria;
		}
		return updated;
	});
	return {
		plan: validatePlanSnapshot(plan),
		...(operation.explanation === undefined ? {} : { explanation: operation.explanation }),
	};
}

function countPlanStatuses(plan: readonly UpdatePlanItem[]): {
	completed: number;
	inProgress: number;
	pending: number;
} {
	let completed = 0;
	let inProgress = 0;
	let pending = 0;
	for (const item of plan) {
		switch (item.status) {
			case "completed":
				completed++;
				break;
			case "in_progress":
				inProgress++;
				break;
			case "pending":
				pending++;
				break;
		}
	}
	return { completed, inProgress, pending };
}

function formatPlanSummary(plan: readonly UpdatePlanItem[]): string {
	const counts = countPlanStatuses(plan);
	return `Plan updated: ${counts.completed} completed, ${counts.inProgress} in progress, ${counts.pending} pending.`;
}

function formatPlanMarker(status: unknown, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("toolOutput", "[x]");
		case "in_progress":
			return theme.fg("toolOutput", "[>]");
		case "pending":
			return theme.fg("toolOutput", "[ ]");
		default:
			return invalidArgText(theme);
	}
}

function formatPlanStep(step: unknown, theme: Theme): string {
	if (typeof step !== "string") {
		return invalidArgText(theme);
	}
	return theme.fg("toolOutput", step);
}

function formatPlanCall(args: unknown, theme: Theme, showInvalidArgs: boolean): string {
	let text = theme.fg("toolTitle", theme.bold("update_plan"));
	let details: UpdatePlanToolInput;
	try {
		details = parseUpdatePlanOperation(args);
	} catch {
		return showInvalidArgs ? `${text}\n${invalidArgText(theme)}` : text;
	}

	if (details.explanation !== undefined) {
		text += `\n${theme.fg("toolOutput", `Explanation: ${details.explanation}`)}`;
	}
	if ("clear" in details) {
		return `${text}\n${theme.fg("toolOutput", "Plan cleared.")}`;
	}
	if ("update" in details) {
		text += `\n${theme.fg("toolOutput", `Update ${details.update.id}`)}`;
		if (details.update.status) text += ` ${formatPlanMarker(details.update.status, theme)}`;
		if (details.update.step) text += ` ${formatPlanStep(details.update.step, theme)}`;
		if (details.update.success_criteria) {
			for (const criterion of details.update.success_criteria)
				text += `\n  ${theme.fg("toolOutput", `- ${criterion}`)}`;
		}
		return text;
	}

	for (const item of details.plan) {
		text += `\n${formatPlanMarker(item.status, theme)} ${theme.fg("toolOutput", item.id)} ${formatPlanStep(item.step, theme)}`;
		for (const criterion of item.success_criteria ?? []) text += `\n  ${theme.fg("toolOutput", `- ${criterion}`)}`;
	}
	return text;
}

export function createUpdatePlanToolDefinition(
	_cwd?: string,
	getCurrentPlan?: () => readonly UpdatePlanItem[] | undefined,
): ToolDefinition<typeof updatePlanSchema, UpdatePlanToolDetails> {
	return {
		name: "update_plan",
		label: "update_plan",
		description: "Write or clear a plan, or update one step by ID. Use optional success_criteria for validation.",
		promptSnippet: updatePlanToolSystemPromptContribution.snippet,
		promptGuidelines: [...updatePlanToolSystemPromptContribution.guidelines],
		parameters: updatePlanSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			const details = resolveUpdatePlanOperation(input, getCurrentPlan?.());
			return {
				content: [
					{
						type: "text",
						text:
							"clear" in details
								? "Plan cleared."
								: `${formatPlanSummary(details.plan)}\n${JSON.stringify({ plan: details.plan }, null, 2)}`,
					},
				],
				details,
			};
		},
		renderCall(args, theme, context) {
			return new Text(
				formatPlanCall(args, theme, context.argsComplete || context.executionStarted || context.isError),
				0,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			if (!context.isError) {
				return new Container();
			}
			return new Text(`\n${theme.fg("error", getTextOutput(result, context.showImages))}`, 0, 0);
		},
	};
}

export function createUpdatePlanTool(
	getCurrentPlan?: () => readonly UpdatePlanItem[] | undefined,
): AgentTool<typeof updatePlanSchema> {
	return wrapToolDefinition(createUpdatePlanToolDefinition(undefined, getCurrentPlan));
}
