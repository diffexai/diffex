import { fauxAssistantMessage, fauxToolCall, type Message } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { appendCurrentPlanRecord, CURRENT_PLAN_CUSTOM_ENTRY_TYPE } from "../../src/core/current-plan-state.ts";
import type { UpdatePlanItem } from "../../src/core/tools/update-plan.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const plan: UpdatePlanItem[] = [
	{ id: "inspect", step: "Inspect state", status: "completed" },
	{ id: "implement", step: "Implement change", status: "in_progress", success_criteria: ["Resume retains the plan"] },
];

function planSnapshot(items: readonly UpdatePlanItem[]): string {
	return `Current task context (latest plan):\n${JSON.stringify({ plan: items }, null, 2)}`;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("response to compact", { timestamp: now - 500 }),
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession durable plan restoration", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("retains the complete tool result on resume and fork while preserving extension context transforms", async () => {
		const original = await createHarness();
		harnesses.push(original);
		original.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { plan }), { stopReason: "toolUse" }),
			fauxAssistantMessage("created"),
		]);
		await original.session.prompt("create plan");

		const leaf = original.sessionManager.getLeafEntry();
		if (!leaf) throw new Error("Missing session leaf");
		for (const sessionManager of [original.sessionManager, original.sessionManager.forkBranch(leaf.id)]) {
			const restored = await createHarness({
				sessionManager,
				extensionFactories: [
					(diffex) =>
						diffex.on("context", (event) => ({
							messages: [
								...event.messages,
								{
									role: "custom",
									customType: "test.extension-context",
									content: "extension context",
									display: false,
									timestamp: Date.now(),
								},
							],
						})),
				],
			});
			harnesses.push(restored);
			restored.session.agent.state.messages = sessionManager.buildSessionContext().messages;
			const requests: Message[][] = [];
			restored.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("resumed");
				},
			]);
			await restored.session.prompt("continue");
			expect(requests[0]?.map(getMessageText)).toContain("extension context");
			expect(requests[0]?.map(getMessageText)).toContain(
				`Plan updated: 1 completed, 1 in progress, 0 pending.\n${JSON.stringify({ plan }, null, 2)}`,
			);
			expect(requests[0]?.map(getMessageText).some((text) => text.startsWith("Current task context"))).toBe(false);
		}
	});

	it("persists the latest plan in manual and automatic compaction summaries", async () => {
		for (const mode of ["manual", "auto"] as const) {
			const harness = await createHarness({
				extensionFactories: [
					(diffex) =>
						diffex.on("session_before_compact", (event) => ({
							compaction: {
								summary: `${mode} summary`,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						})),
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			appendCurrentPlanRecord(harness.sessionManager, { plan });

			if (mode === "manual") await harness.session.compact();
			else
				await (
					harness.session as unknown as {
						_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
					}
				)._runAutoCompaction("threshold", false);

			const entry = harness.sessionManager.getLeafEntry();
			expect(entry?.type).toBe("compaction");
			if (entry?.type !== "compaction") continue;
			expect(entry.summary).toBe(`${mode} summary\n\n${planSnapshot(plan)}`);
			const summaryMessage = harness.sessionManager.buildSessionContext().messages[0];
			expect(summaryMessage?.role).toBe("compactionSummary");
			if (summaryMessage?.role === "compactionSummary") expect(summaryMessage.summary).toContain(planSnapshot(plan));
			const fork = harness.sessionManager.forkBranch(entry.id);
			const forkSummary = fork.buildSessionContext().messages[0];
			expect(forkSummary?.role).toBe("compactionSummary");
			if (forkSummary?.role === "compactionSummary") expect(forkSummary.summary).toContain(planSnapshot(plan));
			for (const sessionManager of [harness.sessionManager, fork]) {
				const resumed = await createHarness({ sessionManager });
				harnesses.push(resumed);
				resumed.session.agent.state.messages = sessionManager.buildSessionContext().messages;
				resumed.setResponses([
					(context) => {
						expect(context.messages.map(getMessageText).join("\n")).toContain(planSnapshot(plan));
						return fauxAssistantMessage("continued");
					},
				]);
				await resumed.session.prompt("continue after compaction");
			}
		}
	});

	it("records an empty plan after clearing or when no valid plan exists", async () => {
		for (const state of ["cleared", "absent", "corrupt"] as const) {
			const harness = await createHarness({
				extensionFactories: [
					(diffex) =>
						diffex.on("session_before_compact", (event) => ({
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						})),
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			if (state === "cleared") {
				appendCurrentPlanRecord(harness.sessionManager, { plan });
				appendCurrentPlanRecord(harness.sessionManager, { clear: true });
			} else if (state === "corrupt") {
				appendCurrentPlanRecord(harness.sessionManager, { plan });
				harness.sessionManager.appendCustomEntry(CURRENT_PLAN_CUSTOM_ENTRY_TYPE, { plan: [] });
			}
			const result = await harness.session.compact();
			expect(result.summary).toBe(`summary\n\n${planSnapshot([])}`);
		}
	});

	it("persists nothing when compaction is cancelled", async () => {
		const harness = await createHarness({
			extensionFactories: [(diffex) => diffex.on("session_before_compact", () => ({ cancel: true }))],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		appendCurrentPlanRecord(harness.sessionManager, { plan });
		const entriesBefore = harness.sessionManager.getEntries();
		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
