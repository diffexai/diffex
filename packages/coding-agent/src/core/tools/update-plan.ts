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
	step: string;
	status: UpdatePlanStatus;
}

export type UpdatePlanToolInput =
	| {
			plan: UpdatePlanItem[];
			explanation?: string;
	  }
	| {
			clear: true;
			explanation?: string;
	  };

export type UpdatePlanToolDetails = UpdatePlanToolInput;

const updatePlanStatusSchema = Type.Unsafe<UpdatePlanStatus>({
	type: "string",
	enum: [...UPDATE_PLAN_STATUSES],
	description: "Status of this plan item.",
});

const updatePlanItemSchema = Type.Object(
	{
		step: Type.String({ description: "Task step text." }),
		status: updatePlanStatusSchema,
	},
	{ additionalProperties: false },
);

const updatePlanSchema = Type.Object(
	{
		plan: Type.Optional(
			Type.Array(updatePlanItemSchema, {
				minItems: 1,
				description: "Full ordered plan snapshot. Provide exactly one operation: plan or clear.",
			}),
		),
		clear: Type.Optional(
			Type.Literal(true, {
				description: "Explicitly abandon and clear the current plan. Provide exactly one operation: plan or clear.",
			}),
		),
		explanation: Type.Optional(Type.String({ description: "Reason for changing or clearing the plan." })),
	},
	{ additionalProperties: false },
);

export const updatePlanToolSystemPromptContribution = {
	snippet: "track progress with an ordered task checklist",
	guidelines: [
		"Use update_plan for complex, ambiguous, dependent, long-running, or multi-part work, when the user requests a plan, or when checkpoints would improve collaboration; skip it for simple or immediately executable work.",
		"Write short, ordered, outcome-focused steps with observable evidence where useful; do not narrate commands or pad the checklist with obvious actions.",
		"Include final verification when correctness requires it.",
		"Update the checklist at meaningful milestones and mark completed work before moving on.",
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

function validatePlanSnapshot(rawPlan: unknown): UpdatePlanItem[] {
	if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
		throw new Error("Plan must contain at least one item.");
	}

	const plan: UpdatePlanItem[] = [];
	for (let index = 0; index < rawPlan.length; index++) {
		const rawItem = rawPlan[index];
		if (!isRecord(rawItem)) {
			throw new Error(`Plan item ${index + 1} must be an object.`);
		}
		const unexpectedField = Object.keys(rawItem).find((field) => field !== "step" && field !== "status");
		if (unexpectedField !== undefined) {
			throw new Error(`Plan item ${index + 1} contains unexpected field: ${unexpectedField}.`);
		}

		const { step, status } = rawItem;
		if (typeof step !== "string" || step.trim().length === 0) {
			throw new Error(`Plan item ${index + 1} step must be a non-empty string.`);
		}
		if (!isUpdatePlanStatus(status)) {
			throw new Error(`Plan item ${index + 1} status must be pending, in_progress, or completed.`);
		}

		plan.push({ step, status });
	}

	const counts = countPlanStatuses(plan);
	if (counts.completed !== plan.length && counts.inProgress !== 1) {
		throw new Error("Unfinished plans must contain exactly one in_progress item.");
	}

	return plan;
}

export function parseUpdatePlanOperation(input: unknown): UpdatePlanToolDetails {
	if (!isRecord(input)) {
		throw new Error("update_plan input must be an object.");
	}

	const unexpectedField = Object.keys(input).find(
		(field) => field !== "plan" && field !== "clear" && field !== "explanation",
	);
	if (unexpectedField !== undefined) {
		throw new Error(`Unexpected update_plan field: ${unexpectedField}.`);
	}

	const hasPlan = Object.hasOwn(input, "plan");
	const hasClear = Object.hasOwn(input, "clear");
	if (hasPlan === hasClear) {
		throw new Error("Provide exactly one update_plan operation: plan or clear.");
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

	const plan = validatePlanSnapshot(input.plan);
	return hasExplanation ? { plan, explanation } : { plan };
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
	let details: UpdatePlanToolDetails;
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

	for (const item of details.plan) {
		text += `\n${formatPlanMarker(item.status, theme)} ${formatPlanStep(item.step, theme)}`;
	}
	return text;
}

export function createUpdatePlanToolDefinition(): ToolDefinition<typeof updatePlanSchema, UpdatePlanToolDetails> {
	return {
		name: "update_plan",
		label: "update_plan",
		description:
			"Replace or explicitly clear the full ordered task checklist. Unfinished plans require exactly one in_progress item.",
		promptSnippet: updatePlanToolSystemPromptContribution.snippet,
		promptGuidelines: [...updatePlanToolSystemPromptContribution.guidelines],
		parameters: updatePlanSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			const details = parseUpdatePlanOperation(input);
			return {
				content: [
					{
						type: "text",
						text: "clear" in details ? "Plan cleared." : formatPlanSummary(details.plan),
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

export function createUpdatePlanTool(): AgentTool<typeof updatePlanSchema> {
	return wrapToolDefinition(createUpdatePlanToolDefinition());
}
