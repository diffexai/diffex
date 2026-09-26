import { fauxAssistantMessage, fauxToolCall, type Message } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("PR 249 plan prompt cache prefix", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
	});

	it("extends the prior request after plan creation", async () => {
		harness = await createHarness();
		const requests: Message[][] = [];
		const capture = (context: { messages: Message[] }) => {
			requests.push(context.messages);
			return fauxAssistantMessage("done");
		};
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", {
					plan: [{ id: "work", step: "Do the work", status: "in_progress" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("plan created"),
			capture,
			capture,
			capture,
		]);

		await harness.session.prompt("create a plan");
		await harness.session.prompt("ordinary request one");
		await harness.session.prompt("ordinary request two");
		await harness.session.prompt("ordinary request three");

		expect(requests).toHaveLength(3);
		for (let index = 1; index < requests.length; index++) {
			const previous = requests[index - 1].map(getMessageText);
			const current = requests[index].map(getMessageText);
			expect(current.slice(0, previous.length)).toEqual(previous);
		}
	});

	it("keeps reusable prefixes after step updates, reordering, and clearing", async () => {
		harness = await createHarness();
		const firstPlan = [
			{ id: "work", step: "Do the work", status: "in_progress" as const, success_criteria: ["Works"] },
			{ id: "verify", step: "Verify the work", status: "pending" as const },
		];
		const updatedPlan = [
			{ ...firstPlan[0], step: "Do the work carefully", success_criteria: ["Works", "Persists"] },
			firstPlan[1],
		];
		const reorderedPlan = [
			{ id: "verify", step: "Verify the work", status: "in_progress" as const, success_criteria: ["Tests pass"] },
			{ ...updatedPlan[0], status: "completed" as const },
		];
		const submitTool = async (input: object, prompt: string) => {
			harness?.setResponses([
				fauxAssistantMessage(fauxToolCall("update_plan", input), { stopReason: "toolUse" }),
				fauxAssistantMessage("continued"),
			]);
			await harness?.session.prompt(prompt);
		};
		const checkOrdinaryPrefix = async (label: string, expectedResult: string) => {
			const requests: Message[][] = [];
			harness?.setResponses(
				[1, 2].map(() => (context: { messages: Message[] }) => {
					requests.push(context.messages);
					return fauxAssistantMessage("done");
				}),
			);
			await harness?.session.prompt(`${label} one`);
			await harness?.session.prompt(`${label} two`);
			expect(requests[0]?.map(getMessageText)).toContain(expectedResult);
			expect(requests[1]?.slice(0, requests[0]?.length).map(getMessageText)).toEqual(
				requests[0]?.map(getMessageText),
			);
		};

		await submitTool({ plan: firstPlan }, "create plan");
		await checkOrdinaryPrefix(
			"created",
			`Plan updated: 0 completed, 1 in progress, 1 pending.\n${JSON.stringify({ plan: firstPlan }, null, 2)}`,
		);
		await submitTool(
			{ update: { id: "work", step: "Do the work carefully", success_criteria: ["Works", "Persists"] } },
			"update step",
		);
		await checkOrdinaryPrefix(
			"updated",
			`Plan updated: 0 completed, 1 in progress, 1 pending.\n${JSON.stringify({ plan: updatedPlan }, null, 2)}`,
		);
		await submitTool({ plan: reorderedPlan }, "reorder plan");
		await checkOrdinaryPrefix(
			"reordered",
			`Plan updated: 1 completed, 1 in progress, 0 pending.\n${JSON.stringify({ plan: reorderedPlan }, null, 2)}`,
		);
		await submitTool({ clear: true }, "clear plan");
		await checkOrdinaryPrefix("cleared", "Plan cleared.");
	});
});
