import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	computeHarnessVersion,
	HARNESS_VERSION_SCHEMA_VERSION,
	type HarnessStateStore,
	type HarnessVersion,
	type HarnessVersionBundle,
	type HarnessVersionMetadata,
} from "@earendil-works/diffex-harness-state";
import type {
	EvolutionMemoryAddDelta,
	EvolutionMemoryExactDiff,
	EvolutionMemoryItem,
	EvolutionMemoryWriteOutput,
	EvolutionMutation,
	HarnessActivationResult,
	ImmutableHarnessSnapshot,
	MutationBatch,
	MutationWriteResult,
} from "./contracts.ts";
import { EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION } from "./contracts.ts";
import { EvolutionExecutionError } from "./errors.ts";
import {
	evolutionMemoryLessonBody,
	evolutionMemoryLessonNumber,
	numberEvolutionMemoryLesson,
} from "./evolution-memory-lessons.ts";
import { computeEvolutionContentDigest, serializeEvolutionValue } from "./provenance.ts";
import type { EvolutionTargetWriter } from "./targets.ts";

const CATALOG_SCHEMA_VERSION = 1 as const;
const CANDIDATE_SCHEMA_VERSION = 2 as const;
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024;
const VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SECRET_PATTERNS = [
	/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
	/\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_+./=-]{16,}/i,
] as const;

interface MarkdownLine {
	readonly start: number;
	readonly end: number;
	readonly contentEnd: number;
	readonly text: string;
}

interface MarkdownHeading {
	readonly level: number;
	readonly title: string;
	readonly start: number;
	readonly end: number;
}

interface MarkdownMemoryBlock {
	readonly start: number;
	readonly end: number;
	readonly content: string;
	readonly section: string | null;
}

interface ParsedEvolutionMemory {
	readonly headings: readonly MarkdownHeading[];
	readonly blocks: readonly MarkdownMemoryBlock[];
}

export interface EvolutionMemoryBlock {
	readonly content: string;
	readonly section: string | null;
}

interface StoredEvolutionMemoryCatalog {
	readonly schemaVersion: typeof CATALOG_SCHEMA_VERSION;
	readonly harnessVersion: HarnessVersion;
	readonly baseVersion: HarnessVersion | null;
	readonly memoryContentDigest: string;
	readonly items: readonly EvolutionMemoryItem[];
	readonly activeOrder: readonly string[];
}

interface StoredEvolutionMemoryCandidate {
	readonly schemaVersion: typeof CANDIDATE_SCHEMA_VERSION;
	readonly writerVersion: string;
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly batchId: string;
	readonly batchHash: string;
	readonly expectedBaseVersion: HarnessVersion;
	readonly expectedBaseDigest: string;
	readonly resultingHarnessVersion: HarnessVersion;
	readonly resultingMemoryDigest: string;
	readonly harnessMetadata: HarnessVersionMetadata;
	readonly operationIds: readonly string[];
	readonly beforeMemory: string;
	readonly afterMemory: string;
	readonly diff: EvolutionMemoryExactDiff;
	readonly catalog: StoredEvolutionMemoryCatalog;
}

export interface EvolutionMemoryWriterOptions {
	readonly version: string;
	readonly harnessState: HarnessStateStore;
	readonly statePath: string;
	readonly maxMemoryBytes?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function markdownLines(memory: string): readonly MarkdownLine[] {
	const lines: MarkdownLine[] = [];
	let start = 0;
	while (start < memory.length) {
		const newline = memory.indexOf("\n", start);
		const end = newline === -1 ? memory.length : newline + 1;
		let contentEnd = newline === -1 ? memory.length : newline;
		if (contentEnd > start && memory[contentEnd - 1] === "\r") contentEnd -= 1;
		lines.push({ start, end, contentEnd, text: memory.slice(start, contentEnd) });
		start = end;
	}
	return lines;
}

function headingFromLine(line: MarkdownLine): MarkdownHeading | null {
	const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line.text);
	if (match === null) return null;
	return {
		level: match[1]?.length ?? 0,
		title: match[2] ?? "",
		start: line.start,
		end: line.end,
	};
}

function isTopLevelListItem(line: MarkdownLine): boolean {
	return /^(?: {0,3})(?:[-+*]|\d+[.)])[ \t]+\S/.test(line.text);
}

function isIndented(line: MarkdownLine): boolean {
	return /^(?: {2,}|\t)/.test(line.text);
}

function fenceMarker(line: MarkdownLine): string | null {
	const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line.text);
	return match?.[1] ?? null;
}

function parseEvolutionMemory(memory: string): ParsedEvolutionMemory {
	if (memory.startsWith("\uFEFF")) throw new Error("EVOLVE.md must not start with a UTF-8 BOM");
	if (memory.includes("\u0000")) throw new Error("EVOLVE.md must not contain NUL bytes");
	const lines = markdownLines(memory);
	const headings: MarkdownHeading[] = [];
	const blocks: MarkdownMemoryBlock[] = [];
	let section: string | null = null;
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] as MarkdownLine;
		if (line.text.trim() === "") {
			index += 1;
			continue;
		}
		const heading = headingFromLine(line);
		if (heading !== null) {
			headings.push(heading);
			section = heading.title;
			index += 1;
			continue;
		}

		const start = line.start;
		let lastContentLine = line;
		const openingFence = fenceMarker(line);
		if (openingFence !== null) {
			const fenceCharacter = openingFence[0] as string;
			const minimumLength = openingFence.length;
			let closed = false;
			index += 1;
			while (index < lines.length) {
				const candidate = lines[index] as MarkdownLine;
				lastContentLine = candidate;
				index += 1;
				const closing = fenceMarker(candidate);
				if (
					closing !== null &&
					closing[0] === fenceCharacter &&
					closing.length >= minimumLength &&
					candidate.text.trim().replaceAll(fenceCharacter, "") === ""
				) {
					closed = true;
					break;
				}
			}
			if (!closed) throw new Error("EVOLVE.md contains an unclosed fenced code block");
		} else if (isTopLevelListItem(line)) {
			index += 1;
			while (index < lines.length) {
				const candidate = lines[index] as MarkdownLine;
				if (headingFromLine(candidate) !== null || isTopLevelListItem(candidate)) break;
				if (candidate.text.trim() === "") {
					const next = lines[index + 1];
					if (
						next === undefined ||
						headingFromLine(next) !== null ||
						isTopLevelListItem(next) ||
						(next.text.trim() !== "" && !isIndented(next))
					) {
						break;
					}
					index += 1;
					continue;
				}
				lastContentLine = candidate;
				index += 1;
			}
		} else {
			index += 1;
			while (index < lines.length) {
				const candidate = lines[index] as MarkdownLine;
				if (candidate.text.trim() === "" || headingFromLine(candidate) !== null) break;
				lastContentLine = candidate;
				index += 1;
			}
		}
		blocks.push({
			start,
			end: lastContentLine.contentEnd,
			content: memory.slice(start, lastContentLine.contentEnd),
			section,
		});
	}
	return { headings, blocks };
}

export function parseEvolutionMemoryBlocks(memory: string): readonly EvolutionMemoryBlock[] {
	return parseEvolutionMemory(memory).blocks.map((block) => ({ content: block.content, section: block.section }));
}

function validateParsedMemory(memory: string, parsed: ParsedEvolutionMemory, maxMemoryBytes: number): void {
	if (Buffer.byteLength(memory, "utf8") > maxMemoryBytes) {
		throw new Error(`EVOLVE.md exceeds the ${maxMemoryBytes}-byte size limit`);
	}
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(memory)) throw new Error("EVOLVE.md candidate violates the sensitive-data policy");
	}
	const normalizedItems = new Set<string>();
	for (const block of parsed.blocks) {
		const normalized = normalizedText(evolutionMemoryLessonBody(block.content));
		if (normalized === "") throw new Error("EVOLVE.md contains an empty memory item");
		if (normalizedItems.has(normalized)) throw new Error("EVOLVE.md contains duplicate normalized memory items");
		normalizedItems.add(normalized);
	}
}

function exactDiff(before: string, after: string): EvolutionMemoryExactDiff {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	return {
		start,
		removed: before.slice(start, beforeEnd),
		added: after.slice(start, afterEnd),
	} as EvolutionMemoryExactDiff;
}

function applyExactDiff(before: string, diff: EvolutionMemoryExactDiff): string {
	if (before.slice(diff.start, diff.start + diff.removed.length) !== diff.removed) {
		throw new Error("Stored EVOLVE.md diff does not match its base");
	}
	return `${before.slice(0, diff.start)}${diff.added}${before.slice(diff.start + diff.removed.length)}`;
}

function memoryArtifactContentHash(memory: string): HarnessVersion {
	return `sha256:${createHash("sha256").update(memory, "utf8").digest("hex")}`;
}

function resultingHarnessVersion(
	memory: string,
	base: HarnessVersion,
	metadata: HarnessVersionMetadata,
): HarnessVersion {
	return computeHarnessVersion({
		schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
		base,
		metadata,
		artifacts: [{ kind: "evolution-memory", path: "EVOLVE.md", contentHash: memoryArtifactContentHash(memory) }],
	});
}

function assertSafeId(value: string, description: string): void {
	if (!SAFE_ID_PATTERN.test(value)) throw new Error(`Invalid ${description} "${value}"`);
}

function assertUnique(values: readonly string[], description: string): void {
	if (new Set(values).size !== values.length) throw new Error(`Duplicate ${description}`);
}

function assertWriterContext(context: { readonly lease: { readonly kind: string; readonly key: string } }): void {
	if (context.lease.kind !== "writer" || context.lease.key !== "global") {
		throw new Error("Evolution memory mutations require the global writer lease");
	}
}

function itemDigest(content: string): string {
	return computeEvolutionContentDigest(content);
}

function itemById(items: readonly EvolutionMemoryItem[], memoryItemId: string): EvolutionMemoryItem {
	const item = items.find((candidate) => candidate.memoryItemId === memoryItemId);
	if (item === undefined) throw new Error(`Unknown evolution memory item "${memoryItemId}"`);
	return item;
}

function activeItems(catalog: StoredEvolutionMemoryCatalog): readonly EvolutionMemoryItem[] {
	return catalog.activeOrder.map((memoryItemId) => itemById(catalog.items, memoryItemId));
}

function sameMemoryItems(left: readonly EvolutionMemoryItem[], right: readonly EvolutionMemoryItem[]): boolean {
	return serializeEvolutionValue(left) === serializeEvolutionValue(right);
}

function validateCatalog(catalog: StoredEvolutionMemoryCatalog, bundle: HarnessVersionBundle): ParsedEvolutionMemory {
	if (
		catalog.schemaVersion !== CATALOG_SCHEMA_VERSION ||
		catalog.harnessVersion !== bundle.manifest.version ||
		catalog.baseVersion !== bundle.manifest.base ||
		catalog.memoryContentDigest !== computeEvolutionContentDigest(bundle.state.memory)
	) {
		throw new Error(`Evolution memory catalog for ${bundle.manifest.version} does not match its harness revision`);
	}
	assertUnique(
		catalog.items.map((item) => item.memoryItemId),
		"memory item ID in catalog",
	);
	assertUnique(catalog.activeOrder, "active memory item ID in catalog");
	const parsed = parseEvolutionMemory(bundle.state.memory);
	const currentItems = activeItems(catalog);
	if (
		currentItems.length !== parsed.blocks.length ||
		currentItems.some(
			(item, index) =>
				item.supersessionRevision !== null ||
				item.contentDigest !== itemDigest(parsed.blocks[index]?.content ?? ""),
		)
	) {
		throw new Error(`Evolution memory catalog for ${bundle.manifest.version} has a stale item index`);
	}
	return parsed;
}

function outputForCandidate(candidate: StoredEvolutionMemoryCandidate): EvolutionMemoryWriteOutput {
	return {
		candidateId: candidate.candidateId,
		candidateDigest: candidate.candidateDigest,
		batchHash: candidate.batchHash,
		expectedBaseVersion: candidate.expectedBaseVersion,
		expectedBaseDigest: candidate.expectedBaseDigest,
		resultingHarnessVersion: candidate.resultingHarnessVersion,
		resultingMemoryDigest: candidate.resultingMemoryDigest,
		operationIds: candidate.operationIds,
		diff: candidate.diff,
	};
}

function contentWithoutMetadata(batch: MutationBatch): Omit<MutationBatch, "metadata"> {
	const { metadata: _metadata, ...content } = batch;
	return content;
}

function insertionOffset(
	memory: string,
	parsed: ParsedEvolutionMemory,
	delta: EvolutionMemoryAddDelta,
	bootstrappingBlankMemory: boolean,
): number {
	if (bootstrappingBlankMemory) return parsed.blocks.at(-1)?.end ?? memory.trimEnd().length;
	if (delta.destination.anchor !== null) {
		const matchingBlocks = parsed.blocks.filter(
			(block) =>
				block.content === delta.destination.anchor ||
				normalizedText(block.content) === normalizedText(delta.destination.anchor ?? "") ||
				normalizedText(evolutionMemoryLessonBody(block.content)) ===
					normalizedText(evolutionMemoryLessonBody(delta.destination.anchor ?? "")),
		);
		if (matchingBlocks.length !== 1) throw new Error("EVOLVE.md addition anchor must match exactly one memory item");
		const block = matchingBlocks[0] as MarkdownMemoryBlock;
		if (delta.destination.section !== null && block.section !== delta.destination.section) {
			throw new Error(`EVOLVE.md addition anchor is outside section "${delta.destination.section}"`);
		}
		return block.end;
	}
	if (delta.destination.section === null) return parsed.blocks.at(-1)?.end ?? memory.trimEnd().length;
	const headings = parsed.headings.filter((heading) => heading.title === delta.destination.section);
	if (headings.length !== 1)
		throw new Error(`EVOLVE.md section "${delta.destination.section}" must exist exactly once`);
	const sectionBlocks = parsed.blocks.filter((block) => block.section === delta.destination.section);
	return sectionBlocks.at(-1)?.end ?? (headings[0] as MarkdownHeading).end;
}

function insertMemory(memory: string, offset: number, content: string): string {
	if (content.trim() !== content || content.includes("\r")) {
		throw new Error("EVOLVE.md additions must not contain leading, trailing, or carriage-return whitespace");
	}
	const before = memory.slice(0, offset);
	const after = memory.slice(offset);
	const prefix = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
	const suffix =
		after.length === 0
			? "\n"
			: after.trim() === "" || after.startsWith("\n\n")
				? ""
				: after.startsWith("\n")
					? "\n"
					: "\n\n";
	return `${before}${prefix}${content}${suffix}${after}`;
}

function removeMemoryBlock(memory: string, block: MarkdownMemoryBlock): string {
	let start = block.start;
	let end = block.end;
	while (end < memory.length && (memory[end] === "\n" || memory[end] === "\r")) end += 1;
	if (end === block.end) {
		while (start > 0 && (memory[start - 1] === "\n" || memory[start - 1] === "\r")) start -= 1;
	}
	return `${memory.slice(0, start)}${memory.slice(end)}`;
}

function compactLessonNumbers(memory: string, removedLessonNumber: number): string {
	let compacted = memory;
	for (const block of [...parseEvolutionMemory(memory).blocks].reverse()) {
		const lessonNumber = evolutionMemoryLessonNumber(block.content);
		if (lessonNumber === null || lessonNumber <= removedLessonNumber) continue;
		const content = numberEvolutionMemoryLesson(block.content, lessonNumber - 1);
		compacted = `${compacted.slice(0, block.start)}${content}${compacted.slice(block.end)}`;
	}
	return compacted;
}

function parseWriteOutput(result: MutationWriteResult): EvolutionMemoryWriteOutput {
	const output = result.output;
	if (
		result.status !== "written" ||
		!isRecord(output) ||
		typeof output.candidateId !== "string" ||
		typeof output.candidateDigest !== "string" ||
		typeof output.batchHash !== "string" ||
		typeof output.expectedBaseVersion !== "string" ||
		typeof output.expectedBaseDigest !== "string" ||
		typeof output.resultingHarnessVersion !== "string" ||
		typeof output.resultingMemoryDigest !== "string" ||
		!Array.isArray(output.operationIds) ||
		!isRecord(output.diff)
	) {
		throw new Error("Evolution memory write receipt is invalid");
	}
	return output as EvolutionMemoryWriteOutput;
}

export class EvolutionMemoryWriter implements EvolutionTargetWriter {
	readonly kind = "evolution-memory" as const;
	readonly #version: string;
	readonly #harnessState: HarnessStateStore;
	readonly #statePath: string;
	readonly #catalogPath: string;
	readonly #candidatePath: string;
	readonly #maxMemoryBytes: number;

	constructor(options: EvolutionMemoryWriterOptions) {
		if (options.version.trim() === "") throw new Error("Evolution memory writer version must be non-empty");
		if (
			!Number.isSafeInteger(options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES) ||
			(options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES) < 1
		) {
			throw new Error("maxMemoryBytes must be a positive integer");
		}
		this.#version = options.version;
		this.#harnessState = options.harnessState;
		this.#statePath = resolve(options.statePath);
		this.#catalogPath = join(this.#statePath, "catalogs");
		this.#candidatePath = join(this.#statePath, "candidates");
		this.#maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
	}

	async #ensureDirectories(): Promise<void> {
		await mkdir(this.#catalogPath, { recursive: true, mode: 0o700 });
		await mkdir(this.#candidatePath, { recursive: true, mode: 0o700 });
	}

	#catalogFile(version: HarnessVersion): string {
		if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid harness version "${version}"`);
		return join(this.#catalogPath, `${version.replace("sha256:", "sha256-")}.json`);
	}

	#candidateFile(batchId: string): string {
		assertSafeId(batchId, "mutation batch ID");
		return join(this.#candidatePath, `${batchId}.json`);
	}

	async #readOptional(path: string): Promise<string | null> {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		}
	}

	async #writeImmutable(path: string, value: unknown): Promise<void> {
		await this.#ensureDirectories();
		const serialized = `${serializeEvolutionValue(value)}\n`;
		const existing = await this.#readOptional(path);
		if (existing !== null) {
			if (existing !== serialized) throw new Error(`Immutable evolution metadata at "${path}" changed`);
			return;
		}
		const temporaryDirectory: string | null = await mkdtemp(join(dirname(path), `.${basename(path)}.tmp-`));
		try {
			const temporaryFile = join(temporaryDirectory, basename(path));
			await writeFile(temporaryFile, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
			try {
				await link(temporaryFile, path);
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
				const raced = await this.#readOptional(path);
				if (raced !== serialized) throw new Error(`Immutable evolution metadata race at "${path}" changed`);
			}
		} finally {
			if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	async #loadCatalog(bundle: HarnessVersionBundle): Promise<StoredEvolutionMemoryCatalog> {
		await this.#ensureDirectories();
		const path = this.#catalogFile(bundle.manifest.version);
		const contents = await this.#readOptional(path);
		if (contents !== null) {
			const parsed: unknown = JSON.parse(contents);
			if (!isRecord(parsed) || !Array.isArray(parsed.items) || !Array.isArray(parsed.activeOrder)) {
				throw new Error(`Evolution memory catalog at "${path}" is invalid`);
			}
			const catalog = parsed as unknown as StoredEvolutionMemoryCatalog;
			validateCatalog(catalog, bundle);
			return catalog;
		}
		const memory = parseEvolutionMemory(bundle.state.memory);
		validateParsedMemory(bundle.state.memory, memory, this.#maxMemoryBytes);
		const items = memory.blocks.map(
			(block): EvolutionMemoryItem => ({
				schemaVersion: EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION,
				memoryItemId: `memory-item-${randomUUID()}`,
				contentDigest: itemDigest(block.content),
				creationRevision: bundle.manifest.version,
				supersessionRevision: null,
				ledger: { origin: "manual", creationEventId: null, supersessionEventId: null },
			}),
		);
		const catalog: StoredEvolutionMemoryCatalog = {
			schemaVersion: CATALOG_SCHEMA_VERSION,
			harnessVersion: bundle.manifest.version,
			baseVersion: bundle.manifest.base,
			memoryContentDigest: computeEvolutionContentDigest(bundle.state.memory),
			items,
			activeOrder: items.map((item) => item.memoryItemId),
		};
		try {
			await this.#writeImmutable(path, catalog);
			return catalog;
		} catch (error) {
			const raced = await this.#readOptional(path);
			if (raced === null) throw error;
			const parsed = JSON.parse(raced) as StoredEvolutionMemoryCatalog;
			validateCatalog(parsed, bundle);
			return parsed;
		}
	}

	async loadActiveMemoryItems(bundle: HarnessVersionBundle): Promise<readonly EvolutionMemoryItem[]> {
		return activeItems(await this.#loadCatalog(bundle));
	}

	async #loadCandidate(batchId: string): Promise<StoredEvolutionMemoryCandidate | null> {
		const contents = await this.#readOptional(this.#candidateFile(batchId));
		if (contents === null) return null;
		const parsed: unknown = JSON.parse(contents);
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== CANDIDATE_SCHEMA_VERSION ||
			typeof parsed.writerVersion !== "string" ||
			parsed.batchId !== batchId ||
			typeof parsed.candidateDigest !== "string" ||
			!isRecord(parsed.harnessMetadata) ||
			!isRecord(parsed.harnessMetadata.evolutionMemory) ||
			typeof parsed.harnessMetadata.evolutionMemory.nextLessonNumber !== "number" ||
			!Number.isSafeInteger(parsed.harnessMetadata.evolutionMemory.nextLessonNumber) ||
			parsed.harnessMetadata.evolutionMemory.nextLessonNumber < 1 ||
			!isRecord(parsed.catalog)
		) {
			throw new Error(`Evolution memory candidate for "${batchId}" is invalid`);
		}
		const candidate = parsed as unknown as StoredEvolutionMemoryCandidate;
		const { candidateDigest: _candidateDigest, ...content } = candidate;
		if (candidate.candidateDigest !== computeEvolutionContentDigest(content)) {
			throw new Error(`Evolution memory candidate for "${batchId}" has an invalid digest`);
		}
		if (applyExactDiff(candidate.beforeMemory, candidate.diff) !== candidate.afterMemory) {
			throw new Error(`Evolution memory candidate for "${batchId}" has an invalid exact diff`);
		}
		return candidate;
	}

	async captureSnapshot(version?: HarnessVersion): Promise<ImmutableHarnessSnapshot> {
		const bundle =
			version === undefined ? await this.#harnessState.loadCurrent() : await this.#harnessState.loadVersion(version);
		const catalog = await this.#loadCatalog(bundle);
		return {
			harnessVersion: bundle.manifest.version,
			baseVersion: bundle.manifest.base,
			memory: bundle.state.memory,
			memoryContentDigest: catalog.memoryContentDigest,
			activeMemoryItems: activeItems(catalog),
		};
	}

	async write(
		batch: MutationBatch,
		context: Parameters<EvolutionTargetWriter["write"]>[1],
	): Promise<MutationWriteResult> {
		context.signal?.throwIfAborted();
		assertWriterContext(context);
		if (batch.targetKind !== this.kind || batch.mutations.length === 0) {
			throw new Error("Evolution memory writer requires a non-empty evolution-memory batch");
		}
		assertSafeId(batch.batchId, "mutation batch ID");
		assertSafeId(batch.activationEventId, "activation ledger event ID");
		assertUnique(
			batch.mutations.map((mutation) => mutation.mutationId),
			"mutation operation ID",
		);
		assertUnique(
			batch.mutations.map((mutation) => mutation.proposalId),
			"mutation proposal ID",
		);
		if (batch.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(batch))) {
			throw new Error(`Mutation batch "${batch.batchId}" metadata digest is invalid`);
		}
		const batchHash = computeEvolutionContentDigest(batch);
		const priorCandidate = await this.#loadCandidate(batch.batchId);
		if (priorCandidate !== null) {
			if (priorCandidate.batchHash !== batchHash) {
				throw new Error(`Mutation batch "${batch.batchId}" was already staged with different content`);
			}
			return {
				batchId: batch.batchId,
				status: "written",
				output: outputForCandidate(priorCandidate),
				message: null,
			};
		}

		const base = await this.#harnessState.loadVersion(batch.expectedBaseVersion);
		const baseDigest = computeEvolutionContentDigest(base.state.memory);
		if (baseDigest !== batch.expectedBaseDigest) {
			throw new EvolutionExecutionError("Frozen harness memory no longer matches its content digest", {
				reasonCode: "harness-base-conflict",
				retryable: false,
			});
		}
		const baseCatalog = await this.#loadCatalog(base);
		if (!sameMemoryItems(activeItems(baseCatalog), batch.baseMemoryItems)) {
			throw new EvolutionExecutionError("Harness memory item catalog changed before writing", {
				reasonCode: "harness-base-conflict",
				retryable: false,
			});
		}

		let memory = base.state.memory;
		const bootstrappingBlankMemory = memory.trim() === "";
		let items = [...baseCatalog.items];
		const activeOrder = [...baseCatalog.activeOrder];
		const existingLessonNumbers = parseEvolutionMemory(memory)
			.blocks.flatMap((block) => {
				const lessonNumber = evolutionMemoryLessonNumber(block.content);
				return lessonNumber === null ? [] : [lessonNumber];
			})
			.sort((left, right) => left - right);
		const visibleNextLessonNumber = existingLessonNumbers.length + 1;
		const durableNextLessonNumber = base.manifest.metadata.evolutionMemory.nextLessonNumber;
		if (
			existingLessonNumbers.some((lessonNumber, index) => lessonNumber !== index + 1) ||
			durableNextLessonNumber !== visibleNextLessonNumber
		) {
			throw new Error("Harness lesson-number metadata does not match EVOLVE.md content");
		}
		let nextLessonNumber = durableNextLessonNumber;
		const addedIds = new Set<string>();
		const removedIds = new Set<string>();
		const remove = (memoryItemId: string, expectedContentDigest: string): void => {
			const activeIndex = activeOrder.indexOf(memoryItemId);
			if (activeIndex === -1) throw new Error(`Mutation removes inactive memory item "${memoryItemId}"`);
			const parsed = parseEvolutionMemory(memory);
			const block = parsed.blocks[activeIndex];
			const item = itemById(items, memoryItemId);
			const baseItem = itemById(baseCatalog.items, memoryItemId);
			const removedLessonNumber = block === undefined ? null : evolutionMemoryLessonNumber(block.content);
			if (
				block === undefined ||
				removedLessonNumber === null ||
				baseItem.contentDigest !== expectedContentDigest ||
				itemDigest(block.content) !== item.contentDigest ||
				item.ledger.origin !== "evolution"
			) {
				throw new Error(`Mutation cannot automatically remove memory item "${memoryItemId}"`);
			}
			memory = compactLessonNumbers(removeMemoryBlock(memory, block), removedLessonNumber);
			activeOrder.splice(activeIndex, 1);
			const compactedBlocks = parseEvolutionMemory(memory).blocks;
			const activeDigests = new Map(
				activeOrder.map((activeMemoryItemId, index) => [
					activeMemoryItemId,
					itemDigest(compactedBlocks[index]?.content ?? ""),
				]),
			);
			items = items.map((candidate) => {
				const contentDigest = activeDigests.get(candidate.memoryItemId);
				return contentDigest === undefined ? candidate : { ...candidate, contentDigest };
			});
			nextLessonNumber -= 1;
			removedIds.add(memoryItemId);
		};
		const add = (mutation: EvolutionMutation, delta: EvolutionMemoryAddDelta): void => {
			const addition = parseEvolutionMemory(delta.content);
			if (
				addition.headings.length > 0 ||
				addition.blocks.length !== 1 ||
				addition.blocks[0]?.content !== delta.content
			) {
				throw new Error("Each EVOLVE.md addition must contain exactly one non-heading memory item");
			}
			const numberedContent = numberEvolutionMemoryLesson(delta.content, nextLessonNumber);
			nextLessonNumber += 1;
			const parsed = parseEvolutionMemory(memory);
			const offset = insertionOffset(memory, parsed, delta, bootstrappingBlankMemory);
			const insertionIndex = parsed.blocks.filter((block) => block.end <= offset).length;
			memory = insertMemory(memory, offset, numberedContent);
			const memoryItemId = `memory-item-${createHash("sha256").update(mutation.mutationId).digest("hex").slice(0, 32)}`;
			if (items.some((item) => item.memoryItemId === memoryItemId)) {
				throw new Error(`Mutation reuses memory item ID "${memoryItemId}"`);
			}
			items.push({
				schemaVersion: EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION,
				memoryItemId,
				contentDigest: itemDigest(numberedContent),
				creationRevision: batch.expectedBaseVersion,
				supersessionRevision: null,
				ledger: {
					origin: "evolution",
					creationEventId: batch.activationEventId,
					supersessionEventId: null,
				},
			});
			activeOrder.splice(insertionIndex, 0, memoryItemId);
			addedIds.add(memoryItemId);
		};

		for (const mutation of batch.mutations) {
			if (
				mutation.target.kind !== this.kind ||
				mutation.target.expectedHarnessVersion !== batch.expectedBaseVersion
			) {
				throw new Error(`Mutation "${mutation.mutationId}" targets an unsupported or stale harness`);
			}
			if (mutation.payload.operation === "ADD") add(mutation, mutation.payload);
			if (mutation.payload.operation === "REMOVE") {
				remove(mutation.payload.memoryItemId, mutation.payload.expectedContentDigest);
			}
			if (mutation.payload.operation === "REPLACE") {
				remove(mutation.payload.removal.memoryItemId, mutation.payload.removal.expectedContentDigest);
				add(mutation, { operation: "ADD", ...mutation.payload.addition });
			}
		}
		const parsedCandidate = parseEvolutionMemory(memory);
		validateParsedMemory(memory, parsedCandidate, this.#maxMemoryBytes);
		if (
			parsedCandidate.blocks.length !== activeOrder.length ||
			parsedCandidate.blocks.some(
				(block, index) => itemById(items, activeOrder[index] as string).contentDigest !== itemDigest(block.content),
			)
		) {
			throw new Error("EVOLVE.md candidate item index is inconsistent after applying mutations");
		}
		const harnessMetadata: HarnessVersionMetadata = { evolutionMemory: { nextLessonNumber } };
		const nextVersion = resultingHarnessVersion(memory, batch.expectedBaseVersion, harnessMetadata);
		items = items.map((item) => {
			if (addedIds.has(item.memoryItemId)) return { ...item, creationRevision: nextVersion };
			if (removedIds.has(item.memoryItemId)) {
				return {
					...item,
					supersessionRevision: nextVersion,
					ledger: { ...item.ledger, supersessionEventId: batch.activationEventId },
				};
			}
			return item;
		});
		const catalog: StoredEvolutionMemoryCatalog = {
			schemaVersion: CATALOG_SCHEMA_VERSION,
			harnessVersion: nextVersion,
			baseVersion: batch.expectedBaseVersion,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			items,
			activeOrder,
		};
		const candidateContent = {
			schemaVersion: CANDIDATE_SCHEMA_VERSION,
			writerVersion: this.#version,
			candidateId: `candidate-${batch.batchId}`,
			batchId: batch.batchId,
			batchHash,
			expectedBaseVersion: batch.expectedBaseVersion,
			expectedBaseDigest: batch.expectedBaseDigest,
			resultingHarnessVersion: nextVersion,
			resultingMemoryDigest: catalog.memoryContentDigest,
			harnessMetadata,
			operationIds: batch.mutations.map((mutation) => mutation.mutationId),
			beforeMemory: base.state.memory,
			afterMemory: memory,
			diff: exactDiff(base.state.memory, memory),
			catalog,
		};
		const candidate: StoredEvolutionMemoryCandidate = {
			...candidateContent,
			candidateDigest: computeEvolutionContentDigest(candidateContent),
		};
		await this.#writeImmutable(this.#candidateFile(batch.batchId), candidate);
		return { batchId: batch.batchId, status: "written", output: outputForCandidate(candidate), message: null };
	}

	async activate(
		batch: MutationBatch,
		writeResult: MutationWriteResult,
		context: Parameters<EvolutionTargetWriter["activate"]>[2],
	): Promise<HarnessActivationResult> {
		context.signal?.throwIfAborted();
		assertWriterContext(context);
		const output = parseWriteOutput(writeResult);
		const candidate = await this.#loadCandidate(batch.batchId);
		if (
			writeResult.batchId !== batch.batchId ||
			candidate === null ||
			candidate.candidateId !== output.candidateId ||
			candidate.candidateDigest !== output.candidateDigest ||
			candidate.batchHash !== computeEvolutionContentDigest(batch) ||
			candidate.batchHash !== output.batchHash ||
			serializeEvolutionValue(output) !== serializeEvolutionValue(outputForCandidate(candidate))
		) {
			throw new Error(`Mutation batch "${batch.batchId}" write receipt does not match its durable candidate`);
		}
		await this.#writeImmutable(this.#catalogFile(candidate.resultingHarnessVersion), candidate.catalog);
		const evolved = await this.#harnessState.saveVersion(
			{ memory: candidate.afterMemory },
			candidate.expectedBaseVersion,
			candidate.harnessMetadata,
		);
		if (
			evolved.manifest.version !== candidate.resultingHarnessVersion ||
			evolved.manifest.base !== candidate.expectedBaseVersion ||
			evolved.state.memory !== candidate.afterMemory ||
			serializeEvolutionValue(evolved.manifest.metadata) !== serializeEvolutionValue(candidate.harnessMetadata)
		) {
			throw new Error(`Harness activation for batch "${batch.batchId}" produced an unexpected revision`);
		}
		await this.#harnessState.selectVersionIfCurrent(evolved.manifest.version, candidate.expectedBaseVersion);
		return {
			batchId: batch.batchId,
			status: "activated",
			resultingHarnessVersion: evolved.manifest.version,
			message: null,
		};
	}
}
