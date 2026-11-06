import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { estimateContextTokens } from "../../src/core/compaction/compaction.ts";
import { goalNotes } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it.each([false, true])("reports usage every other complete batch (tool error: %s)", async (fails) => {
	const harness = await createHarness({
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Read evidence",
				parameters: Type.Object({}),
				async execute() {
					if (fails) throw new Error("probe failed");
					return { content: [{ type: "text", text: "evidence" }], details: {} };
				},
			},
		],
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	const requests: Context[] = [];
	harness.setResponses(
		Array.from({ length: 6 }, (_, index) => (context: Context) => {
			requests.push(structuredClone(context));
			return index === 5
				? fauxAssistantMessage("done")
				: fauxAssistantMessage(
						[
							fauxToolCall("probe", {}, { id: `first-${index}` }),
							fauxToolCall("probe", {}, { id: `second-${index}` }),
						],
						{ stopReason: "toolUse" },
					);
		}),
	);
	await harness.session.prompt("Investigate using five batches of probes.");
	expect(requests.map((context) => goalNotes(context).length)).toEqual([1, 2, 2, 3, 3, 4]);
	for (let index = 1; index < requests.length; index++) {
		expect(requests[index].messages.slice(0, requests[index - 1].messages.length)).toEqual(
			requests[index - 1].messages,
		);
		expect(getMessageText(requests[index].messages.at(-1))).toMatch(/\[context b\d+\]$/);
		const results = requests[index].messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(index * 2);
		for (const result of results) expect(getMessageText(result)).toMatch(/^\[context b\d+\]/);
	}
});

it.each([
	[59_000, 61_000, "Consider compacting completed work."],
	[74_000, 76_000, "Compact older work soon to preserve room."],
	[84_000, 86_000, "Compact older context now."],
] as const)("reports a pressure increase immediately from %i to %i tokens", async (before, after, guidance) => {
	let calls = 0;
	const harness = await createHarness({
		models: [{ id: "goal-model", contextWindow: 100_000 }],
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Read evidence",
				parameters: Type.Object({}),
				async execute() {
					const target = calls++ === 0 ? before : after;
					const current = estimateContextTokens(harness.session.messages).tokens;
					return { content: [{ type: "text", text: "x".repeat(Math.max(0, target - current) * 4) }], details: {} };
				},
			},
		],
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	const requests: Context[] = [];
	harness.setResponses(
		Array.from({ length: 4 }, (_, index) => (context: Context) => {
			requests.push(structuredClone(context));
			const response = fauxAssistantMessage(fauxToolCall("probe", {}, { id: `probe-${index}` }), {
				stopReason: "toolUse",
			});
			return index === 3 ? fauxAssistantMessage("done") : response;
		}),
	);
	await harness.session.prompt("Investigate while context pressure increases.");
	expect(requests.map((context) => goalNotes(context).length)).toEqual([1, 2, 3, 3]);
	expect(getMessageText(requests[2].messages.at(-1))).toContain(guidance);
});

it("keeps an omitted usage note stable through retries and refreshes for a new prompt", async () => {
	const harness = await createHarness({
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Read evidence",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "evidence" }], details: {} };
				},
			},
		],
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	const requests: Context[] = [];
	harness.setResponses(
		Array.from({ length: 6 }, (_, index) => (context: Context) => {
			requests.push(structuredClone(context));
			if (index === 2) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			return index >= 4
				? fauxAssistantMessage("done")
				: fauxAssistantMessage(fauxToolCall("probe", {}, { id: `probe-${index}` }), { stopReason: "toolUse" });
		}),
	);
	await harness.session.prompt("Inspect the evidence.");
	await harness.session.prompt("Continue the investigation.");
	expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
	expect(requests.map((context) => goalNotes(context).length)).toEqual([1, 2, 2, 2, 3, 4]);
	expect(getMessageText(requests[2].messages.at(-1))).toMatch(/^\[context b\d+\]$/);
	expect(requests[3].messages).toEqual(requests[2].messages);
	expect(getMessageText(requests[5].messages.at(-1))).toMatch(/^Context usage:/);
});
