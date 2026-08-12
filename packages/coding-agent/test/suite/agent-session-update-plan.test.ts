import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { updatePlanToolSystemPromptContribution } from "../../src/core/tools/update-plan.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession update_plan tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

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
			{ step: "Implement update_plan", status: "in_progress" },
			{ step: "Run checks", status: "pending" },
		] as const;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { plan }), { stopReason: "toolUse" }),
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
		expect(toolResult.details).toEqual({ plan });
		expect(getMessageText(harness.session.messages[3])).toBe("continuing after plan");
	});

	it("executes batched update_plan operations sequentially in source order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"update_plan",
						{ plan: [{ step: "Implement the change", status: "in_progress" }] },
						{ id: "plan-update" },
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
			"tool_execution_start:plan-clear",
			"tool_execution_end:plan-clear",
		]);

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.toolCallId)).toEqual(["plan-update", "plan-clear"]);
		expect(toolResults.map((message) => message.details)).toEqual([
			{ plan: [{ step: "Implement the change", status: "in_progress" }] },
			{ clear: true },
		]);
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
