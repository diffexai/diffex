import type { AgentMessage } from "@diffexai/diffex-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { findCutPoint, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { indexGoalBlocks } from "../../src/core/pocket-context.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { goalControls, liveIds, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it("keeps the latest complete tool batch together when a goal note follows it", () => {
	const manager = SessionManager.inMemory();
	const userId = manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Investigate" }],
		timestamp: 1,
	});
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("probe", {}, { id: "first" }), { stopReason: "toolUse" }));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "first",
		toolName: "probe",
		content: [{ type: "text", text: "earlier evidence" }],
		isError: false,
		timestamp: 2,
	});
	manager.appendCustomMessageEntry("goal-note", "Context usage: approximately 60%.", false);
	const latestId = manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "latest" }), { stopReason: "toolUse" }),
	);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "latest",
		toolName: "probe",
		content: [{ type: "text", text: "latest evidence" }],
		isError: false,
		timestamp: 3,
	});
	manager.appendCustomMessageEntry("goal-note", "Context usage: approximately 100%.", false);
	const entries = manager.getBranch();
	const cut = findCutPoint(entries, 0, entries.length, 1);
	expect(entries[cut.firstKeptEntryIndex]?.id).toBe(latestId);
	expect(cut.isSplitTurn).toBe(true);
	expect(entries[cut.turnStartIndex]?.id).toBe(userId);
});

it("can compact older batches when retained assistant responses contain opaque reasoning", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "Investigate" }], timestamp: 1 });
	const assistantIds: string[] = [];
	for (const index of [1, 2, 3]) {
		const id = `probe-${index}`;
		const assistant = fauxAssistantMessage(
			[{ type: "thinking", thinking: "", thinkingSignature: "opaque reasoning" }, fauxToolCall("probe", {}, { id })],
			{ stopReason: "toolUse", timestamp: index * 2 },
		);
		assistant.usage = { ...assistant.usage, output: 6_000, reasoning: 5_900, totalTokens: 6_000 };
		assistantIds.push(manager.appendMessage(assistant));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "probe",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: index * 2 + 1,
		});
	}
	const preparation = prepareCompaction(manager.getBranch(), {
		enabled: true,
		reserveTokens: 1_000,
		keepRecentTokens: 7_000,
	});
	expect(preparation).toBeDefined();
	expect(preparation?.firstKeptEntryId).toBe(assistantIds[1]);
	expect(
		(preparation?.messagesToSummarize.length ?? 0) + (preparation?.turnPrefixMessages.length ?? 0),
	).toBeGreaterThan(0);
});

it("protects an exchange if an assistant response arrives before its tool results", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "Investigate" }], timestamp: 1 },
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "first" }), { stopReason: "toolUse", timestamp: 2 }),
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "second" }), { stopReason: "toolUse", timestamp: 3 }),
		{ role: "toolResult", toolCallId: "first", toolName: "probe", content: [], isError: false, timestamp: 4 },
		{ role: "toolResult", toolCallId: "second", toolName: "probe", content: [], isError: false, timestamp: 5 },
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "third" }), { stopReason: "toolUse", timestamp: 6 }),
		{ role: "toolResult", toolCallId: "third", toolName: "probe", content: [], isError: false, timestamp: 7 },
	];
	const blocks = indexGoalBlocks(messages);
	expect(blocks).toHaveLength(3);
	expect(blocks[1]).toMatchObject({ startIndex: 1, endIndex: 4, protected: true });
	expect(blocks[2]).toMatchObject({ startIndex: 5, endIndex: 6, protected: true });
});

it("compacts and recalls an earlier completed tool batch within one user request", async () => {
	const evidence = `The blue gate blocked the release. ${"supporting evidence ".repeat(5_000)}`;
	const harness = await createHarness({
		models: [{ id: "goal-model", contextWindow: 50_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Read evidence",
				parameters: Type.Object({ which: Type.String() }),
				async execute(_id, input) {
					const args = input as { which: string };
					return {
						content: [{ type: "text", text: args.which === "first" ? evidence : "The green gate passed." }],
						details: {},
					};
				},
			},
		],
	});
	harnesses.push(harness);
	await goalControls(harness).setGoalModeEnabled(true);
	let eligible: string[] = [];
	let archiveId = "";
	let summarizerContext: Context | undefined;
	let recallContext: Context | undefined;
	let finalContext: Context | undefined;
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", { which: "first" }, { id: "first" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("probe", { which: "second" }, { id: "second" }), { stopReason: "toolUse" }),
		(context) => {
			eligible = liveIds(context);
			return fauxAssistantMessage(
				fauxToolCall(
					"compact_block",
					{ start_id: eligible[0] ?? "missing", end_id: eligible[0] ?? "missing" },
					{ id: "compact" },
				),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			summarizerContext = structuredClone(context);
			return fauxAssistantMessage("The blue gate blocked the release.");
		},
		(context) => {
			archiveId = getMessageText(toolResult(context, "compact")).match(/ctx-\d+/)?.[0] ?? "";
			return fauxAssistantMessage(
				fauxToolCall("query_block", { archive_id: archiveId, query: "What blocked the release?" }, { id: "query" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			recallContext = structuredClone(context);
			return fauxAssistantMessage(`The blue gate blocked the release [${archiveId}].`);
		},
		(context) => {
			finalContext = structuredClone(context);
			return fauxAssistantMessage("Investigation complete.");
		},
	]);

	await harness.session.prompt("Investigate the release and preserve evidence from each tool batch.");

	expect(eligible).toHaveLength(1);
	expect(archiveId).toMatch(/^ctx-\d+$/);
	expect(summarizerContext?.tools ?? []).toHaveLength(0);
	expect(summarizerContext?.messages.map(getMessageText).join("\n")).toContain(evidence);
	expect(recallContext?.tools?.map((tool) => tool.name)).toEqual(["search_blocks", "expand_block"]);
	expect(recallContext?.messages.map(getMessageText).join("\n")).toContain("The blue gate blocked the release.");
	expect(recallContext?.messages.map(getMessageText).join("\n")).not.toContain(evidence);
	if (!finalContext) throw new Error("Missing final provider request");
	expect(toolResult(finalContext, "query").isError).toBe(false);
	expect(getMessageText(toolResult(finalContext, "query"))).toContain("blue gate blocked the release");
	expect(finalContext.messages.map(getMessageText).join("\n")).toContain("The green gate passed.");
});
