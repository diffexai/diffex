import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
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
		expect(harness.session.systemPrompt).toContain(
			"- Use update_plan for complex or multi-step work; skip it for simple work.",
		);
		expect(harness.session.systemPrompt).toContain(
			"- Keep the full update_plan checklist current with exactly one in_progress item until all items are completed.",
		);
		expect(harness.session.systemPrompt).toContain(
			"- Updating the update_plan checklist communicates progress and does not execute the steps.",
		);

		harness.session.setActiveToolsByName(["read", "bash", "edit", "write"]);

		expect(harness.session.getActiveToolNames()).not.toContain("update_plan");
		expect(harness.session.systemPrompt).not.toContain("update_plan");
		expect(harness.session.systemPrompt).not.toContain("task checklist");
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
