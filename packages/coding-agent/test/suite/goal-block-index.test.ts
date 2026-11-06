import type { AgentMessage } from "@diffexai/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { describe, expect, it } from "vitest";
import { indexGoalBlocks, validateGoalSelection } from "../../src/core/pocket-context.ts";

function history(): AgentMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: "Previous request" }], timestamp: 1 },
		fauxAssistantMessage([fauxToolCall("read", {}, { id: "read-1" }), fauxToolCall("read", {}, { id: "read-2" })], {
			stopReason: "toolUse",
			timestamp: 2,
		}),
		{
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "first result" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "read-2",
			toolName: "read",
			content: [{ type: "text", text: "second result" }],
			isError: false,
			timestamp: 4,
		},
		fauxAssistantMessage("Completed the previous exchange.", { timestamp: 5 }),
		{
			role: "custom",
			customType: "goal-note",
			content: "Context usage: approximately 50%.",
			display: false,
			timestamp: 6,
		},
		{ role: "user", content: [{ type: "text", text: "Latest genuine request" }], timestamp: 7 },
		fauxAssistantMessage(fauxToolCall("read", {}, { id: "unfinished" }), { stopReason: "toolUse", timestamp: 8 }),
	];
}

describe("goal block selection contract", () => {
	it("indexes complete exchanges as one unit and protects the latest request and incomplete exchange", () => {
		const blocks = indexGoalBlocks(history());
		const previous = blocks.find((block) => block.startIndex <= 1 && block.endIndex >= 4);
		const latestUser = blocks.find((block) => block.startIndex <= 6 && block.endIndex >= 6);
		const unfinished = blocks.find((block) => block.startIndex <= 7 && block.endIndex >= 7);
		expect(previous).toBeDefined();
		expect(previous?.protected).toBe(false);
		expect(previous?.endIndex).toBeLessThan(6);
		expect(latestUser?.protected).toBe(true);
		expect(unfinished?.protected).toBe(true);
		expect(blocks.some((block) => block.startIndex === 5 && block.endIndex === 5)).toBe(false);
	});

	it("rejects ranges that cross a protected gap or end within an incomplete exchange", () => {
		const blocks = indexGoalBlocks(history());
		const previous = blocks.find((block) => block.startIndex <= 1 && block.endIndex >= 4);
		const latestUser = blocks.find((block) => block.startIndex <= 6 && block.endIndex >= 6);
		const unfinished = blocks.find((block) => block.startIndex <= 7 && block.endIndex >= 7);
		if (!previous || !latestUser || !unfinished) throw new Error("Missing indexed test blocks");
		expect(validateGoalSelection(blocks, previous.id, previous.id)).toBe(true);
		expect(validateGoalSelection(blocks, previous.id, latestUser.id)).toBe(false);
		expect(validateGoalSelection(blocks, previous.id, unfinished.id)).toBe(false);
		expect(validateGoalSelection(blocks, unfinished.id, unfinished.id)).toBe(false);
	});
});
