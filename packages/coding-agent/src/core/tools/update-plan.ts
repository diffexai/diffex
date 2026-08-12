import type { AgentTool } from "@earendil-works/diffex-agent-core";
import { Container, Text } from "@earendil-works/diffex-tui";
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

export interface UpdatePlanToolInput {
	plan: UpdatePlanItem[];
}

export interface UpdatePlanToolDetails {
	plan: UpdatePlanItem[];
}

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
		plan: Type.Array(updatePlanItemSchema, {
			minItems: 1,
			description: "Full ordered plan snapshot.",
		}),
	},
	{ additionalProperties: false },
);

export const updatePlanToolSystemPromptContribution = {
	snippet: "track progress with an ordered task checklist",
	guidelines: [
		"Use update_plan for complex or multi-step work; skip it for simple work.",
		"Keep the full update_plan checklist current with exactly one in_progress item until all items are completed.",
		"Updating the update_plan checklist communicates progress and does not execute the steps.",
	],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpdatePlanStatus(value: unknown): value is UpdatePlanStatus {
	return typeof value === "string" && (UPDATE_PLAN_STATUSES as readonly string[]).includes(value);
}

function validatePlanSnapshot(input: UpdatePlanToolInput): UpdatePlanToolDetails {
	const rawPlan = (input as { plan?: unknown }).plan;
	if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
		throw new Error("Plan must contain at least one item.");
	}

	const plan: UpdatePlanItem[] = [];
	for (let index = 0; index < rawPlan.length; index++) {
		const rawItem = rawPlan[index];
		if (!isRecord(rawItem)) {
			throw new Error(`Plan item ${index + 1} must be an object.`);
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

	return { plan };
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
			return theme.fg("success", "[x]");
		case "in_progress":
			return theme.fg("warning", "[>]");
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

function formatPlanCall(args: unknown, theme: Theme): string {
	let text = theme.fg("toolTitle", theme.bold("update_plan"));
	if (!isRecord(args) || !Array.isArray(args.plan)) {
		return `${text}\n${invalidArgText(theme)}`;
	}

	for (const item of args.plan) {
		if (!isRecord(item)) {
			text += `\n${invalidArgText(theme)}`;
			continue;
		}
		text += `\n${formatPlanMarker(item.status, theme)} ${formatPlanStep(item.step, theme)}`;
	}
	return text;
}

export function createUpdatePlanToolDefinition(): ToolDefinition<typeof updatePlanSchema, UpdatePlanToolDetails> {
	return {
		name: "update_plan",
		label: "update_plan",
		description:
			"Update the full ordered task checklist for complex or multi-step work. Provide the complete current plan snapshot; exactly one item must be in_progress until all items are completed.",
		promptSnippet: updatePlanToolSystemPromptContribution.snippet,
		promptGuidelines: [...updatePlanToolSystemPromptContribution.guidelines],
		parameters: updatePlanSchema,
		async execute(_toolCallId, input) {
			const details = validatePlanSnapshot(input);
			return {
				content: [{ type: "text", text: formatPlanSummary(details.plan) }],
				details,
			};
		},
		renderCall(args, theme) {
			return new Text(formatPlanCall(args, theme), 0, 0);
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
