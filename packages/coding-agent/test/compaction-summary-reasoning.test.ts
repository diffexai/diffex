import type { AgentMessage } from "@earendil-works/diffex-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/diffex-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateBranchSummary,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";
import type { SessionMessageEntry } from "../src/core/session-manager.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/diffex-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/diffex-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Objective\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

function capturedPrompt(callIndex = 0): string {
	return JSON.stringify(completeSimpleMock.mock.calls[callIndex]?.[1] ?? {});
}

function createSessionMessageEntry(id: string, message: AgentMessage): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Objective\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Objective\nTest summary",
		);
	});

	it("uses a task-agnostic checkpoint and appends profile-specific focus", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			"Prioritize peer-reviewed sources and state confidence levels.",
		);

		const prompt = capturedPrompt();
		expect(prompt).toContain("## Objective");
		expect(prompt).toContain("## Sources, Evidence & Artifacts");
		expect(prompt).toContain("## Open Questions & Uncertainty");
		expect(prompt).toContain("Additional focus: Prioritize peer-reviewed sources and state confidence levels.");
		expect(prompt).not.toContain("Preserve exact file paths, function names, and error messages");
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key");

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("applies profile-specific focus to both history and split-turn checkpoints", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 2000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
		};

		await compact(
			preparation,
			createModel(false),
			"test-key",
			undefined,
			"Preserve statutory citations and jurisdictional uncertainty.",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		for (let callIndex = 0; callIndex < 2; callIndex++) {
			expect(capturedPrompt(callIndex)).toContain(
				"Additional focus: Preserve statutory citations and jurisdictional uncertainty.",
			);
		}
	});

	it("retains file-operation metadata only when files were used", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 2000,
			fileOps: { read: new Set(["/reports/forecast.csv"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 },
		};

		const withFiles = await compact(preparation, createModel(false), "test-key");
		expect(withFiles.summary).toContain("<read-files>\n/reports/forecast.csv\n</read-files>");

		completeSimpleMock.mockClear();
		const withoutFiles = await compact(
			{ ...preparation, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
			createModel(false),
			"test-key",
		);
		expect(withoutFiles.summary).not.toContain("<read-files>");
		expect(withoutFiles.summary).not.toContain("<modified-files>");
	});

	it("uses the task-agnostic checkpoint for branch summaries and preserves actual file reads", async () => {
		const assistantWithFileRead: AssistantMessage = {
			...mockSummaryResponse,
			content: [
				{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "/research/source.pdf" } },
				{ type: "text", text: "Reviewed the primary source." },
			],
		};

		const result = await generateBranchSummary([createSessionMessageEntry("branch-message", assistantWithFileRead)], {
			model: createModel(false),
			apiKey: "test-key",
			signal: new AbortController().signal,
			customInstructions: "Prioritize source provenance.",
		});

		const prompt = capturedPrompt();
		expect(prompt).toContain("## Objective");
		expect(prompt).toContain("## Sources, Evidence & Artifacts");
		expect(prompt).toContain("## Open Questions & Uncertainty");
		expect(prompt).toContain("Additional focus: Prioritize source provenance.");
		expect(result.summary).toContain("<read-files>\n/research/source.pdf\n</read-files>");
		expect(result.readFiles).toEqual(["/research/source.pdf"]);
	});
});
