import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCurrentPlanState } from "../../src/core/current-plan-state.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

describe("AgentSession tool scheduling", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.cleanup();
	});

	it("overlaps independent calls on both sides of a persisted update_plan barrier", async () => {
		const ids = ["read-a", "read-b", "read-c", "read-d"];
		const gates = new Map(ids.map((id) => [id, deferred<void>()]));
		const started = new Map(ids.map((id) => [id, deferred<void>()]));
		const completed = new Map(ids.map((id) => [id, deferred<void>()]));
		const executionOrder: string[] = [];
		const preflightOrder: string[] = [];
		const plan = [{ id: "inspect", step: "Inspect the files", status: "in_progress" }];
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "controlled_read",
						label: "Controlled read",
						description: "Read a fixture through a controlled gate",
						parameters: Type.Object({}),
						executionMode: "parallel",
						async execute(id) {
							executionOrder.push(id);
							started.get(id)?.resolve();
							await gates.get(id)?.promise;
							return { content: [{ type: "text", text: id }], details: {} };
						},
					});
					pi.on("tool_call", async (event) => {
						preflightOrder.push(event.toolCallId);
					});
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end") completed.get(event.toolCallId)?.resolve();
		});
		const calls = ids.map((id) => fauxToolCall("controlled_read", {}, { id }));
		calls.splice(2, 0, fauxToolCall("update_plan", { plan }, { id: "plan" }));
		harness.setResponses([
			fauxAssistantMessage(calls, { stopReason: "toolUse" }),
			(context) => {
				expect(
					context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
				).toEqual(["read-a", "read-b", "plan", "read-c", "read-d"]);
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = harness.session.prompt("Read two files, publish the plan, then read two more files.");
		try {
			await started.get("read-a")?.promise;
			await setImmediate();
			expect(executionOrder).toEqual(["read-a", "read-b"]);
			expect(preflightOrder).toEqual(["read-a", "read-b"]);
			gates.get("read-b")?.resolve();
			await completed.get("read-b")?.promise;
			expect(preflightOrder).not.toContain("plan");
			gates.get("read-a")?.resolve();
			await started.get("read-c")?.promise;
			await setImmediate();
			expect(executionOrder).toEqual(ids);
			expect(resolveCurrentPlanState(harness.sessionManager)).toEqual({ status: "active", operation: { plan } });
			gates.get("read-d")?.resolve();
			await completed.get("read-d")?.promise;
			gates.get("read-c")?.resolve();
		} finally {
			for (const gate of gates.values()) gate.resolve();
			await prompt;
		}
		expect(harness.eventsOfType("tool_execution_end").map((event) => event.toolCallId)).toEqual([
			"read-b",
			"read-a",
			"plan",
			"read-d",
			"read-c",
		]);
		expect(
			harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
				),
		).toEqual(["read-a", "read-b", "plan", "read-c", "read-d"]);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
