import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

describe("compaction between tool batches", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.cleanup();
	});

	it.each(["tool output", "model usage"])(
		"compacts %s before the next request and continues the same run",
		async (source) => {
			harness = await createHarness({
				models: [{ id: "small", contextWindow: 4000 }],
				settings: { compaction: { keepRecentTokens: 1, reserveTokens: 500 } },
				tools: [
					{
						name: "large",
						label: "Large",
						description: "Large result",
						parameters: Type.Object({}),
						execute: async () => ({
							content: [{ type: "text", text: source === "tool output" ? "x".repeat(16000) : "ok" }],
							details: {},
						}),
					},
				],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction: {
								summary: "completed tool batch",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			const toolCall = fauxToolCall("large", {});
			const response = fauxAssistantMessage(toolCall, { stopReason: "toolUse" });
			harness.setResponses([
				response,
				(context) => {
					expect(harness?.eventsOfType("compaction_end")).toHaveLength(1);
					expect(
						context.messages.some((message) => JSON.stringify(message).includes("completed tool batch")),
					).toBe(true);
					expect(context.messages).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ role: "assistant", content: expect.arrayContaining([toolCall]) }),
							expect.objectContaining({ role: "toolResult", toolCallId: toolCall.id }),
						]),
					);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt(
				source === "model usage" ? "Implement this change. ".repeat(1000) : "Implement the change and verify it.",
			);
			expect(harness.session.getLastAssistantText()).toBe("done");
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		},
	);

	it("cancels compaction with its run and does not make another model request", async () => {
		const started = deferred<void>();
		const aborted = deferred<void>();
		harness = await createHarness({
			models: [{ id: "small", contextWindow: 4000 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 500 } },
			tools: [
				{
					name: "large",
					label: "Large",
					description: "Large result",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "x".repeat(16000) }], details: {} }),
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						event.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
						started.resolve();
						await aborted.promise;
						return { cancel: true };
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" })]);
		const prompt = harness.session.prompt("Implement the change.");
		await started.promise;
		await harness.session.abort();
		await prompt;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ aborted: true })]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
