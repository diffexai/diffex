import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { goalControls, goalNotes } from "./goal-harness.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("goal runtime note stability", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it("adds one note for a batch spanning parallel phases and a sequential plan barrier", async () => {
		const executionOrder: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(extension) => {
					extension.registerTool({
						name: "probe",
						label: "Probe",
						description: "Record the call order",
						parameters: Type.Object({}),
						executionMode: "parallel",
						async execute(id) {
							executionOrder.push(id);
							return { content: [{ type: "text", text: id }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(
					[
						fauxToolCall("probe", {}, { id: "before" }),
						fauxToolCall(
							"update_plan",
							{ plan: [{ id: "inspect", step: "Inspect", status: "in_progress" }] },
							{ id: "plan" },
						),
						fauxToolCall("probe", {}, { id: "after" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Inspect, publish the plan, and inspect again.");
		expect(executionOrder).toEqual(["before", "after"]);
		expect(requests).toHaveLength(2);
		expect(
			requests[1].messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
		).toEqual(["before", "plan", "after"]);
		expect(goalNotes(requests[0])).toHaveLength(1);
		expect(goalNotes(requests[1])).toHaveLength(2);
		expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
	});

	it("does not add or rewrite notes when the next provider request is retried", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Read a test result",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "result" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe" }), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("recovered");
			},
		]);
		await harness.session.prompt("Read the test result.");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(requests).toHaveLength(3);
		expect(requests.map((context) => goalNotes(context).length)).toEqual([1, 2, 2]);
		expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
		expect(requests[2].messages.slice(0, requests[1].messages.length)).toEqual(requests[1].messages);
		expect(goalNotes(requests[2])).toEqual(goalNotes(requests[1]));
	});
});
