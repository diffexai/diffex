import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdatePlanItem } from "../../../src/core/tools/update-plan.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const oldPlan: UpdatePlanItem[] = [{ id: "old", step: "PLAN_ONLY_OLD", status: "in_progress" }];
const latestPlan: UpdatePlanItem[] = [
	{ id: "latest", step: "PLAN_ONLY_LATEST", status: "in_progress", success_criteria: ["PLAN_ONLY_CRITERIA"] },
];

describe("PR 251 plan context duplication", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each(["manual", "auto"] as const)("removes superseded plan messages from the retained %s tail", async (mode) => {
		const settings = { compaction: { enabled: false, keepRecentTokens: 1000, reserveTokens: 1024 } };
		const harness = await createHarness({ settings });
		harnesses.push(harness);
		const path = join(harness.tempDir, "evidence.txt");
		writeFileSync(path, "Retained file evidence.");
		harness.setResponses([
			fauxAssistantMessage("Older implementation evidence. ".repeat(1000)),
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: oldPlan }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					{ type: "text", text: "Retained assistant evidence." },
					fauxToolCall("update_plan", { plan: latestPlan }),
					fauxToolCall("read", { path }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Ready."),
		]);
		await harness.session.prompt("Inspect the implementation.");
		await harness.session.prompt("Update the plan and read the evidence.");
		harness.setResponses([fauxAssistantMessage("Compacted narrative."), fauxAssistantMessage("Turn narrative.")]);
		if (mode === "manual") await harness.session.compact();
		else {
			const session = harness.session as unknown as {
				_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
			};
			await session._runAutoCompaction("threshold", false);
			expect(harness.eventsOfType("compaction_end").at(-1)?.result).toBeDefined();
		}
		// Verify the raw retained tail still contains plan history, without deleting persisted entries.
		expect(JSON.stringify(harness.sessionManager.buildContextEntries())).toContain('"toolName":"update_plan"');
		const persisted = structuredClone(harness.sessionManager.getEntries());
		const resumed = await createHarness({ settings, sessionManager: harness.sessionManager });
		harnesses.push(resumed);
		resumed.session.agent.state.messages = resumed.sessionManager.buildSessionContext().messages;
		for (const activeHarness of [harness, resumed]) {
			const requests: Message[][] = [];
			activeHarness.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("Continued.");
				},
			]);
			await activeHarness.session.prompt("Continue after compaction.");
			const context = JSON.stringify(requests[0]);
			expect(context).not.toContain("update_plan");
			expect(context).not.toContain("PLAN_ONLY_OLD");
			expect(context.match(/PLAN_ONLY_LATEST/g)).toHaveLength(1);
			expect(context).toContain("Retained assistant evidence.");
			expect(context).toContain("Retained file evidence.");
			expect(requests[0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "toolResult", toolName: "read" }),
					expect.objectContaining({
						role: "assistant",
						content: expect.arrayContaining([expect.objectContaining({ name: "read" })]),
					}),
				]),
			);
		}
		expect(harness.sessionManager.getEntries().slice(0, persisted.length)).toEqual(persisted);
		// Updates made after the snapshot must still reach the next agent request, including after replay.
		resumed.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: oldPlan }), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("update_plan");
				expect(JSON.stringify(context.messages)).toContain("PLAN_ONLY_OLD");
				return fauxAssistantMessage("Plan updated.");
			},
		]);
		await resumed.session.prompt("Revise the plan.");
		expect(JSON.stringify(resumed.sessionManager.buildSessionContext().messages)).toContain(
			'"toolName":"update_plan"',
		);
	});

	it("excludes prior compaction and branch snapshots from repeated tree summarization", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 1024 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Root implementation evidence."),
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: oldPlan }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Later implementation evidence. ".repeat(1000)),
			fauxAssistantMessage("Ready."),
			fauxAssistantMessage("Compaction narrative."),
		]);
		await harness.session.prompt("Start work.");
		const targetId = harness.sessionManager.getLeafId();
		if (!targetId) throw new Error("Missing root target");
		await harness.session.prompt("Plan the later work.");
		await harness.session.prompt("Keep this recent context. ".repeat(100));
		await harness.session.compact();
		const compaction = harness.sessionManager.getLeafEntry();
		if (compaction?.type !== "compaction") throw new Error("Missing compaction entry");
		const persistedCompaction = structuredClone(compaction);
		const requests: string[] = [];
		for (const narrative of ["First exploration narrative.", "Second exploration narrative."]) {
			harness.setResponses([
				(context) => {
					requests.push(context.messages.map(getMessageText).join("\n"));
					return fauxAssistantMessage(narrative);
				},
			]);
			const destination = requests.length === 0 ? targetId : compaction.id;
			const result = await harness.session.navigateTree(destination, { summarize: true });
			expect(result.summaryEntry?.summary).toContain(
				JSON.stringify({ plan: destination === targetId ? [] : oldPlan }, null, 2),
			);
		}
		expect(requests).toHaveLength(2);
		expect(requests[0]).toContain("Compaction narrative.");
		expect(requests[1]).toContain("First exploration narrative.");
		for (const request of requests) {
			expect(request).not.toContain("PLAN_ONLY_");
			expect(request).not.toContain("update_plan");
			expect(request).not.toContain("Current task context (latest plan)");
			expect(request).not.toContain("The plan below is authoritative");
		}
		// The new branch snapshot supersedes the selected compaction's snapshot too.
		harness.setResponses([
			(context) => {
				const text = JSON.stringify(context.messages);
				expect(text.match(/Current task context \(latest plan\)/g)).toHaveLength(1);
				expect(text.match(/PLAN_ONLY_OLD/g)).toHaveLength(1);
				expect(text).not.toContain("update_plan");
				expect(text).toContain("Compaction narrative.");
				expect(text).toContain("Second exploration narrative.");
				return fauxAssistantMessage("Continued selected branch.");
			},
		]);
		await harness.session.prompt("Continue the selected branch.");
		expect(harness.sessionManager.getEntry(compaction.id)).toEqual(persistedCompaction);
		// The branch attachment must also be excluded from the next compaction request.
		harness.setResponses([fauxAssistantMessage("New recent context.")]);
		await harness.session.prompt("Keep the new recent context. ".repeat(200));
		const compactionRequests: string[] = [];
		harness.setResponses(
			Array.from({ length: 2 }, () => (context) => {
				compactionRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("Updated compaction narrative.");
			}),
		);
		await harness.session.compact();
		expect(compactionRequests.length).toBeGreaterThan(0);
		const summarized = compactionRequests.join("\n");
		expect(summarized).toContain("Second exploration narrative.");
		expect(summarized).not.toContain("PLAN_ONLY_");
		expect(summarized).not.toContain("Current task context (latest plan)");
		expect(summarized).not.toContain("The plan below is authoritative");
		expect(JSON.stringify(harness.session.messages).match(/Current task context \(latest plan\)/g)).toHaveLength(1);
	});
});
