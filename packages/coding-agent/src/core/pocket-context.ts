import type { AgentMessage } from "@diffexai/diffex-agent-core";
import { CONTEXT_SAFETY_TOKENS, type Model, type Usage } from "@diffexai/diffex-ai";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "./session-manager.ts";

export const GOAL_MODE_ENTRY = "goal-mode-v1";
export const GOAL_REPLACEMENT_ENTRY = "goal-replacement-v1";
export const GOAL_NOTE_TYPE = "goal-note";
export const GOAL_SUMMARY_TYPE = "goal-summary";
export const GOAL_ARCHIVE_CATALOG_TYPE = "goal-archive-catalog";
export const GOAL_LABEL_TYPE = "goal-context-label";

export interface GoalNoteDetails {
	blockId: string;
	assignments: Array<[string, string]>;
	/** Present only when this boundary reports context usage to the model. */
	reportedUsage?: number;
}

export function goalNoteDetails(message: AgentMessage): GoalNoteDetails | undefined {
	if (message.role !== "custom" || message.customType !== GOAL_NOTE_TYPE) return undefined;
	const details = message.details as Partial<GoalNoteDetails> | undefined;
	if (!details || typeof details.blockId !== "string" || !/^b\d{3,}$/.test(details.blockId)) return undefined;
	if (
		(details.reportedUsage !== undefined &&
			(typeof details.reportedUsage !== "number" ||
				!Number.isFinite(details.reportedUsage) ||
				details.reportedUsage < 0)) ||
		!Array.isArray(details.assignments) ||
		!details.assignments.every(
			(item) =>
				Array.isArray(item) &&
				item.length === 2 &&
				typeof item[0] === "string" &&
				typeof item[1] === "string" &&
				/^b\d{3,}$/.test(item[1]),
		)
	) {
		throw new Error("Invalid persisted context block assignments.");
	}
	return details as GoalNoteDetails;
}

/** A single durable replacement and the provenance needed to recall it. */
export interface GoalArchive {
	version: 1;
	archiveId: string;
	toolCallId: string;
	startId: string;
	endId: string;
	summary: string;
	entryIds: string[];
	references: string[];
	usage?: Usage;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** Validate persisted data before using it as a replacement or recall authority. */
export function parseGoalArchive(value: unknown): GoalArchive | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.archiveId !== "string" ||
		!/^ctx-\d{4,}$/.test(record.archiveId) ||
		typeof record.toolCallId !== "string" ||
		!record.toolCallId ||
		typeof record.startId !== "string" ||
		typeof record.endId !== "string" ||
		typeof record.summary !== "string" ||
		!record.summary.trim() ||
		!isStringArray(record.entryIds) ||
		record.entryIds.length === 0 ||
		new Set(record.entryIds).size !== record.entryIds.length ||
		!isStringArray(record.references) ||
		new Set(record.references).size !== record.references.length
	)
		return undefined;
	return record as unknown as GoalArchive;
}

/** Both replacement and recovery records own recall provenance on their branch. */
export function goalArchiveFromEntry(entry: SessionEntry): GoalArchive | undefined {
	if (entry.type === "compaction") return parseGoalArchive(entry.goalArchive);
	if (entry.type === "custom" && entry.customType === GOAL_REPLACEMENT_ENTRY) return parseGoalArchive(entry.data);
	return undefined;
}

/** Restore mode state from the selected branch, independent of global settings. */
export function readGoalMode(entries: readonly SessionEntry[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GOAL_MODE_ENTRY) continue;
		const data = entry.data;
		if (typeof data === "object" && data !== null && "enabled" in data && typeof data.enabled === "boolean") {
			enabled = data.enabled;
		}
	}
	return enabled;
}

/** Return only archives committed on this branch, preserving their original order. */
export function readGoalArchives(entries: readonly SessionEntry[]): Map<string, GoalArchive> {
	const archives = new Map<string, GoalArchive>();
	const calls = new Set<string>();
	for (const entry of entries) {
		if (
			!(entry.type === "custom" && entry.customType === GOAL_REPLACEMENT_ENTRY) &&
			!(entry.type === "compaction" && entry.goalArchive !== undefined)
		)
			continue;
		const archive = goalArchiveFromEntry(entry);
		if (!archive || archives.has(archive.archiveId) || calls.has(archive.toolCallId)) {
			throw new Error("Invalid or duplicate goal archive record in session history.");
		}
		archives.set(archive.archiveId, archive);
		calls.add(archive.toolCallId);
	}
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const validateCycles = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Corrupt archive reference cycle at ${id}.`);
		if (visited.has(id)) return;
		const archive = archives.get(id);
		if (!archive) return; // Missing dependencies are reported by the recall pipeline.
		visiting.add(id);
		for (const reference of archive.references) validateCycles(reference);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of archives.keys()) validateCycles(id);
	return archives;
}

/** Validate a selected archive graph without consulting other branches. */
export function reachableGoalArchives(archives: ReadonlyMap<string, GoalArchive>, rootId: string): Set<string> {
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Corrupt archive reference cycle at ${id}.`);
		if (visited.has(id)) return;
		const archive = archives.get(id);
		if (!archive) throw new Error(`Missing or corrupt archive reference ${id}.`);
		visiting.add(id);
		for (const reference of archive.references) visit(reference);
		visiting.delete(id);
		visited.add(id);
	};
	visit(rootId);
	return visited;
}

/** Check references against the selected stored entries, never summary text. */
export function validateGoalProvenance(
	entries: readonly SessionEntry[],
	archives: ReadonlyMap<string, GoalArchive>,
): void {
	const byEntry = new Map<string, string>();
	for (const entry of entries) {
		const archive = goalArchiveFromEntry(entry);
		if (archive) byEntry.set(entry.id, archive.archiveId);
	}
	for (const archive of archives.values()) {
		const expected = [
			...new Set(
				archive.entryIds.flatMap((entryId) => {
					const reference = byEntry.get(entryId);
					return reference ? [reference] : [];
				}),
			),
		];
		if (
			expected.length !== archive.references.length ||
			expected.some((id, index) => id !== archive.references[index])
		) {
			throw new Error(`Missing or corrupt archive provenance for ${archive.archiveId}.`);
		}
	}
}

/** Replay replacements and ordinary compactions in branch order. */
export function projectGoalEntries(path: readonly SessionEntry[]): SessionEntry[] {
	const archives = readGoalArchives(path);
	const results = new Set(
		path.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
		),
	);
	let active: SessionEntry[] = [];
	for (const entry of path) {
		if (entry.type === "compaction") {
			if (entry.goalArchive) {
				// Recovery replaces only eligible entries. Protected islands remain verbatim.
				const removed = new Set(entry.goalArchive.entryIds);
				const visibleIds = active.filter((candidate) => removed.has(candidate.id)).map((candidate) => candidate.id);
				if (
					visibleIds.length !== removed.size ||
					visibleIds.some((id, index) => id !== entry.goalArchive!.entryIds[index])
				)
					throw new Error("Cannot replay inconsistent goal recovery archive.");
				const start = active.findIndex((candidate) => removed.has(candidate.id));
				active = [
					...active.slice(0, start),
					entry,
					...active.slice(start).filter((candidate) => !removed.has(candidate.id)),
				];
				continue;
			}
			const kept = active.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			if (kept < 0) throw new Error("Cannot replay compaction: retained context is unavailable.");
			active = [entry, ...active.slice(kept)];
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== GOAL_REPLACEMENT_ENTRY) {
			active.push(entry);
			continue;
		}
		const archive = parseGoalArchive(entry.data);
		if (!archive || archives.get(archive.archiveId) !== archive) {
			throw new Error("Cannot replay an invalid goal archive.");
		}
		const start = active.findIndex((candidate) => candidate.id === archive.entryIds[0]);
		const end = active.findIndex((candidate) => candidate.id === archive.entryIds.at(-1));
		if (start < 0 || end < start) throw new Error(`Cannot replay goal archive ${archive.archiveId}.`);
		const visibleIds = active
			.slice(start, end + 1)
			.filter(isContextEntry)
			.map((candidate) => candidate.id);
		if (
			visibleIds.length !== archive.entryIds.length ||
			visibleIds.some((id, index) => id !== archive.entryIds[index])
		) {
			throw new Error(`Cannot replay inconsistent goal archive ${archive.archiveId}.`);
		}
		const replacement: CustomMessageEntry = {
			type: "custom_message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			customType: GOAL_SUMMARY_TYPE,
			content: `[${archive.archiveId}] Assistant-generated decision record:\n${archive.summary}`,
			display: false,
			details: { archiveId: archive.archiveId },
		};
		active.splice(start, end - start + 1, replacement);
		if (!results.has(archive.toolCallId)) {
			const receipt: SessionMessageEntry = {
				type: "message",
				id: `${entry.id}-receipt`,
				parentId: entry.id,
				timestamp: entry.timestamp,
				message: {
					role: "toolResult",
					toolCallId: archive.toolCallId,
					toolName: "compact_block",
					content: [{ type: "text", text: `Compacted into ${archive.archiveId}.` }],
					isError: false,
					timestamp: new Date(entry.timestamp).getTime(),
				},
			};
			active.push(receipt);
		}
	}
	return active;
}

function isContextEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "custom_message" ||
		entry.type === "branch_summary" ||
		entry.type === "compaction"
	);
}

/** Input to the shared goal-mode budget calculation. */
export interface GoalBudgetInput {
	estimatedInputTokens: number;
	contextWindow: number;
	maxTokens?: number;
}

/** Leave room for reasoning and an answer without consuming small model windows. */
export function goalOutputHeadroom(model: Pick<Model<string>, "contextWindow" | "maxTokens">): number {
	return Math.max(0, Math.min(model.maxTokens, 8_192, Math.floor(model.contextWindow / 4)));
}

/** Budget decisions shared by goal notes, tool admission, and emergency compaction. */
export interface GoalBudget {
	usage: number;
	canCompact: boolean;
	nudge: string | undefined;
	requiresEmergencyCompaction: boolean;
}

/** Measure pressure against the full window; check request headroom independently. */
export function calculateGoalBudget(input: GoalBudgetInput): GoalBudget {
	const capacity =
		input.contextWindow -
		CONTEXT_SAFETY_TOKENS -
		goalOutputHeadroom({ contextWindow: input.contextWindow, maxTokens: input.maxTokens ?? 8_192 });
	const valid =
		Number.isFinite(input.estimatedInputTokens) &&
		Number.isFinite(input.contextWindow) &&
		input.estimatedInputTokens >= 0 &&
		input.contextWindow > 0;
	const usage = valid ? input.estimatedInputTokens / input.contextWindow : Number.POSITIVE_INFINITY;
	const requiresEmergencyCompaction =
		!valid || !Number.isFinite(capacity) || capacity <= 0 || input.estimatedInputTokens >= capacity;
	let nudge: string | undefined;
	if (!requiresEmergencyCompaction) {
		if (usage >= 0.85) nudge = "Compact older context now.";
		else if (usage >= 0.75) nudge = "Compact older work soon to preserve room.";
		else if (usage >= 0.6) nudge = "Consider compacting completed work.";
	}
	return { usage, canCompact: usage >= 0.4, nudge, requiresEmergencyCompaction };
}

/** An inclusive range in the current context projection. */
export interface GoalBlock {
	id: string;
	startIndex: number;
	endIndex: number;
	protected: boolean;
}

/** Index complete exchanges without exposing runtime notes as selectable blocks. */
export function indexGoalBlocks(messages: readonly AgentMessage[]): GoalBlock[] {
	const blocks: GoalBlock[] = [];
	let latestUser = -1;
	let latestExchange = -1;
	for (let index = 0; index < messages.length; ) {
		let message = messages[index];
		const boundary = goalNoteDetails(message);
		const startIndex = index;
		if (boundary && messages[index + 1]?.role === "assistant") message = messages[++index];
		if (message.role === "custom" && [GOAL_NOTE_TYPE, GOAL_ARCHIVE_CATALOG_TYPE].includes(message.customType)) {
			index++;
			continue;
		}
		// An arbitrary extension message can carry runtime instructions, so it is
		// not safe to treat it as ordinary user history without provenance.
		let incomplete =
			message.role === "toolResult" || (message.role === "custom" && message.customType !== GOAL_SUMMARY_TYPE);
		if (message.role === "assistant") {
			const pending = new Set<string>();
			const seen = new Set<string>();
			while (index < messages.length) {
				const current = messages[index];
				if (goalNoteDetails(current)) break;
				if (current.role === "custom" && [GOAL_NOTE_TYPE, GOAL_ARCHIVE_CATALOG_TYPE].includes(current.customType)) {
					index++;
					continue;
				}
				if (current.role === "assistant") {
					// Keep final text with its batch, but a failed continuation is its own
					// incomplete exchange and must not pin an already completed tool batch.
					if (
						index > startIndex + (boundary ? 1 : 0) &&
						pending.size === 0 &&
						((!boundary && current.content.some((part) => part.type === "toolCall")) ||
							["pending", "aborted", "error", "length"].includes(current.stopReason))
					) {
						break;
					}
					if (index > startIndex && pending.size > 0) incomplete = true;
					if (["pending", "aborted", "error", "length"].includes(current.stopReason)) incomplete = true;
					for (const part of current.content) {
						if (part.type !== "toolCall") continue;
						if (!part.id || seen.has(part.id)) incomplete = true;
						seen.add(part.id);
						pending.add(part.id);
					}
				} else if (current.role === "toolResult") {
					if (!pending.delete(current.toolCallId)) incomplete = true;
				} else break;
				index++;
			}
			incomplete ||= pending.size > 0;
			latestExchange = blocks.length;
		} else {
			index++;
			if (message.role === "user") latestUser = blocks.length;
		}
		blocks.push({
			id: boundary?.blockId ?? `b${String(blocks.length + 1).padStart(3, "0")}`,
			startIndex,
			endIndex: index - 1,
			protected: incomplete,
		});
	}
	if (latestUser >= 0) blocks[latestUser].protected = true;
	if (latestExchange >= 0) blocks[latestExchange].protected = true;
	return blocks;
}

/** Retain public IDs while the underlying stored message identities remain unchanged. */
export class GoalBlockIdRegistry {
	private readonly ids = new Map<string, string>();
	private nextId = 1;
	private readonly persisted = new Set<string>();

	restore(notes: readonly AgentMessage[]): void {
		this.ids.clear();
		this.persisted.clear();
		this.nextId = 1;
		for (const note of notes) {
			const details = goalNoteDetails(note);
			if (!details) continue;
			this.nextId = Math.max(this.nextId, Number(details.blockId.slice(1)) + 1);
			for (const [key, id] of details.assignments) {
				if (this.ids.has(key) && this.ids.get(key) !== id) throw new Error("Conflicting context block identity.");
				this.ids.set(key, id);
				this.persisted.add(key);
				this.nextId = Math.max(this.nextId, Number(id.slice(1)) + 1);
			}
		}
	}

	reserve(): GoalNoteDetails {
		return {
			blockId: `b${String(this.nextId++).padStart(3, "0")}`,
			assignments: [...this.ids].filter(([key]) => !this.persisted.has(key)),
		};
	}

	index(messages: readonly AgentMessage[], messageIds: readonly string[], allocate = true): GoalBlock[] {
		if (messages.length !== messageIds.length || messageIds.some((id) => !id)) {
			throw new Error("Goal block identities do not match the active context.");
		}
		return indexGoalBlocks(messages).flatMap((block) => {
			if (goalNoteDetails(messages[block.startIndex])) {
				// Preserve the identity even if ordinary compaction keeps the response
				// but drops the pre-generation boundary.
				this.ids.set(messageIds[block.startIndex + 1], block.id);
				return [block];
			}
			const key = messageIds[block.startIndex];
			let id = this.ids.get(key);
			if (!id) {
				if (!allocate) return [];
				id = `b${String(this.nextId++).padStart(3, "0")}`;
				this.ids.set(key, id);
			}
			return [{ ...block, id }];
		});
	}
}

/** Constant-sized discovery hint for sessions that have left goal mode. */
export function formatGoalArchiveCatalog(archives: ReadonlyMap<string, GoalArchive>): string {
	return archives.size === 0
		? "No archived context."
		: 'Archived context is available. Use query_block with query="*" and omit archive_id to discover archives.';
}

/** Format runtime metadata without exposing internal token or storage statistics. */
export function formatGoalUsageNote(budget: GoalBudget): string {
	const percentage = Number.isFinite(budget.usage) ? Math.floor(budget.usage * 100) : 100;
	return [`Context usage: approximately ${percentage}%.`, budget.nudge].filter(Boolean).join("\n");
}

/** Validate the entire range, including protected gaps between its endpoints. */
export function validateGoalSelection(blocks: readonly GoalBlock[], startId: string, endId: string): boolean {
	return goalSelectionError(blocks, startId, endId) === undefined;
}

/** Explain the first violated constraint without weakening the selection check. */
export function goalSelectionError(blocks: readonly GoalBlock[], startId: string, endId: string): string | undefined {
	if (!/^b\d{3,}$/.test(startId) || !/^b\d{3,}$/.test(endId))
		return "Invalid block boundary. Use complete runtime block IDs such as b001, without offsets or archive IDs.";
	const start = blocks.findIndex((block) => block.id === startId);
	const end = blocks.findIndex((block) => block.id === endId);
	if (start < 0 || end < 0)
		return `Unknown or stale block ID: ${start < 0 ? startId : endId}. Select current runtime markers.`;
	if (end < start) return "Reversed block range. start_id must precede or equal end_id in context order.";
	const protectedBlock = blocks.slice(start, end + 1).find((block) => block.protected);
	if (protectedBlock)
		return `Protected block ${protectedBlock.id} lies inside the selected range. Do not include or cross it.`;
	return undefined;
}

/** Offer the oldest eligible run; callers still revalidate against the next snapshot. */
export function goalSelectionGuidance(blocks: readonly GoalBlock[]): string {
	const start = blocks.findIndex((block) => !block.protected);
	if (start < 0) return "No eligible range is currently available. Continue the task before trying again.";
	let end = start;
	while (end + 1 < blocks.length && !blocks[end + 1].protected) end++;
	return `Eligible range: ${JSON.stringify({ start_id: blocks[start].id, end_id: blocks[end].id })}. Recheck current markers before retrying; eligibility can change.`;
}
