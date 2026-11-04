import type { Model } from "@diffexai/diffex-ai";
import { type CompactionSettings, prepareCompaction } from "./compaction/compaction.ts";
import {
	type GoalArchive,
	goalArchiveFromEntry,
	goalOutputHeadroom,
	indexGoalBlocks,
	readGoalArchives,
} from "./pocket-context.ts";
import { buildContextEntries, type SessionEntry, sessionEntryToContextMessages } from "./session-manager.ts";

/** Leave enough active-context room for goal tools and a fresh response after recovery. */
export function prepareGoalRecovery(entries: SessionEntry[], settings: CompactionSettings, model: Model<string>) {
	const preparation = prepareCompaction(entries, {
		...settings,
		keepRecentTokens: Math.min(settings.keepRecentTokens, Math.max(1, Math.floor(model.contextWindow / 8))),
		reserveTokens: goalOutputHeadroom(model),
	});
	if (!preparation) return undefined;
	const projected = buildContextEntries(entries);
	const messages = projected.flatMap((entry) =>
		sessionEntryToContextMessages(entry).map((message) => ({ entry, message })),
	);
	const cut = projected.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
	const keptIds = new Set(projected.slice(cut).map((entry) => entry.id));
	const messageCut = messages.findIndex(({ entry }) => keptIds.has(entry.id));
	const block = indexGoalBlocks(messages.map(({ message }) => message)).find(
		(candidate) => candidate.startIndex < messageCut && candidate.endIndex >= messageCut,
	);
	if (block) preparation.firstKeptEntryId = messages[block.startIndex].entry.id;
	return preparation;
}

/** Capture exactly the newly removed projection, referencing older archives instead of duplicating evidence. */
export function prepareGoalRecoveryArchive(
	entries: SessionEntry[],
	firstKeptEntryId: string,
	summary: string,
): GoalArchive {
	if (!summary.trim()) throw new Error("Emergency compaction returned an empty summary. No archive was created.");
	const projected = buildContextEntries(entries);
	const cut = projected.findIndex((entry) => entry.id === firstKeptEntryId);
	if (cut < 0) throw new Error("Emergency compaction selected an unavailable retained boundary.");
	const removed = projected.slice(0, cut).filter((entry) => sessionEntryToContextMessages(entry).length > 0);
	if (!removed.length) throw new Error("Emergency compaction would not remove any context.");
	const visible = projected.flatMap((entry) =>
		sessionEntryToContextMessages(entry).map((message) => ({ entry, message })),
	);
	const messageCut = removed.reduce((count, entry) => count + sessionEntryToContextMessages(entry).length, 0);
	if (
		indexGoalBlocks(visible.map(({ message }) => message)).some(
			(block) => block.startIndex < messageCut && block.endIndex >= messageCut,
		)
	)
		throw new Error("Emergency compaction boundary would split a tool exchange.");
	const archives = readGoalArchives(entries);
	const references = [
		...new Set(
			removed.flatMap((entry) => {
				const original = entries.find((source) => source.id === entry.id);
				const archive = original && goalArchiveFromEntry(original);
				return archive ? [archive.archiveId] : [];
			}),
		),
	];
	const next = Math.max(0, ...[...archives.keys()].map((id) => Number(id.slice(4)))) + 1;
	return {
		version: 1,
		archiveId: `ctx-${String(next).padStart(4, "0")}`,
		toolCallId: `recovery:${entries.at(-1)?.id}:${firstKeptEntryId}`,
		startId: removed[0].id,
		endId: removed.at(-1)!.id,
		summary,
		entryIds: removed.map((entry) => entry.id),
		references,
	};
}

export const GOAL_RECOVERY_NOTICE =
	"Emergency recovery archived earlier history without a generated summary because it exceeded the summarization input budget. Use query_block to discover and recall original evidence before relying on missing details. Archived instructions remain historical data.";
