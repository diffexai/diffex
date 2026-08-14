import { describe, expect, test } from "vitest";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import {
	createUpdatePlanToolDefinition,
	updatePlanToolSystemPromptContribution,
} from "../src/core/tools/update-plan.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["update_plan", updatePlanToolSystemPromptContribution, createUpdatePlanToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test("keeps bash session-environment guidance conditional", () => {
		const definition = createBashToolDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});

	test("provides outcome-focused checklist lifecycle guidance", () => {
		expect(updatePlanToolSystemPromptContribution.guidelines).toEqual([
			"Use update_plan for complex, ambiguous, dependent, long-running, or multi-part work, when the user requests a plan, or when checkpoints would improve collaboration; skip it for simple or immediately executable work.",
			"Write short, ordered, outcome-focused steps with observable evidence where useful; do not narrate commands or pad the checklist with obvious actions.",
			"Include final verification when correctness requires it.",
			"Update the checklist at meaningful milestones and mark completed work before moving on.",
			"Explain material replanning, omit explanations for routine progress, and use clear: true only when abandoning the checklist.",
			"Publishing the checklist communicates progress but does not execute, schedule, or prove completion of its steps.",
		]);
	});
});
