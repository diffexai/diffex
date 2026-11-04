import type { ImageContent } from "@diffexai/diffex-ai";
import { goalEvidence } from "./goal-evidence.ts";
import {
	type GoalArchive,
	goalArchiveFromEntry,
	reachableGoalArchives,
	readGoalArchives,
	validateGoalProvenance,
} from "./pocket-context.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "./session-manager.ts";

const CHUNK_CHARS = 2_400;
const PAGE_CHARS = 6_000;
const SEARCH_CHARS = 6_000;
const MAX_HITS = 8;
const STOP_WORDS = new Set(
	"a an and are as at be by for from how in is it of on or that the this to was what which with".split(" "),
);

function terms(text: string, serializedEvidence = false): string[] {
	// JSON escapes are serialization, not evidence: a newline before receipt739
	// must not turn its indexed identifier into nreceipt739. Decode complete
	// escapes only, preserving literal backslashes and the original page text.
	if (serializedEvidence) {
		text = text.replace(/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/g, (encoded) => JSON.parse(`"${encoded}"`) as string);
	}
	return (
		text
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	).filter((term) => !STOP_WORDS.has(term));
}

export interface GoalArchiveMatch {
	archive: GoalArchive;
	evidence: Array<{ archive_id: string; entry_id: string }>;
}

/** Searchable evidence stays local; discovery returns only bounded source references. */
export class GoalArchiveDiscovery {
	readonly records: readonly GoalArchive[];
	private readonly documents: Array<{ archive: GoalArchive; entryId?: string; length: number }> = [];
	private readonly postings = new Map<string, Map<number, number>>();
	private readonly averageLength: number;

	constructor(entries: readonly SessionEntry[]) {
		const archives = readGoalArchives(entries);
		validateGoalProvenance(entries, archives);
		this.records = [...archives.values()];
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		let totalLength = 0;
		const index = (archive: GoalArchive, text: string, entryId?: string) => {
			const tokens = terms(text, entryId !== undefined);
			const id = this.documents.length;
			this.documents.push({ archive, entryId, length: tokens.length });
			totalLength += tokens.length;
			for (const token of tokens) {
				let posting = this.postings.get(token);
				if (!posting) {
					posting = new Map();
					this.postings.set(token, posting);
				}
				posting.set(id, (posting.get(id) ?? 0) + 1);
			}
		};
		for (const archive of this.records) {
			index(archive, `${archive.archiveId} ${archive.summary}`);
			for (const entryId of archive.entryIds) {
				const entry = byId.get(entryId);
				if (!entry || goalArchiveFromEntry(entry)) continue;
				for (const message of sessionEntryToContextMessages(entry)) {
					const record = goalEvidence(message, []);
					if (record) index(archive, JSON.stringify(record), entryId);
				}
			}
		}
		this.averageLength = Math.max(1, totalLength / Math.max(1, this.documents.length));
	}

	search(query: string): GoalArchiveMatch[] {
		if (!query.trim() || query.length > 2_000) throw new Error("Search query must contain 1 to 2000 characters.");
		if (query.trim() === "*") return this.records.map((archive) => ({ archive, evidence: [] }));
		const scores = new Map<number, number>();
		for (const term of [...new Set(terms(query))].slice(0, 64)) {
			const posting = this.postings.get(term);
			if (!posting) continue;
			const idf = Math.log(1 + (this.documents.length - posting.size + 0.5) / (posting.size + 0.5));
			for (const [id, frequency] of posting) {
				const score =
					(idf * frequency * 2.2) /
					(frequency + 1.2 * (0.25 + (0.75 * this.documents[id].length) / this.averageLength));
				scores.set(id, (scores.get(id) ?? 0) + score);
			}
		}
		const matches = new Map<
			GoalArchive,
			{ summary: number; evidence: number; sources: GoalArchiveMatch["evidence"] }
		>();
		for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
			const document = this.documents[id];
			const match = matches.get(document.archive) ?? { summary: 0, evidence: 0, sources: [] };
			if (document.entryId) {
				match.evidence = Math.max(match.evidence, score);
				if (match.sources.length < 3 && !match.sources.some((source) => source.entry_id === document.entryId))
					match.sources.push({ archive_id: document.archive.archiveId, entry_id: document.entryId });
			} else match.summary = score;
			matches.set(document.archive, match);
		}
		return this.records
			.filter((archive) => matches.has(archive))
			.sort((a, b) => {
				const left = matches.get(a)!;
				const right = matches.get(b)!;
				return right.summary + right.evidence - (left.summary + left.evidence);
			})
			.map((archive) => ({ archive, evidence: matches.get(archive)!.sources }));
	}
}

interface EvidenceImage {
	offset: number;
	image: ImageContent;
}

interface ArchiveEvidence {
	text: string;
	images: EvidenceImage[];
	chunks: EvidenceChunk[];
}

interface EvidenceChunk {
	id: string;
	archiveId: string;
	entryId: string;
	start: number;
	end: number;
	length: number;
}

export interface RecallSearchHit {
	archive_id: string;
	chunk_id: string;
	entry_id: string;
	excerpt: string;
	context_before: boolean;
	context_after: boolean;
}

export interface RecallRetrievalResult {
	text: string;
	images: ImageContent[];
}

/** Branch-scoped BM25 index and one shared budget for the entire private recall workflow. */
export class GoalRecallRetrieval {
	readonly root: GoalArchive;
	readonly maxRetrievalChars: number;
	private readonly archives = new Map<string, ArchiveEvidence>();
	private readonly chunks = new Map<string, EvidenceChunk>();
	private readonly postings = new Map<string, Map<string, number>>();
	private readonly missing: string[] = [];
	private readonly visited = new Set<string>();
	private readonly inspected = new Set<string>();
	private readonly inspectedImages = new Set<EvidenceImage>();
	private averageLength = 1;
	private usedChars = 0;
	private limited = false;
	private readonly supportsImages: boolean;

	constructor(entries: readonly SessionEntry[], archiveId: string, availableTokens: number, supportsImages: boolean) {
		const archives = readGoalArchives(entries);
		const root = archives.get(archiveId);
		if (!root) throw new Error(`Archive ${archiveId} is unavailable on this session branch.`);
		this.root = root;
		this.supportsImages = supportsImages;
		const reachable = reachableGoalArchives(archives, archiveId);
		validateGoalProvenance(entries, new Map([...archives].filter(([id]) => reachable.has(id))));
		// Page and search sizes are fixed. Only the cumulative allowance scales, with a hard ceiling.
		this.maxRetrievalChars = Math.max(0, Math.min(256_000, Math.floor(availableTokens * 1.6)));
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		let totalLength = 0;
		for (const id of reachable) {
			const archive = archives.get(id)!;
			const evidence: ArchiveEvidence = { text: "", images: [], chunks: [] };
			for (const entryId of archive.entryIds) {
				const entry = byId.get(entryId);
				if (!entry) {
					this.missing.push(`${id}/${entryId}`);
					continue;
				}
				if (goalArchiveFromEntry(entry)) continue;
				for (const [messageIndex, message] of sessionEntryToContextMessages(entry).entries()) {
					const images: ImageContent[] = [];
					const record = goalEvidence(message, images);
					if (!record) continue;
					const text = `${JSON.stringify({ entry_id: entryId, ...record })}\n`;
					const base = evidence.text.length;
					for (const [index, image] of images.entries()) {
						evidence.images.push({ offset: base + text.indexOf(`"image_index":${index},`), image });
					}
					evidence.text += text;
					for (let start = 0; start < text.length; ) {
						let end = Math.min(text.length, start + CHUNK_CHARS);
						// Keep identifiers and JSON escapes intact, including logs without spaces.
						if (end < text.length) {
							let boundary = start;
							for (const match of text.slice(start, end).matchAll(/[^\p{L}\p{N}\\]/gu)) {
								boundary = start + match.index + match[0].length;
							}
							if (boundary > start) end = boundary;
						}
						const chunk: EvidenceChunk = {
							id: `${id}/${entryId}/${messageIndex}/${start}`,
							archiveId: id,
							entryId,
							start: base + start,
							end: base + end,
							length: 0,
						};
						const tokens = terms(text.slice(start, end), true);
						chunk.length = tokens.length;
						totalLength += tokens.length;
						for (const token of tokens) {
							let posting = this.postings.get(token);
							if (!posting) {
								posting = new Map();
								this.postings.set(token, posting);
							}
							posting.set(chunk.id, (posting.get(chunk.id) ?? 0) + 1);
						}
						evidence.chunks.push(chunk);
						this.chunks.set(chunk.id, chunk);
						start = end;
					}
				}
			}
			this.archives.set(id, evidence);
		}
		this.averageLength = Math.max(1, totalLength / Math.max(1, this.chunks.size));
	}

	get remainingChars(): number {
		return this.maxRetrievalChars - this.usedChars;
	}

	get exhausted(): boolean {
		return this.limited;
	}

	get limitation(): string {
		return [
			this.limited ? "Retrieval budget exhausted; the answer may be incomplete." : "",
			this.inspected.size < this.chunks.size
				? "Only selected evidence was returned; uninspected evidence may affect completeness. Empty search results do not establish absence."
				: "",
			this.missing.length
				? `Missing original evidence: ${this.missing.slice(0, 10).join(", ")}${this.missing.length > 10 ? " (additional entries missing)" : ""}.`
				: "",
			[...this.archives.values()].some((archive) => archive.images.some((image) => !this.inspectedImages.has(image)))
				? this.supportsImages
					? "Some archived images have not been inspected."
					: "Archived images cannot be inspected by this model."
				: "",
		]
			.filter(Boolean)
			.join("\n");
	}

	private receipt(value: object, images: ImageContent[] = []): RecallRetrievalResult {
		const text = JSON.stringify(value);
		// Charge serialized text (including JSON escaping) and a conservative image allowance.
		const size = text.length + images.length * 6_000;
		if (this.limited || size > this.remainingChars) {
			this.limited = true;
			return {
				text: '{"limit_reached":true,"instruction":"Retrieval budget exhausted. Answer with available evidence and report incompleteness."}',
				images: [],
			};
		}
		this.usedChars += size;
		return { text, images };
	}

	search(query: string): RecallRetrievalResult {
		if (!query.trim() || query.length > 2_000) throw new Error("Search query must contain 1 to 2000 characters.");
		const queryTerms = [...new Set(terms(query))].slice(0, 64);
		const scores = new Map<string, number>();
		for (const term of queryTerms) {
			const posting = this.postings.get(term);
			if (!posting) continue;
			const idf = Math.log(1 + (this.chunks.size - posting.size + 0.5) / (posting.size + 0.5));
			for (const [id, frequency] of posting) {
				const chunk = this.chunks.get(id)!;
				const score =
					(idf * (frequency * 2.2)) / (frequency + 1.2 * (0.25 + (0.75 * chunk.length) / this.averageLength));
				scores.set(id, (scores.get(id) ?? 0) + score);
			}
		}
		const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		const hits: RecallSearchHit[] = [];
		const cap = Math.min(SEARCH_CHARS, this.remainingChars);
		for (const [id] of ranked.slice(0, MAX_HITS)) {
			const chunk = this.chunks.get(id)!;
			const evidence = this.archives.get(chunk.archiveId)!;
			const original = evidence.text.slice(chunk.start, chunk.end);
			const match = queryTerms.map((term) => original.toLowerCase().indexOf(term)).filter((offset) => offset >= 0);
			const start = Math.max(0, (match.length ? Math.min(...match) : 0) - 100);
			const hit: RecallSearchHit = {
				archive_id: chunk.archiveId,
				chunk_id: chunk.id,
				entry_id: chunk.entryId,
				excerpt: original.slice(start, start + 400),
				context_before: chunk.start + start > 0,
				context_after: chunk.start + start + 400 < evidence.text.length,
			};
			if (JSON.stringify({ hits: [...hits, hit] }).length + 350 > cap) break;
			hits.push(hit);
		}
		return this.receipt({
			hits,
			more_matches: ranked.length > hits.length,
			total_chunks: this.chunks.size,
			instruction:
				"Use chunk_id with expand_block for original evidence and surrounding context. Browse using an archive ID when search is weak or empty; absence of hits is not absence of evidence.",
		});
	}

	expand(blockId: string, cursor?: string, surroundingChars = 512): RecallRetrievalResult {
		const chunk = this.chunks.get(blockId);
		const archiveId = chunk?.archiveId ?? blockId;
		const data = this.archives.get(archiveId);
		if (!data) throw new Error("Archive or chunk is outside the selected reference graph.");
		if (!Number.isSafeInteger(surroundingChars) || surroundingChars < 0 || surroundingChars > 1_024)
			throw new Error("Invalid surrounding context size.");
		const lower = chunk ? Math.max(0, chunk.start - surroundingChars) : 0;
		const upper = chunk ? Math.min(data.text.length, chunk.end + surroundingChars) : data.text.length;
		const imageCursor = cursor?.match(/^image:(\d+):(\d+)$/);
		const offset = imageCursor ? Number(imageCursor[2]) : cursor === undefined ? lower : Number(cursor);
		const imageIndex = imageCursor ? Number(imageCursor[1]) : 0;
		if (
			!Number.isSafeInteger(offset) ||
			offset < lower ||
			offset > upper ||
			(cursor !== undefined && !imageCursor && !/^\d+$/.test(cursor)) ||
			(imageCursor
				? !Number.isSafeInteger(imageIndex) ||
					imageIndex >= data.images.length ||
					data.images[imageIndex].offset < lower ||
					data.images[imageIndex].offset >= upper
				: offset >= upper && upper > lower)
		) {
			throw new Error("Invalid archive page cursor.");
		}
		const key = `${blockId}:${cursor ?? lower}:${surroundingChars}`;
		if (this.visited.has(key)) return this.receipt({ already_provided: true });
		let end = imageCursor ? offset : Math.min(upper, offset + PAGE_CHARS);
		// Escaped control characters can multiply JSON size; bound the serialized evidence too.
		while (JSON.stringify(data.text.slice(offset, end)).length > PAGE_CHARS) {
			end = offset + Math.floor((end - offset) * 0.8);
		}
		const eligibleImages = this.supportsImages
			? data.images
					.map((image, index) => ({ ...image, index }))
					.filter((image) =>
						imageCursor
							? image.index >= imageIndex && image.offset < end
							: image.offset >= offset && image.offset < end,
					)
			: [];
		const images = eligibleImages.slice(0, 1);
		const nextCursor =
			eligibleImages.length > images.length
				? `image:${eligibleImages[images.length].index}:${end}`
				: end < upper
					? String(end)
					: undefined;
		const included = data.chunks.filter((item) => item.start < end && item.end > offset);
		const value = {
			archive_id: archiveId,
			chunk_id: chunk?.id,
			entry_ids: [...new Set(included.map((item) => item.entryId))],
			evidence: data.text.slice(offset, end),
			start: offset,
			end,
			next_cursor: nextCursor,
			previous_chunk_id: chunk ? data.chunks[data.chunks.indexOf(chunk) - 1]?.id : undefined,
			next_chunk_id: chunk ? data.chunks[data.chunks.indexOf(chunk) + 1]?.id : undefined,
			image_support: this.supportsImages ? "supported" : "Images cannot be inspected by this model.",
		};
		const before = this.usedChars;
		const result = this.receipt(
			value,
			images.map((item) => item.image),
		);
		if (this.usedChars > before) {
			this.visited.add(key);
			for (const item of included) if (offset <= item.start && end >= item.end) this.inspected.add(item.id);
			for (const image of images) this.inspectedImages.add(data.images[image.index]);
		}
		return result;
	}
}
