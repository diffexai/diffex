import { fauxAssistantMessage, fauxToolCall, type Message } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCurrentPlanState } from "../../../src/core/current-plan-state.ts";
import type { UpdatePlanItem } from "../../../src/core/tools/update-plan.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const originalPlan: UpdatePlanItem[] = [
	{
		id: "implement",
		step: "Implement original approach",
		status: "in_progress",
		success_criteria: ["Original checks pass"],
	},
	{ id: "verify", step: "Verify original approach", status: "pending" },
];
const abandonedPlan: UpdatePlanItem[] = [
	{
		id: "replacement",
		step: "Implement abandoned approach",
		status: "in_progress",
		success_criteria: ["Abandoned checks pass"],
	},
];
const explorationSummary = `Explored a later branch with this plan:\n${JSON.stringify({ plan: abandonedPlan }, null, 2)}`;

function expectedSnapshot(plan: readonly UpdatePlanItem[]): string {
	return `Current task context (latest plan):\n${JSON.stringify({ plan }, null, 2)}`;
}

async function writePlan(harness: Harness, plan: UpdatePlanItem[]): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("update_plan", { plan }), { stopReason: "toolUse" }),
		fauxAssistantMessage("plan saved"),
	]);
	await harness.session.prompt("set the plan");
	const leafId = harness.sessionManager.getLeafId();
	if (!leafId) throw new Error("Missing plan session leaf");
	return leafId;
}

async function captureRequest(harness: Harness, prompt: string): Promise<Message[]> {
	const requests: Message[][] = [];
	harness.setResponses([
		(context) => {
			requests.push(context.messages);
			return fauxAssistantMessage("continued");
		},
	]);
	await harness.session.prompt(prompt);
	expect(requests).toHaveLength(1);
	return requests[0];
}

describe("PR 249 tree plan context", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each([
		["extension", "assistant"],
		["model", "assistant"],
		["extension", "user"],
		["model", "user"],
	] as const)("makes the selected plan authoritative with a %s summary at a %s target", async (source, targetKind) => {
		const harness = await createHarness({
			extensionFactories:
				source === "extension"
					? [
							(diffex) =>
								diffex.on("session_before_tree", () => ({
									summary: { summary: explorationSummary },
								})),
						]
					: undefined,
		});
		harnesses.push(harness);
		const originalLeafId = await writePlan(harness, originalPlan);
		await writePlan(harness, abandonedPlan);
		const userTarget = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.at(-1);
		const targetId = targetKind === "user" ? userTarget?.id : originalLeafId;
		if (!targetId) throw new Error("Missing navigation target");
		if (source === "model") harness.setResponses([fauxAssistantMessage(explorationSummary)]);

		const navigation = await harness.session.navigateTree(targetId, { summarize: true });
		expect(navigation.cancelled).toBe(false);
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual({
			status: "active",
			operation: { plan: originalPlan },
		});
		const requests: Message[][] = [];
		harness.setResponses(
			[1, 2].map(() => (context: { messages: Message[] }) => {
				requests.push(context.messages);
				return fauxAssistantMessage("continued");
			}),
		);
		await harness.session.prompt("continue selected branch");
		await harness.session.prompt("continue again");

		const summaryText = requests[0].map(getMessageText).find((text) => text.includes(explorationSummary));
		expect(summaryText).toContain("The plan below is authoritative for the selected conversation branch.");
		expect(summaryText).toContain(expectedSnapshot(originalPlan));
		expect(summaryText?.lastIndexOf(expectedSnapshot(originalPlan))).toBeGreaterThan(
			summaryText?.indexOf(explorationSummary) ?? -1,
		);
		expect(navigation.summaryEntry?.summary.endsWith(expectedSnapshot(originalPlan))).toBe(true);
		expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);

		const summaryId = navigation.summaryEntry?.id;
		if (!summaryId) throw new Error("Missing persisted branch summary");
		for (const sessionManager of [harness.sessionManager, harness.sessionManager.forkBranch(summaryId)]) {
			const restored = await createHarness({ sessionManager });
			harnesses.push(restored);
			restored.session.agent.state.messages = sessionManager.buildSessionContext().messages;
			const messages = await captureRequest(restored, "continue restored branch");
			const summary = messages.map(getMessageText).find((text) => text.includes(explorationSummary));
			expect(summary).toContain(expectedSnapshot(originalPlan));
		}
	});

	it.each(["absent", "cleared", "completed"] as const)("restores a %s destination plan", async (state) => {
		const harness = await createHarness({
			extensionFactories: [
				(diffex) => diffex.on("session_before_tree", () => ({ summary: { summary: explorationSummary } })),
			],
		});
		harnesses.push(harness);
		const selectedPlan =
			state === "completed" ? originalPlan.map((item) => ({ ...item, status: "completed" as const })) : originalPlan;
		let targetId = await writePlan(harness, selectedPlan);
		if (state === "absent") {
			const firstUser = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!firstUser) throw new Error("Missing root user message");
			targetId = firstUser.id;
		} else if (state === "cleared") {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("update_plan", { clear: true }), { stopReason: "toolUse" }),
				fauxAssistantMessage("plan cleared"),
			]);
			await harness.session.prompt("clear the plan");
			const leafId = harness.sessionManager.getLeafId();
			if (!leafId) throw new Error("Missing cleared plan leaf");
			targetId = leafId;
		}
		await writePlan(harness, abandonedPlan);
		const result = await harness.session.navigateTree(targetId, { summarize: true });
		const expectedPlan = state === "completed" ? selectedPlan : [];
		expect(result.summaryEntry?.summary.endsWith(expectedSnapshot(expectedPlan))).toBe(true);
		const messages = await captureRequest(harness, "continue destination");
		const summary = messages.map(getMessageText).find((text) => text.includes(explorationSummary));
		expect(summary).toContain(expectedSnapshot(expectedPlan));
	});

	it("restores the selected history without adding a summary when summarization is disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const targetId = await writePlan(harness, originalPlan);
		await writePlan(harness, abandonedPlan);
		const result = await harness.session.navigateTree(targetId, { summarize: false });
		expect(result.summaryEntry).toBeUndefined();
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual({
			status: "active",
			operation: { plan: originalPlan },
		});
		const messages = await captureRequest(harness, "continue without summary");
		const history = messages.map(getMessageText).join("\n");
		expect(history).toContain(JSON.stringify({ plan: originalPlan }, null, 2));
		expect(history).not.toContain("Implement abandoned approach");
	});

	it("persists nothing when summarized tree navigation is cancelled", async () => {
		const harness = await createHarness({
			extensionFactories: [(diffex) => diffex.on("session_before_tree", () => ({ cancel: true }))],
		});
		harnesses.push(harness);
		const targetId = await writePlan(harness, originalPlan);
		await writePlan(harness, abandonedPlan);
		const entriesBefore = structuredClone(harness.sessionManager.getEntries());
		const leafBefore = harness.sessionManager.getLeafId();
		const messagesBefore = structuredClone(harness.session.messages);
		const result = await harness.session.navigateTree(targetId, { summarize: true });
		expect(result).toEqual({ cancelled: true });
		expect(harness.sessionManager.getLeafId()).toBe(leafBefore);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(harness.session.messages).toEqual(messagesBefore);
	});
});
