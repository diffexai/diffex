import type { AgentMessage } from "@diffexai/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/compaction.ts";
import {
	GOAL_REPLACEMENT_ENTRY,
	type GoalArchive,
	GoalBlockIdRegistry,
	indexGoalBlocks,
	projectGoalEntries,
	reachableGoalArchives,
	readGoalArchives,
} from "../../src/core/pocket-context.ts";
import { buildSessionContext, type SessionEntry } from "../../src/core/session-manager.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function message(id: string, parentId: string | null, value: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp, message: value };
}

function replacement(id: string, parentId: string, data: GoalArchive): SessionEntry {
	return { type: "custom", customType: GOAL_REPLACEMENT_ENTRY, id, parentId, timestamp, data };
}

function archive(overrides: Partial<GoalArchive> = {}): GoalArchive {
	return {
		version: 1,
		archiveId: "ctx-0001",
		toolCallId: "compact-1",
		startId: "b001",
		endId: "b001",
		summary: "The deployment gate failed.",
		entryIds: ["old"],
		references: [],
		...overrides,
	};
}

describe("Pocket Context projection", () => {
	it("replays a committed replacement, including a receipt after a crash, and preserves it through later compaction", () => {
		const entries: SessionEntry[] = [
			message("old", null, { role: "user", content: "Original evidence", timestamp: 1 }),
			message("request", "old", { role: "user", content: "Current request", timestamp: 2 }),
			message(
				"call",
				"request",
				fauxAssistantMessage(fauxToolCall("compact_block", {}, { id: "compact-1" }), { stopReason: "toolUse" }),
			),
			replacement("commit", "call", archive()),
		];
		const recovered = projectGoalEntries(entries);
		expect(JSON.stringify(recovered)).not.toContain("Original evidence");
		expect(JSON.stringify(recovered)).toContain("The deployment gate failed.");
		expect(JSON.stringify(recovered)).toContain("Compacted into ctx-0001.");
		const resumed = buildSessionContext(entries).messages;
		expect(JSON.stringify(resumed)).not.toContain("Original evidence");
		expect(JSON.stringify(resumed)).toContain("Compacted into ctx-0001.");
		const compacted = projectGoalEntries([
			...entries,
			{
				type: "compaction",
				id: "ordinary",
				parentId: "commit",
				timestamp,
				summary: "Ordinary summary",
				firstKeptEntryId: "request",
				tokensBefore: 100,
			},
		]);
		expect(JSON.stringify(compacted)).not.toContain("Original evidence");
		expect(JSON.stringify(compacted)).toContain("Ordinary summary");
		const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
		expect(preparation).toBeDefined();
		expect(JSON.stringify(preparation?.messagesToSummarize)).toContain("The deployment gate failed.");
		expect(JSON.stringify(preparation)).not.toContain("Original evidence");
	});

	it("rejects a replacement that skips visible evidence or uses a duplicated call ID", () => {
		const entries: SessionEntry[] = [
			message("old", null, { role: "user", content: "First", timestamp: 1 }),
			message("middle", "old", { role: "user", content: "Middle", timestamp: 2 }),
			message("end", "middle", { role: "user", content: "End", timestamp: 3 }),
		];
		expect(() =>
			projectGoalEntries([...entries, replacement("bad", "end", archive({ entryIds: ["old", "end"] }))]),
		).toThrow(/inconsistent/);
		expect(() =>
			readGoalArchives([
				replacement("one", "end", archive()),
				replacement("two", "one", archive({ archiveId: "ctx-0002" })),
			]),
		).toThrow(/duplicate/);
	});

	it("limits graph traversal to known archives and reports missing references and cycles", () => {
		const first = archive();
		const second = archive({ archiveId: "ctx-0002", toolCallId: "compact-2", references: [first.archiveId] });
		const archives = new Map([
			[first.archiveId, first],
			[second.archiveId, second],
		]);
		expect([...reachableGoalArchives(archives, second.archiveId)]).toEqual([first.archiveId, second.archiveId]);
		expect(() => reachableGoalArchives(new Map([[second.archiveId, second]]), second.archiveId)).toThrow(/missing/i);
		expect(() =>
			reachableGoalArchives(
				new Map([[first.archiveId, { ...first, references: [first.archiveId] }]]),
				first.archiveId,
			),
		).toThrow(/cycle/i);
	});

	it("keeps live block IDs stable across removal of earlier blocks", () => {
		const registry = new GoalBlockIdRegistry();
		const messages: AgentMessage[] = [
			{ role: "user", content: "First", timestamp: 1 },
			{ role: "user", content: "Second", timestamp: 2 },
			{ role: "user", content: "Latest", timestamp: 3 },
		];
		const before = registry.index(messages, ["one", "two", "three"]);
		const after = registry.index(messages.slice(1), ["two", "three"]);
		expect(after.map((block) => block.id)).toEqual(before.slice(1).map((block) => block.id));
	});

	it("protects an exchange containing duplicate call IDs even if the calls appear resolved", () => {
		const messages: AgentMessage[] = [
			fauxAssistantMessage(
				[fauxToolCall("read", {}, { id: "duplicate" }), fauxToolCall("read", {}, { id: "duplicate" })],
				{
					stopReason: "toolUse",
				},
			),
			{
				role: "toolResult",
				toolCallId: "duplicate",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "Latest", timestamp: 3 },
			fauxAssistantMessage("Newer exchange"),
		];
		expect(indexGoalBlocks(messages)[0].protected).toBe(true);
	});
});
