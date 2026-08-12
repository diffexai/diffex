import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { defineTool } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const evolveSchema = Type.Object({
	note: Type.String({
		description:
			"A durable, reusable lesson. Do not store secrets, credentials, transient task state, or a conversation transcript.",
		minLength: 1,
		maxLength: 4000,
	}),
	category: Type.Union(
		[
			Type.Literal("preference"),
			Type.Literal("workflow"),
			Type.Literal("domain"),
			Type.Literal("correction"),
			Type.Literal("safety"),
			Type.Literal("other"),
		],
		{ description: "The kind of durable lesson being recorded." },
	),
	scope: Type.Union([Type.Literal("global"), Type.Literal("project")], {
		description: "Use project only when the lesson applies to the trusted current project.",
	}),
	appliesTo: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("harness")], {
			description:
				"Use user for an explicit preference that should follow the user across tasks. Use harness for task-specific workflows, corrections, and mistakes. Defaults to harness.",
		}),
	),
	evidence: Type.Optional(
		Type.String({
			description: "A concise source or observation supporting the note.",
			maxLength: 1000,
		}),
	),
});

export type EvolveToolInput = Static<typeof evolveSchema>;

export interface EvolveToolDetails {
	path: string;
}

export interface EvolveToolOptions {
	appendNote: (input: EvolveToolInput) => Promise<{ path: string }>;
}

export const evolveToolSystemPromptContribution = {
	snippet: "Record a durable, user-visible lesson in EVOLVED.md",
	guidelines: [
		"Use evolve only for durable lessons that should improve future sessions.",
		"Record explicit cross-task user preferences with appliesTo=user. Keep workflows, corrections, and task-specific mistakes scoped to the current harness.",
		"Never record secrets, credentials, raw conversation transcripts, or temporary task state in EVOLVED.md.",
		"Do not modify AGENTS.md, CLAUDE.md, or task profiles. The evolve tool is the only self-evolution write path.",
	],
} as const;

export function createEvolveToolDefinition(options: EvolveToolOptions) {
	return defineTool<typeof evolveSchema, EvolveToolDetails>({
		name: "evolve",
		label: "evolve",
		description:
			"Append one structured, user-visible lesson to EVOLVED.md. Use only for information that should improve future sessions.",
		promptSnippet: evolveToolSystemPromptContribution.snippet,
		promptGuidelines: [...evolveToolSystemPromptContribution.guidelines],
		parameters: evolveSchema,
		async execute(_toolCallId, input) {
			const note = input.note.trim();
			if (!note) {
				throw new Error("Evolution note must not be empty");
			}
			const result = await options.appendNote({
				...input,
				note,
				evidence: input.evidence?.trim() || undefined,
			});
			return {
				content: [{ type: "text", text: `Appended a durable lesson to ${result.path}` }],
				details: { path: result.path },
			};
		},
	});
}

export function createEvolveTool(options: EvolveToolOptions): AgentTool<typeof evolveSchema, EvolveToolDetails> {
	return wrapToolDefinition(createEvolveToolDefinition(options));
}
