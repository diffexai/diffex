import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PLAN_CUSTOM_ENTRY_TYPE, resolveCurrentPlanState } from "../../src/core/current-plan-state.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createUpdatePlanToolDefinition,
	updatePlanToolSystemPromptContribution,
} from "../../src/core/tools/update-plan.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession update_plan tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function getCurrentPlanEntries(harness: Harness): CustomEntry<unknown>[] {
		return harness.sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry<unknown> =>
					entry.type === "custom" && entry.customType === CURRENT_PLAN_CUSTOM_ENTRY_TYPE,
			);
	}

	it("enables update_plan by default and includes active-only prompt guidance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).toContain("update_plan");
		expect(harness.session.systemPrompt).toContain("- update_plan: track progress with an ordered task checklist");
		for (const guideline of updatePlanToolSystemPromptContribution.guidelines) {
			expect(harness.session.systemPrompt).toContain(`- ${guideline}`);
		}

		harness.session.setActiveToolsByName(["read", "bash", "edit", "write"]);

		expect(harness.session.getActiveToolNames()).not.toContain("update_plan");
		expect(harness.session.systemPrompt).not.toContain("update_plan");
		expect(harness.session.systemPrompt).not.toContain("task checklist");
		for (const guideline of updatePlanToolSystemPromptContribution.guidelines) {
			expect(harness.session.systemPrompt).not.toContain(guideline);
		}
	});

	it("handles update_plan tool calls in the faux-provider loop", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const plan = [
			{ step: "Read the code", status: "completed" },
			{ step: "  Implement update_plan  ", status: "in_progress" },
			{ step: "Run checks", status: "pending" },
		] as Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { plan, explanation: "  exact explanation  " }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("continuing after plan"),
		]);

		await harness.session.prompt("start complex work");

		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role !== "toolResult") return;
		expect(toolResult.toolName).toBe("update_plan");
		expect(getMessageText(toolResult)).toBe("Plan updated: 1 completed, 1 in progress, 1 pending.");
		expect(toolResult.details).toEqual({ plan, explanation: "  exact explanation  " });
		expect(getMessageText(harness.session.messages[3])).toBe("continuing after plan");

		const entries = getCurrentPlanEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0].data).toEqual({ plan, explanation: "  exact explanation  " });

		plan[1].step = "mutated input";
		if (toolResult.details && typeof toolResult.details === "object" && "plan" in toolResult.details) {
			const detailsPlan = toolResult.details.plan;
			if (Array.isArray(detailsPlan) && detailsPlan[1] && typeof detailsPlan[1] === "object") {
				(detailsPlan[1] as { step: string }).step = "mutated details";
			}
		}
		expect(entries[0].data).toMatchObject({
			plan: [{ step: "Read the code" }, { step: "  Implement update_plan  " }, { step: "Run checks" }],
			explanation: "  exact explanation  ",
		});
	});

	it("executes batched update_plan operations sequentially in source order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"update_plan",
						{
							plan: [{ step: "Implement the change", status: "in_progress" }],
							explanation: "initial explanation",
						},
						{ id: "plan-update" },
					),
					fauxToolCall(
						"update_plan",
						{ plan: [{ step: "Replacement", status: "in_progress" }] },
						{ id: "plan-replacement" },
					),
					fauxToolCall("update_plan", { clear: true }, { id: "plan-clear" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("plan and then abandon the work");

		const executionOrder = harness.events.flatMap((event) => {
			if (
				(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
				event.toolName === "update_plan"
			) {
				return `${event.type}:${event.toolCallId}`;
			}
			return [];
		});
		expect(executionOrder).toEqual([
			"tool_execution_start:plan-update",
			"tool_execution_end:plan-update",
			"tool_execution_start:plan-replacement",
			"tool_execution_end:plan-replacement",
			"tool_execution_start:plan-clear",
			"tool_execution_end:plan-clear",
		]);

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.toolCallId)).toEqual([
			"plan-update",
			"plan-replacement",
			"plan-clear",
		]);
		expect(toolResults.map((message) => message.details)).toEqual([
			{
				plan: [{ step: "Implement the change", status: "in_progress" }],
				explanation: "initial explanation",
			},
			{ plan: [{ step: "Replacement", status: "in_progress" }] },
			{ clear: true },
		]);
		expect(getCurrentPlanEntries(harness).map((entry) => entry.data)).toEqual([
			{
				plan: [{ step: "Implement the change", status: "in_progress" }],
				explanation: "initial explanation",
			},
			{ plan: [{ step: "Replacement", status: "in_progress" }] },
			{ clear: true },
		]);
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual({
			status: "inactive",
			operation: { clear: true },
		});
	});

	it("preserves prior state when validation fails before persistence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", {
					plan: [{ step: "Keep this", status: "in_progress" }],
					explanation: "prior",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("continue"),
		]);
		await harness.session.prompt("set a plan");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { plan: [{ step: "Invalid", status: "pending" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("continue after error"),
		]);
		await harness.session.prompt("attempt an invalid replacement");

		expect(getCurrentPlanEntries(harness)).toHaveLength(1);
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual({
			status: "active",
			operation: {
				plan: [{ step: "Keep this", status: "in_progress" }],
				explanation: "prior",
			},
		});
		const failedResult = harness.session.messages.find((message) => message.role === "toolResult" && message.isError);
		expect(failedResult?.role).toBe("toolResult");
		if (failedResult?.role === "toolResult") {
			expect(getMessageText(failedResult)).toContain("exactly one in_progress");
		}
	});

	it("surfaces persistence failures without claiming durable success", async () => {
		const sessionManager = SessionManager.inMemory();
		vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation(() => {
			throw new Error("plan persistence failed");
		});
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", {
					plan: [{ step: "Cannot persist", status: "in_progress" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("continue after error"),
		]);

		await harness.session.prompt("persist a plan");

		expect(getCurrentPlanEntries(harness)).toEqual([]);
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.role).toBe("toolResult");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
			expect(getMessageText(toolResult)).toContain("plan persistence failed");
			expect(getMessageText(toolResult)).not.toContain("Plan updated:");
		}
	});

	it("keeps a same-name extension tool stateless", async () => {
		const harness = await createHarness({
			extensionFactories: [(diffex) => diffex.registerTool(createUpdatePlanToolDefinition())],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", {
					plan: [{ step: "Shadowed", status: "in_progress" }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("use the shadowing tool");

		expect(getCurrentPlanEntries(harness)).toEqual([]);
		expect(resolveCurrentPlanState(harness.sessionManager)).toEqual({ status: "absent" });
	});

	it("lets allowlists and excludes handle update_plan generically", async () => {
		const allowlisted = await createHarness({
			allowedToolNames: ["update_plan"],
			initialActiveToolNames: ["update_plan"],
		});
		harnesses.push(allowlisted);
		expect(allowlisted.session.getAllTools().map((tool) => tool.name)).toEqual(["update_plan"]);
		expect(allowlisted.session.getActiveToolNames()).toEqual(["update_plan"]);
		expect(allowlisted.session.systemPrompt).toContain("- update_plan:");

		const excluded = await createHarness({ excludedToolNames: ["update_plan"] });
		harnesses.push(excluded);
		expect(excluded.session.getAllTools().map((tool) => tool.name)).not.toContain("update_plan");
		expect(excluded.session.getActiveToolNames()).not.toContain("update_plan");
		expect(excluded.session.systemPrompt).not.toContain("update_plan");
	});
});
