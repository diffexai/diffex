import type { AgentMessage } from "@diffexai/diffex-agent-core";
import {
	CONTEXT_SAFETY_TOKENS,
	estimateContextTokens,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
} from "@diffexai/diffex-ai";
import { afterEach, expect, it } from "vitest";
import { goalEvidence } from "../../src/core/goal-evidence.ts";
import { prepareGoalSummaryEvidence, prepareGoalSummaryRequest } from "../../src/core/goal-summary.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it("preserves defined evidence fields without filtering argument data that resembles provider metadata", () => {
	const argumentsData = {
		thinkingSignature: "ordinary argument",
		payload: { type: "image", data: "ordinary data", mimeType: "text/plain" },
	};
	const assistant = fauxAssistantMessage(
		[
			{ type: "thinking", thinking: "Observed a failure.", thinkingSignature: "opaque-thinking" },
			{ type: "text", text: "Keep this observation.", textSignature: "opaque-text" },
			{ ...fauxToolCall("probe", argumentsData, { id: "probe-id" }), thoughtSignature: "opaque-tool" },
		],
		{ stopReason: "toolUse" },
	);
	assistant.responseId = "transport-id";
	const messages: AgentMessage[] = [
		{ role: "user", content: "Original request.", timestamp: 1 },
		assistant,
		{
			role: "toolResult",
			toolName: "probe",
			toolCallId: "probe-id",
			isError: true,
			content: [{ type: "text", text: "Observed test failure." }],
			details: { internal: "bookkeeping" },
			timestamp: 2,
		},
		{
			role: "custom",
			customType: "goal-summary",
			content: "Earlier decision.",
			details: { archiveId: "ctx-0001", internal: "bookkeeping" },
			display: false,
			timestamp: 3,
		},
	];
	const before = structuredClone(messages);
	const result = prepareGoalSummaryEvidence(messages, 1, true, [
		"source-user",
		"source-assistant",
		"source-result",
		"source-archive",
	]);
	expect(result).toHaveLength(1);
	const text = getMessageText({ content: result });
	for (const value of [
		"Original request.",
		"Observed a failure.",
		"Keep this observation.",
		"probe-id",
		"Observed test failure.",
		"ctx-0001",
		"source-result",
		'"is_error":true',
		JSON.stringify(argumentsData),
	])
		expect(text).toContain(value);
	for (const value of [
		"opaque-thinking",
		"opaque-text",
		"opaque-tool",
		"transport-id",
		"bookkeeping",
		'"usage"',
		'"timestamp"',
		'"cost"',
	])
		expect(text).not.toContain(value);
	expect(messages).toEqual(before);
});

it("retains ordered image attachments and explicit unavailable-image evidence", () => {
	const images: ImageContent[] = [
		{ type: "image", mimeType: "image/png", data: "first-image" },
		{ type: "image", mimeType: "image/jpeg", data: "second-image" },
	];
	const messages: AgentMessage[] = [
		{ role: "user", content: [images[0]], timestamp: 1 },
		{
			role: "toolResult",
			toolName: "probe",
			toolCallId: "probe",
			content: [images[1]],
			isError: false,
			timestamp: 2,
		},
	];
	const supported = prepareGoalSummaryEvidence(messages, 1, true);
	expect(supported.slice(1)).toEqual(images);
	expect(getMessageText({ content: supported })).toContain('"image_index":0');
	expect(getMessageText({ content: supported })).toContain('"image_index":1');
	expect(getMessageText({ content: supported })).not.toContain("first-image");
	const unsupported = prepareGoalSummaryEvidence(messages, 1, false);
	expect(unsupported).toHaveLength(1);
	expect(getMessageText({ content: unsupported })).toContain("unsupported by model");
});

it("preserves shell failures and summary provenance while excluding runtime notes", () => {
	expect(
		goalEvidence(
			{
				role: "bashExecution",
				command: "false",
				output: "failure",
				exitCode: 1,
				cancelled: false,
				truncated: true,
				fullOutputPath: "/tmp/result",
				timestamp: 1,
			},
			[],
		),
	).toEqual({
		role: "bashExecution",
		command: "false",
		output: "failure",
		exitCode: 1,
		cancelled: false,
		truncated: true,
		fullOutputPath: "/tmp/result",
	});
	expect(
		goalEvidence({ role: "branchSummary", summary: "Decision.", fromId: "source-branch", timestamp: 1 }, []),
	).toEqual({ role: "branchSummary", summary: "Decision.", fromId: "source-branch" });
	expect(
		goalEvidence(
			{ role: "custom", customType: "goal-note", content: "runtime only", display: false, timestamp: 1 },
			[],
		),
	).toBeUndefined();
	expect(
		goalEvidence(
			{
				role: "bashExecution",
				command: "private",
				output: "excluded",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 1,
			},
			[],
		),
	).toBeUndefined();
});

it("budgets the system prompt, earlier history, JSON escaping, and images before dispatch", async () => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000, input: ["text", "image"] }],
	});
	harnesses.push(harness);
	const model = harness.getModel();
	const messages: AgentMessage[] = [
		{ role: "user", content: "x".repeat(77_000), timestamp: 1 },
		fauxAssistantMessage("Selected observation."),
	];
	const request = prepareGoalSummaryRequest(messages, 1, model);
	expect(
		estimateContextTokens(request.context).tokens + request.maxTokens + CONTEXT_SAFETY_TOKENS,
	).toBeLessThanOrEqual(32_000);
	expect(getMessageText(request.context.messages[0])).toContain("x".repeat(77_000));
	const image: ImageContent = { type: "image", mimeType: "image/png", data: "image-data" };
	const withImage: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "x".repeat(77_000) }, image], timestamp: 1 },
		messages[1],
	];
	expect(() => prepareGoalSummaryRequest(withImage, 1, model)).toThrow("input budget exceeded");
	expect(() =>
		prepareGoalSummaryRequest([{ role: "user", content: "\u0000".repeat(20_000), timestamp: 1 }], 0, model),
	).toThrow("input budget exceeded");
	expect(() =>
		prepareGoalSummaryRequest([{ role: "user", content: "x".repeat(90_000), timestamp: 1 }, messages[1]], 1, model),
	).toThrow("oldest eligible blocks");
});
