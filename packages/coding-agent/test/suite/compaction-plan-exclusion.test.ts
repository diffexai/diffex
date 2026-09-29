import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionPreparation } from "../../src/core/compaction/compaction.ts";
import type { UpdatePlanItem } from "../../src/core/tools/update-plan.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const originalPlan: UpdatePlanItem[] = [{ id: "old-step", step: "PLAN_ONLY_ORIGINAL_STEP", status: "in_progress" }];
const latestPlan: UpdatePlanItem[] = [
	{
		id: "latest-step",
		step: "PLAN_ONLY_LATEST_STEP",
		status: "in_progress",
		success_criteria: ["PLAN_ONLY_SUCCESS_CRITERION"],
	},
];

describe("Compaction plan exclusion", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each([1, 100])("excludes plan tool history with keepRecentTokens=%i", async (keepRecentTokens) => {
		const preparations: CompactionPreparation[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens, reserveTokens: 1024 } },
			extensionFactories: [
				(diffex) =>
					diffex.on("session_before_compact", (event) => {
						preparations.push(event.preparation);
					}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: "Implementation evidence preserved." },
					fauxToolCall("update_plan", { plan: originalPlan }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: latestPlan }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Implementation evidence preserved. ".repeat(100)),
			fauxAssistantMessage("Ready."),
		]);
		await harness.session.prompt("Inspect the implementation.");
		if (keepRecentTokens === 100) await harness.session.prompt("Continue with the implementation. ".repeat(100));
		const requests: string[] = [];
		harness.setResponses(
			Array.from({ length: 2 }, () => (context) => {
				requests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("Compacted implementation evidence.");
			}),
		);

		const result = await harness.session.compact();

		expect(requests.length).toBeGreaterThan(0);
		const summarizedContext = requests.join("\n");
		expect(summarizedContext).toContain("Implementation evidence preserved.");
		expect(summarizedContext).not.toContain("PLAN_ONLY_");
		expect(summarizedContext).not.toContain("update_plan");
		expect(preparations).toHaveLength(1);
		expect(JSON.stringify(preparations)).not.toContain("PLAN_ONLY_");
		expect(JSON.stringify(preparations)).not.toContain("update_plan");
		expect(result.summary).toContain(JSON.stringify({ plan: latestPlan }, null, 2));
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.objectContaining({ role: "toolResult", toolName: "update_plan" }),
				}),
			]),
		);
	});

	it.each([
		{ mode: "manual", state: "active" },
		{ mode: "auto", state: "active" },
		{ mode: "manual", state: "completed" },
		{ mode: "auto", state: "completed" },
		{ mode: "manual", state: "cleared" },
		{ mode: "auto", state: "cleared" },
	])(
		"excludes the attached snapshot on the next $mode compaction with a $state plan after resume",
		async ({ mode, state }) => {
			const settings = { compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 1024 } };
			const harness = await createHarness({ settings });
			harnesses.push(harness);
			const compactSession = async (activeHarness: Harness) => {
				if (mode === "manual") await activeHarness.session.compact();
				else {
					const session = activeHarness.session as unknown as {
						_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
					};
					await session._runAutoCompaction("threshold", false);
					expect(activeHarness.eventsOfType("compaction_end").at(-1)?.result).toBeDefined();
				}
			};
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("update_plan", { plan: originalPlan }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Initial findings."),
				fauxAssistantMessage("Ready."),
				fauxAssistantMessage("Narrative checkpoint."),
			]);
			await harness.session.prompt("Inspect the implementation.");
			await harness.session.prompt("Continue with the implementation. ".repeat(100));
			await compactSession(harness);
			const firstCompaction = harness.sessionManager.getLeafEntry();
			expect(firstCompaction?.type).toBe("compaction");
			if (firstCompaction?.type !== "compaction") throw new Error("Missing first compaction");
			expect(firstCompaction.summary).toContain("PLAN_ONLY_ORIGINAL_STEP");

			const resumed = await createHarness({ settings, sessionManager: harness.sessionManager });
			harnesses.push(resumed);
			const finalPlan =
				state === "cleared"
					? []
					: latestPlan.map((item) => ({
							...item,
							status: state === "completed" ? "completed" : item.status,
						}));
			resumed.setResponses([
				fauxAssistantMessage(
					fauxToolCall("update_plan", state === "cleared" ? { clear: true } : { plan: finalPlan }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("New implementation evidence."),
				fauxAssistantMessage("Ready again."),
			]);
			await resumed.session.prompt("Implement the change.");
			await resumed.session.prompt("Continue with verification. ".repeat(100));
			const requests: string[] = [];
			resumed.setResponses([
				(context) => {
					requests.push(context.messages.map(getMessageText).join("\n"));
					return fauxAssistantMessage("Updated narrative checkpoint.");
				},
			]);
			await compactSession(resumed);

			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("<previous-summary>\nNarrative checkpoint.\n</previous-summary>");
			expect(requests[0]).toContain("New implementation evidence.");
			expect(requests[0]).not.toContain("PLAN_ONLY_");
			expect(requests[0]).not.toContain("Current task context (latest plan)");
			for (const heading of [
				"Goal",
				"Constraints & Preferences",
				"Progress",
				"Key Decisions",
				"Next Steps",
				"Critical Context",
			]) {
				expect(requests[0]).toContain(`## ${heading}`);
			}
			const lastCompaction = resumed.sessionManager.getLeafEntry();
			expect(lastCompaction?.type).toBe("compaction");
			if (lastCompaction?.type !== "compaction") throw new Error("Missing second compaction");
			expect(lastCompaction.summary).toContain(JSON.stringify({ plan: finalPlan }, null, 2));
			expect(lastCompaction.summary).not.toContain("PLAN_ONLY_ORIGINAL_STEP");
			expect(firstCompaction.summary).toContain("PLAN_ONLY_ORIGINAL_STEP");
		},
	);
});
