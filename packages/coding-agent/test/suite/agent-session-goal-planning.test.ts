import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@diffexai/diffex-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCurrentPlanState } from "../../src/core/current-plan-state.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("goal-mode planning policy", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
		unregisterApiProviders("goal-planning-reload-test");
	});

	it("hides planning from requests and rejects stale calls without changing the persisted plan", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", { plan: [{ id: "keep", step: "Keep working", status: "in_progress" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Plan recorded."),
		]);
		await harness.session.prompt("Record a plan.");
		const plan = resolveCurrentPlanState(harness.sessionManager);
		await harness.session.setGoalModeEnabled(true);
		const fauxApi = getApiProvider(harness.faux.api)!;
		await harness.session.reload();
		// Production reload deliberately clears ad-hoc provider registrations.
		registerApiProvider(fauxApi, "goal-planning-reload-test");
		let advertised = true;
		let prompt = "";
		harness.setResponses([
			(context) => {
				advertised = context.tools?.some((tool) => tool.name === "update_plan") ?? false;
				prompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(fauxToolCall("update_plan", { clear: true }, { id: "stale-plan" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Continue."),
		]);
		await harness.session.prompt("Continue in goal mode.");
		expect(advertised).toBe(false);
		expect(prompt).not.toContain("update_plan");
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual(plan);
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "stale-plan",
			),
		).toMatchObject({ isError: true });
		await harness.session.setGoalModeEnabled(false);
		expect(harness.session.getActiveToolNames()).toContain("update_plan");
		expect(harness.session.systemPrompt).toContain("- update_plan:");
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual(plan);
	});

	it.each([
		{ initialActiveToolNames: ["read"] },
		{ excludedToolNames: ["update_plan"] },
		{ allowedToolNames: ["read"] },
		{ allowedToolNames: ["read", "update_plan"] },
		{},
	])("preserves configured availability across mode transitions and reload: %j", async (options) => {
		const harness = await createHarness(options);
		harnesses.push(harness);
		const normalTools = harness.session.getActiveToolNames();
		const normalPrompt = harness.session.systemPrompt;
		await harness.session.setGoalModeEnabled(true);
		const goalPrompt = harness.session.systemPrompt;
		const goalTools = harness.session.getActiveToolNames();
		expect(goalTools).not.toContain("update_plan");
		expect(goalPrompt).not.toContain("update_plan");
		harness.session.setActiveToolsByName(normalTools);
		await harness.session.reload();
		expect(harness.session.getActiveToolNames()).toEqual(goalTools);
		expect(harness.session.systemPrompt).toBe(goalPrompt);
		await harness.session.setGoalModeEnabled(false);
		expect(harness.session.getActiveToolNames()).toEqual(normalTools);
		expect(harness.session.systemPrompt).toBe(normalPrompt);
		await harness.session.setGoalModeEnabled(true);
		expect(harness.session.systemPrompt).toBe(goalPrompt);
		harness.session.setActiveToolsByName(["read"]);
		await harness.session.setGoalModeEnabled(false);
		expect(harness.session.getActiveToolNames()).not.toContain("update_plan");
	});

	it("keeps persisted plans intact while suppressing authoritative snapshots from goal-mode summaries", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [
				(extension) =>
					extension.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Implementation findings.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					})),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", { plan: [{ id: "keep", step: "Persisted checklist", status: "in_progress" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("First findings."),
			fauxAssistantMessage("Second findings."),
		]);
		await harness.session.prompt("Record the plan.");
		await harness.session.prompt("Continue.");
		const normalSummary = await harness.session.compact();
		expect(normalSummary.summary).toContain("Current task context (latest plan)");
		const plan = resolveCurrentPlanState(harness.sessionManager);
		await harness.session.setGoalModeEnabled(true);
		harness.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).not.toContain("Current task context (latest plan)");
				expect(context.systemPrompt).toContain("historical evidence");
				return fauxAssistantMessage("Goal findings.");
			},
		]);
		await harness.session.prompt("Continue in goal mode.");
		expect((await harness.session.compact()).summary).not.toContain("Current task context (latest plan)");
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual(plan);
		expect(normalSummary.summary).toContain("Persisted checklist");
	});

	it("restores the selected branch policy through navigation, fork, and resume", async () => {
		const original = await createHarness();
		harnesses.push(original);
		original.setResponses([fauxAssistantMessage("Normal branch.")]);
		await original.session.prompt("Start.");
		const normalLeaf = original.sessionManager.getLeafId()!;
		await original.session.setGoalModeEnabled(true);
		original.setResponses([fauxAssistantMessage("Goal branch.")]);
		await original.session.prompt("Continue.");
		const goalLeaf = original.sessionManager.getLeafId()!;
		const exported = original.session.exportToJsonl(join(original.tempDir, "goal.jsonl"));
		for (const manager of [SessionManager.open(exported), original.sessionManager.forkBranch(goalLeaf)]) {
			const restored = await createHarness({ sessionManager: manager });
			harnesses.push(restored);
			expect(restored.session.isGoalModeEnabled).toBe(true);
			restored.setResponses([
				(context) => {
					expect(context.tools?.map((tool) => tool.name)).not.toContain("update_plan");
					expect(context.systemPrompt).not.toContain("update_plan");
					return fauxAssistantMessage("Restored.");
				},
			]);
			await restored.session.prompt("Resume.");
			expect(restored.session.getLastAssistantText()).toBe("Restored.");
		}
		await original.session.navigateTree(normalLeaf);
		expect(original.session.isGoalModeEnabled).toBe(false);
		expect(original.session.getActiveToolNames()).toContain("update_plan");
		await original.session.navigateTree(goalLeaf);
		expect(original.session.isGoalModeEnabled).toBe(true);
		expect(original.session.getActiveToolNames()).not.toContain("update_plan");
		expect(original.session.systemPrompt).not.toContain("update_plan");
	});
});
