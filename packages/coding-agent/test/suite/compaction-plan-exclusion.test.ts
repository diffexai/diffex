import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
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
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens, reserveTokens: 1024 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: originalPlan }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: latestPlan }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Implementation evidence preserved. ".repeat(100)),
			fauxAssistantMessage("Ready."),
		]);
		await harness.session.prompt("Inspect the implementation.");
		await harness.session.prompt("Continue with the implementation. ".repeat(100));
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
		expect(result.summary).toContain(JSON.stringify({ plan: latestPlan }, null, 2));
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					message: expect.objectContaining({ role: "toolResult", toolName: "update_plan" }),
				}),
			]),
		);
	});
});
