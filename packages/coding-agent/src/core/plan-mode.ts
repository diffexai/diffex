import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";

export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export type CollaborationMode = "default" | "plan";

const MAX_PLAN_ID_LENGTH = 256;
const MAX_PLAN_TITLE_LENGTH = 120;
const MAX_PLAN_MARKDOWN_LENGTH = 65_536;

const submitPlanSchema = Type.Object({
	title: Type.String({
		description: "Concise title for the implementation plan.",
		minLength: 1,
		maxLength: MAX_PLAN_TITLE_LENGTH,
	}),
	markdown: Type.String({
		description: "The complete decision-ready implementation plan in Markdown.",
		minLength: 1,
		maxLength: MAX_PLAN_MARKDOWN_LENGTH,
	}),
});

export type SubmitPlanInput = Static<typeof submitPlanSchema>;

export interface PlanArtifact {
	id: string;
	title: string;
	markdown: string;
}

export type PlanResolution = "implement" | "discard";

export interface SubmitPlanToolDetails {
	plan: PlanArtifact;
}

interface SubmitPlanToolOptions {
	submitPlan: (input: SubmitPlanInput) => PlanArtifact | Promise<PlanArtifact>;
}

const unsafeControlTextPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function normalizePlanText(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} cannot be empty`);
	if (unsafeControlTextPattern.test(normalized)) {
		throw new Error(`${label} contains unsafe control text`);
	}
	return normalized;
}

/** Strictly parse and normalize an artifact before it reaches persisted or runtime plan state. */
export function parsePlanArtifact(value: unknown): PlanArtifact | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const artifact = value as Record<string, unknown>;
	if (typeof artifact.id !== "string" || typeof artifact.title !== "string" || typeof artifact.markdown !== "string") {
		return undefined;
	}
	if (
		artifact.id.length === 0 ||
		artifact.id.length > MAX_PLAN_ID_LENGTH ||
		/\s/u.test(artifact.id) ||
		unsafeControlTextPattern.test(artifact.id)
	) {
		return undefined;
	}

	try {
		const title = normalizePlanText(artifact.title, "Plan title").replace(/\s+/gu, " ");
		const markdown = normalizePlanText(artifact.markdown, "Plan Markdown");
		if (title.length > MAX_PLAN_TITLE_LENGTH || markdown.length > MAX_PLAN_MARKDOWN_LENGTH) return undefined;
		return Object.freeze({ id: artifact.id, title, markdown });
	} catch {
		return undefined;
	}
}

export function createSubmitPlanToolDefinition(options: SubmitPlanToolOptions): ToolDefinition {
	return defineTool<typeof submitPlanSchema, SubmitPlanToolDetails>({
		name: SUBMIT_PLAN_TOOL_NAME,
		label: "Submit plan",
		description:
			"Submit the complete implementation plan after repository exploration and all material decisions are resolved. This ends the planning run and waits for explicit user resolution.",
		promptSnippet: "Submit a decision-ready Markdown plan",
		parameters: submitPlanSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			const plan = await options.submitPlan({
				title: normalizePlanText(input.title, "Plan title").replace(/\s+/gu, " "),
				markdown: normalizePlanText(input.markdown, "Plan Markdown"),
			});
			return {
				content: [{ type: "text", text: `Submitted plan: ${plan.title}` }],
				details: { plan },
			};
		},
	});
}

export function createPlanImplementationPrompt(plan: PlanArtifact): string {
	return `The user explicitly accepted the following plan and authorized implementation.

# ${plan.title}

${plan.markdown}

Implement the accepted plan now. Verify the result in proportion to risk and report the completed outcome.`;
}
