import { fauxAssistantMessage, fauxToolCall, type Message } from "@diffexai/diffex-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("omits plan calls and results while preserving other content in the same message", () => {
		const messages: Message[] = [
			fauxAssistantMessage([
				{ type: "text", text: "Implementation findings" },
				{ type: "thinking", thinking: "Reasoning about the implementation" },
				fauxToolCall("update_plan", { clear: true, explanation: "Plan-only explanation" }),
				fauxToolCall("read", { path: "src/example.ts" }),
			]),
			{
				role: "toolResult",
				toolCallId: "plan-result",
				toolName: "update_plan",
				content: [{ type: "text", text: "Plan cleared." }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "read-result",
				toolName: "read",
				content: [{ type: "text", text: "File contents" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("Implementation findings");
		expect(result).toContain("Reasoning about the implementation");
		expect(result).toContain('read(path="src/example.ts")');
		expect(result).toContain("[Tool result]: File contents");
		expect(result).not.toContain("update_plan");
		expect(result).not.toContain("Plan-only explanation");
		expect(result).not.toContain("Plan cleared.");
	});

	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
