import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_MODE_SYSTEM_PROMPT, setCollaborationMode } from "../../../src/core/collaboration-mode.ts";
import { createSkill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../extension-test-utils.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const skillPath = "/workspace/.diffex/skills/focused/SKILL.md";
const skill = createSkill({
	name: "focused",
	description: "Focused workflow",
	filePath: skillPath,
	baseDir: "/workspace/.diffex/skills/focused",
	sourceInfo: createSyntheticSourceInfo(skillPath, { source: "local", scope: "project" }),
	content: "---\nname: focused\ndescription: Focused workflow\n---\n\n# Focused",
});
const skillListing = "<name>focused</name>";

function skillResourceLoader() {
	return {
		...createTestResourceLoader(),
		getSkills: () => ({ skills: [skill], diagnostics: [] }),
	};
}

describe("#177 skill toggles with collaboration modes", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each(["default", "plan"] as const)(
		"refreshes the next %s prompt without widening filtered tools",
		async (mode) => {
			const harness = await createHarness({
				resourceLoader: skillResourceLoader(),
				allowedToolNames: ["read", "grep", "bash"],
				excludedToolNames: ["grep"],
			});
			harnesses.push(harness);
			setCollaborationMode(harness.session, mode);
			const expectedTools = mode === "plan" ? ["read"] : ["read", "bash"];
			const prompts: string[] = [];
			const tools: string[][] = [];
			harness.setResponses(
				[false, true].map(() => (context) => {
					prompts.push(context.systemPrompt ?? "");
					tools.push(context.tools?.map((tool) => tool.name) ?? []);
					return fauxAssistantMessage("done");
				}),
			);

			const originalPrompt = harness.session.systemPrompt;
			expect(harness.session.setSkillEnabled("unknown", false)).toBe(false);
			expect(harness.session.systemPrompt).toBe(originalPrompt);
			for (const enabled of [false, true]) {
				expect(harness.session.setSkillEnabled(skill.skillId, enabled)).toBe(true);
				expect(harness.session.createSkillReferences()[0]?.enabled).toBe(enabled);
				expect(harness.session.getActiveToolNames()).toEqual(expectedTools);
				await harness.session.prompt("Inspect the task");
			}

			expect(prompts).toHaveLength(2);
			expect(prompts[0]).not.toContain(skillListing);
			expect(prompts[1]).toContain(skillListing);
			for (const prompt of prompts) {
				expect(prompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(mode === "plan" ? 2 : 1);
			}
			expect(tools).toEqual([expectedTools, expectedTools]);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it.each(["default", "plan"] as const)(
		"preserves %s run refresh semantics through tool continuation and retry",
		async (mode) => {
			const harness = await createHarness({
				resourceLoader: skillResourceLoader(),
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
			});
			harnesses.push(harness);
			const readPath = join(harness.tempDir, "evidence.txt");
			writeFileSync(readPath, "Evidence");
			setCollaborationMode(harness.session, mode);
			const admittedTools = harness.session.agent.state.tools.slice();
			const prompts: string[] = [];
			const tools: object[][] = [];
			let toggleResult = false;
			let promptAfterToggle = "";
			harness.setResponses([
				(context) => {
					prompts.push(context.systemPrompt ?? "");
					tools.push(context.tools ?? []);
					toggleResult = harness.session.setSkillEnabled(skill.skillId, false);
					promptAfterToggle = harness.session.systemPrompt;
					return fauxAssistantMessage(fauxToolCall("read", { path: readPath }), { stopReason: "toolUse" });
				},
				(context) => {
					prompts.push(context.systemPrompt ?? "");
					tools.push(context.tools ?? []);
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });
				},
				(context) => {
					prompts.push(context.systemPrompt ?? "");
					tools.push(context.tools ?? []);
					return fauxAssistantMessage("recovered");
				},
				(context) => {
					prompts.push(context.systemPrompt ?? "");
					return fauxAssistantMessage("next run");
				},
			]);

			await harness.session.prompt("Inspect evidence");
			expect(toggleResult).toBe(true);
			expect(prompts).toHaveLength(3);
			expect(prompts[0]).toContain(skillListing);
			for (const prompt of [promptAfterToggle, ...prompts.slice(1)]) {
				if (mode === "plan") expect(prompt).toBe(prompts[0]);
				else expect(prompt).not.toContain(skillListing);
			}
			for (const turnTools of tools) {
				expect(turnTools).toHaveLength(admittedTools.length);
				expect(turnTools.every((tool, index) => tool === admittedTools[index])).toBe(true);
			}
			expect(harness.eventsOfType("tool_execution_end").map((event) => event.isError)).toEqual([false]);
			expect(harness.eventsOfType("auto_retry_end")).toContainEqual({
				type: "auto_retry_end",
				success: true,
				attempt: 1,
			});
			expect(getAssistantTexts(harness)).toContain("recovered");
			expect(harness.session.systemPrompt).not.toContain(skillListing);
			await harness.session.prompt("Next request");
			expect(prompts[3]).not.toContain(skillListing);
			expect(prompts[3]?.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(mode === "plan" ? 2 : 1);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("keeps the admitted Plan prompt and extension override when toggled during preflight", async () => {
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nExtension guidance` }));
			},
		]);
		const harness = await createHarness({
			resourceLoader: { ...skillResourceLoader(), getExtensions: () => extensionsResult },
		});
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		const prompts: string[] = [];
		harness.setResponses(
			[false, true].map(() => (context) => {
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("planned");
			}),
		);

		const admittedPrompt = harness.session.prompt("Plan with the admitted skill");
		expect(harness.session.setSkillEnabled(skill.skillId, false)).toBe(true);
		await admittedPrompt;
		await harness.session.prompt("Plan without the disabled skill");

		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain(skillListing);
		expect(prompts[1]).not.toContain(skillListing);
		for (const prompt of prompts) {
			expect(prompt).toContain("Extension guidance");
			expect(prompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(2);
		}
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
