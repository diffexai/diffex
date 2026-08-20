import type { MaterializedEvidence } from "@earendil-works/diffex-harness-trace";
import type {
	EvidenceCorpusDocument,
	EvidenceCorpusManifest,
	EvidenceSlice,
	EvidenceSliceEdge,
	EvidenceSliceOpenReason,
	EvolutionInputSnapshot,
	JsonObject,
	JsonValue,
} from "./contracts.ts";
import { EvolutionExecutionError } from "./errors.ts";
import type { EvolutionModelTool } from "./ports.ts";
import { computeEvolutionContentDigest, serializeEvolutionValue } from "./provenance.ts";

const TOOL_NAMES = [
	"list_documents",
	"inspect_outline",
	"search_evidence",
	"read_slice",
	"inspect_adjacent",
	"refine_slice",
] as const;

export type ReflectorToolName = (typeof TOOL_NAMES)[number];

export interface ReflectorToolAudit {
	readonly toolCallId: string;
	readonly toolName: ReflectorToolName;
	readonly requestDigest: string;
	readonly requestedSliceId: string | null;
	readonly resolvedEvidenceIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
}

export interface ReflectorToolRegistryOptions {
	readonly jobId: string;
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly maxToolCalls: number;
	readonly signal?: AbortSignal;
	readonly audit: (event: ReflectorToolAudit) => Promise<void>;
}

interface IndexedDocument {
	readonly descriptor: EvidenceCorpusDocument;
	readonly evidence: readonly MaterializedEvidence[];
}

class ReflectorToolDeniedError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ReflectorToolDeniedError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(input: JsonObject, name: string): string {
	const value = input[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new ReflectorToolDeniedError("invalid-request", `${name} must be a non-empty string`);
	}
	return value;
}

function integerField(input: JsonObject, name: string, fallback?: number): number {
	const value = input[name];
	if (value === undefined && fallback !== undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new ReflectorToolDeniedError("invalid-request", `${name} must be a non-negative integer`);
	}
	return value as number;
}

function jsonClone(value: unknown): JsonValue {
	return JSON.parse(serializeEvolutionValue(value)) as JsonValue;
}

function payloadRecord(evidence: MaterializedEvidence): Readonly<Record<string, unknown>> | null {
	if (evidence.kind !== "session_item") return null;
	return evidence.payload;
}

function messageRecord(evidence: MaterializedEvidence): Readonly<Record<string, unknown>> | null {
	const payload = payloadRecord(evidence);
	if (payload === null) return null;
	return isRecord(payload.message) ? payload.message : payload;
}

function collectToolCallIds(value: unknown, result: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectToolCallIds(item, result);
		return;
	}
	if (!isRecord(value)) return;
	if (value.type === "toolCall" && typeof value.id === "string") result.add(value.id);
	for (const child of Object.values(value)) collectToolCallIds(child, result);
}

function toolCallIds(evidence: MaterializedEvidence): readonly string[] {
	const result = new Set<string>();
	collectToolCallIds(evidence.kind === "session_item" ? evidence.payload : null, result);
	return [...result];
}

function toolResultId(evidence: MaterializedEvidence): string | null {
	const message = messageRecord(evidence);
	return message?.role === "toolResult" && typeof message.toolCallId === "string" ? message.toolCallId : null;
}

function isErrorEvidence(evidence: MaterializedEvidence): boolean {
	const message = messageRecord(evidence);
	return message?.role === "toolResult" && message.isError === true;
}

function isTurnStart(evidence: MaterializedEvidence): boolean {
	return messageRecord(evidence)?.role === "user";
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function edge(
	document: IndexedDocument,
	startOrdinal: number,
	endOrdinal: number,
	side: "left" | "right",
): EvidenceSliceEdge {
	const inside = document.evidence.slice(startOrdinal, endOrdinal + 1);
	const before = document.evidence.slice(0, startOrdinal);
	const after = document.evidence.slice(endOrdinal + 1);
	const reasons: EvidenceSliceOpenReason[] = [];
	const evidenceIds: string[] = [];
	if (side === "left") {
		const callsBefore = new Set(before.flatMap(toolCallIds));
		for (const item of inside) {
			const resultId = toolResultId(item);
			if (resultId !== null && callsBefore.has(resultId)) {
				reasons.push("tool-result-without-call");
				evidenceIds.push(item.evidenceId);
			}
		}
	} else {
		const resultsAfter = new Set(after.map(toolResultId).filter((value): value is string => value !== null));
		for (const item of inside) {
			if (toolCallIds(item).some((callId) => resultsAfter.has(callId))) {
				reasons.push("tool-call-without-result");
				evidenceIds.push(item.evidenceId);
			}
		}
		const last = inside.at(-1);
		if (last !== undefined && isErrorEvidence(last) && after.length > 0) {
			reasons.push("error-without-workaround");
			evidenceIds.push(last.evidenceId);
		}
		if (last !== undefined && isTurnStart(last) && after.length > 0) {
			reasons.push("new-turn-near-end");
			evidenceIds.push(last.evidenceId);
		}
	}
	return {
		status: reasons.length === 0 ? "closed" : "open",
		reasons: unique(reasons),
		evidenceIds: unique(evidenceIds),
	};
}

function toolSchema(properties: JsonObject, required: readonly string[] = []): JsonObject {
	return {
		type: "object",
		additionalProperties: false,
		properties,
		required,
	};
}

export class ReflectorToolRegistry {
	readonly #jobId: string;
	readonly #manifestDigest: string;
	readonly #documents = new Map<string, IndexedDocument>();
	readonly #slices = new Map<string, EvidenceSlice>();
	readonly #maxToolCalls: number;
	readonly #signal?: AbortSignal;
	readonly #audit: (event: ReflectorToolAudit) => Promise<void>;
	readonly #tools: readonly EvolutionModelTool[];
	#revoked = false;
	#toolCalls = 0;

	constructor(options: ReflectorToolRegistryOptions) {
		this.#jobId = options.jobId;
		this.#manifestDigest = options.corpus.metadata.contentDigest;
		this.#maxToolCalls = options.maxToolCalls;
		this.#signal = options.signal;
		this.#audit = options.audit;
		if (
			computeEvolutionContentDigest({
				documents: options.corpus.documents,
				excludedSources: options.corpus.excludedSources,
			}) !== this.#manifestDigest
		) {
			throw new EvolutionExecutionError("Corpus manifest digest does not match its contents", {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		const sources = new Map(options.input.evidenceSources.map((source) => [source.sourceId, source]));
		for (const document of options.corpus.documents) {
			const source = sources.get(document.sourceId);
			if (
				source === undefined ||
				source.materializationId !== document.materializationId ||
				source.contentDigest !== document.contentDigest ||
				computeEvolutionContentDigest(source.invocation) !== document.contentDigest ||
				source.invocation.evidence.length !== document.semanticUnits.length
			) {
				throw new EvolutionExecutionError(`Corpus document "${document.documentId}" is not bound to its source`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
				});
			}
			for (const [ordinal, unit] of document.semanticUnits.entries()) {
				const evidence = source.invocation.evidence[ordinal];
				if (
					evidence === undefined ||
					unit.ordinal !== ordinal ||
					unit.evidenceIds.length !== 1 ||
					unit.evidenceIds[0] !== evidence.evidenceId ||
					unit.contentDigest !== computeEvolutionContentDigest(evidence)
				) {
					throw new EvolutionExecutionError(`Corpus unit "${unit.unitId}" failed integrity validation`, {
						reasonCode: "artifact-corrupt",
						retryable: false,
					});
				}
			}
			this.#documents.set(document.documentId, { descriptor: document, evidence: source.invocation.evidence });
		}
		this.#tools = this.#createTools();
	}

	get tools(): readonly EvolutionModelTool[] {
		return this.#tools;
	}

	get toolCalls(): number {
		return this.#toolCalls;
	}

	revoke(): void {
		this.#revoked = true;
	}

	planInitialSlices(maxUnitsPerSlice: number): readonly EvidenceSlice[] {
		if (!Number.isSafeInteger(maxUnitsPerSlice) || maxUnitsPerSlice < 1) {
			throw new Error("maxUnitsPerSlice must be a positive integer");
		}
		const slices: EvidenceSlice[] = [];
		for (const document of this.#documents.values()) {
			if (document.descriptor.integrity === "incompatible") continue;
			let start = 0;
			while (start < document.evidence.length) {
				let end = Math.min(start + maxUnitsPerSlice - 1, document.evidence.length - 1);
				for (let ordinal = end; ordinal > start; ordinal -= 1) {
					if (isTurnStart(document.evidence[ordinal] as MaterializedEvidence)) {
						end = ordinal - 1;
						break;
					}
				}
				const slice = this.#createSlice(document, start, end);
				slices.push(slice);
				start = end + 1;
			}
		}
		return slices.map((slice, index) => {
			const previous = slices[index - 1];
			const next = slices[index + 1];
			const continuation = {
				previousSliceId:
					previous?.cursor.documentId === slice.cursor.documentId && slice.leftEdge.status === "open"
						? previous.sliceId
						: null,
				nextSliceId:
					next?.cursor.documentId === slice.cursor.documentId && slice.rightEdge.status === "open"
						? next.sliceId
						: null,
			};
			const linked = { ...slice, continuation };
			this.#slices.set(linked.sliceId, linked);
			return linked;
		});
	}

	#createSlice(document: IndexedDocument, startOrdinal: number, endOrdinal: number): EvidenceSlice {
		if (startOrdinal > endOrdinal || endOrdinal >= document.evidence.length) {
			throw new ReflectorToolDeniedError("invalid-range", "Slice range is outside the document");
		}
		const units = document.descriptor.semanticUnits.slice(startOrdinal, endOrdinal + 1);
		const cursorContent = {
			documentId: document.descriptor.documentId,
			startUnitId: (units[0] as (typeof units)[number]).unitId,
			endUnitId: (units.at(-1) as (typeof units)[number]).unitId,
			startOrdinal,
			endOrdinal,
		};
		const cursor = { ...cursorContent, digest: computeEvolutionContentDigest(cursorContent) };
		const sliceId = `slice-${computeEvolutionContentDigest({
			jobId: this.#jobId,
			manifestDigest: this.#manifestDigest,
			cursor,
		}).slice("sha256:".length, "sha256:".length + 32)}`;
		const evidenceIds = units.flatMap((unit) => unit.evidenceIds);
		const contentDigest = computeEvolutionContentDigest({
			manifestDigest: this.#manifestDigest,
			cursor,
			unitDigests: units.map((unit) => unit.contentDigest),
		});
		const slice: EvidenceSlice = {
			sliceId,
			manifestDigest: this.#manifestDigest,
			cursor,
			unitIds: units.map((unit) => unit.unitId),
			evidenceIds,
			contentDigest,
			leftEdge: edge(document, startOrdinal, endOrdinal, "left"),
			rightEdge: edge(document, startOrdinal, endOrdinal, "right"),
			continuation: { previousSliceId: null, nextSliceId: null },
		};
		this.#slices.set(sliceId, slice);
		return slice;
	}

	#createTools(): readonly EvolutionModelTool[] {
		const definitions: readonly [ReflectorToolName, string, JsonObject][] = [
			["list_documents", "List immutable evidence documents.", toolSchema({})],
			[
				"inspect_outline",
				"Inspect safe document metadata and semantic-unit outlines.",
				toolSchema({ documentId: { type: "string" } }, ["documentId"]),
			],
			[
				"search_evidence",
				"Search permitted evidence with a bounded literal query.",
				toolSchema({ query: { type: "string" }, limit: { type: "integer", minimum: 1 } }, ["query"]),
			],
			[
				"read_slice",
				"Read a contiguous inclusive range of semantic units.",
				toolSchema(
					{
						documentId: { type: "string" },
						startOrdinal: { type: "integer", minimum: 0 },
						endOrdinal: { type: "integer", minimum: 0 },
					},
					["documentId", "startOrdinal", "endOrdinal"],
				),
			],
			[
				"inspect_adjacent",
				"Inspect bounded semantic units immediately adjacent to a slice.",
				toolSchema(
					{
						sliceId: { type: "string" },
						before: { type: "integer", minimum: 0 },
						after: { type: "integer", minimum: 0 },
					},
					["sliceId"],
				),
			],
			[
				"refine_slice",
				"Shrink a slice or split it at a semantic-unit boundary.",
				toolSchema(
					{
						sliceId: { type: "string" },
						startOrdinal: { type: "integer", minimum: 0 },
						endOrdinal: { type: "integer", minimum: 0 },
						splitAtOrdinal: { type: "integer", minimum: 0 },
					},
					["sliceId"],
				),
			],
		];
		return definitions.map(([name, description, inputSchema]) => ({
			name,
			description,
			inputSchema,
			execute: (input) => this.#execute(name, input),
		}));
	}

	async #execute(name: ReflectorToolName, input: JsonObject): Promise<JsonObject> {
		this.#toolCalls += 1;
		const toolCallId = `reflector-tool-${this.#toolCalls}`;
		const requestedSliceId = typeof input.sliceId === "string" ? input.sliceId : null;
		const requestDigest = computeEvolutionContentDigest(input);
		let resolvedEvidenceIds: readonly string[] = [];
		let resultDigest: string | null = null;
		let denialCode: string | null = null;
		try {
			if (this.#revoked)
				throw new ReflectorToolDeniedError("registry-revoked", "Reflector tool registry is revoked");
			this.#signal?.throwIfAborted();
			if (this.#toolCalls > this.#maxToolCalls) {
				throw new ReflectorToolDeniedError("tool-budget-exhausted", "Reflector tool-call budget is exhausted");
			}
			const result = this.#run(name, input);
			resolvedEvidenceIds = result.evidenceIds;
			resultDigest = computeEvolutionContentDigest(result.output);
			return result.output;
		} catch (error) {
			denialCode = error instanceof ReflectorToolDeniedError ? error.code : "tool-failed";
			throw error;
		} finally {
			await this.#audit({
				toolCallId,
				toolName: name,
				requestDigest,
				requestedSliceId,
				resolvedEvidenceIds,
				resultDigest,
				denialCode,
			});
		}
	}

	#run(
		name: ReflectorToolName,
		input: JsonObject,
	): { readonly output: JsonObject; readonly evidenceIds: readonly string[] } {
		switch (name) {
			case "list_documents":
				return {
					output: {
						manifestDigest: this.#manifestDigest,
						documents: [...this.#documents.values()].map(({ descriptor }) => ({
							documentId: descriptor.documentId,
							materializationId: descriptor.materializationId,
							traceId: descriptor.traceId,
							integrity: descriptor.integrity,
							terminationStatus: descriptor.terminationStatus,
							unitCount: descriptor.semanticUnits.length,
							contentDigest: descriptor.contentDigest,
						})),
					},
					evidenceIds: [],
				};
			case "inspect_outline": {
				const document = this.#document(stringField(input, "documentId"));
				return {
					output: {
						documentId: document.descriptor.documentId,
						diagnostics: jsonClone(document.descriptor.diagnostics),
						orderingAmbiguity: document.descriptor.orderingAmbiguity,
						semanticUnits: jsonClone(document.descriptor.semanticUnits),
					},
					evidenceIds: document.descriptor.evidenceIds,
				};
			}
			case "search_evidence": {
				const query = stringField(input, "query").toLocaleLowerCase();
				const limit = Math.min(integerField(input, "limit", 20), 100);
				const matches: JsonObject[] = [];
				for (const document of this.#documents.values()) {
					for (const [ordinal, evidence] of document.evidence.entries()) {
						if (serializeEvolutionValue(evidence).toLocaleLowerCase().includes(query)) {
							matches.push({
								documentId: document.descriptor.documentId,
								ordinal,
								evidenceId: evidence.evidenceId,
								unitId: document.descriptor.semanticUnits[ordinal]?.unitId ?? "",
							});
							if (matches.length === limit) break;
						}
					}
					if (matches.length === limit) break;
				}
				return {
					output: { query, matches },
					evidenceIds: matches.map((match) => String(match.evidenceId)),
				};
			}
			case "read_slice": {
				const document = this.#document(stringField(input, "documentId"));
				const slice = this.#createSlice(
					document,
					integerField(input, "startOrdinal"),
					integerField(input, "endOrdinal"),
				);
				return this.#sliceOutput(document, slice);
			}
			case "inspect_adjacent": {
				const slice = this.#slice(stringField(input, "sliceId"));
				const document = this.#document(slice.cursor.documentId);
				const before = Math.min(integerField(input, "before", 1), 20);
				const after = Math.min(integerField(input, "after", 1), 20);
				const start = Math.max(0, slice.cursor.startOrdinal - before);
				const end = Math.min(document.evidence.length - 1, slice.cursor.endOrdinal + after);
				return this.#sliceOutput(document, this.#createSlice(document, start, end));
			}
			case "refine_slice": {
				const slice = this.#slice(stringField(input, "sliceId"));
				const document = this.#document(slice.cursor.documentId);
				const splitAt = input.splitAtOrdinal;
				if (splitAt !== undefined) {
					const split = integerField(input, "splitAtOrdinal");
					if (split <= slice.cursor.startOrdinal || split > slice.cursor.endOrdinal) {
						throw new ReflectorToolDeniedError("invalid-range", "splitAtOrdinal must be inside the slice");
					}
					const left = this.#createSlice(document, slice.cursor.startOrdinal, split - 1);
					const right = this.#createSlice(document, split, slice.cursor.endOrdinal);
					return { output: { slices: jsonClone([left, right]) }, evidenceIds: slice.evidenceIds };
				}
				const start = integerField(input, "startOrdinal", slice.cursor.startOrdinal);
				const end = integerField(input, "endOrdinal", slice.cursor.endOrdinal);
				if (start < slice.cursor.startOrdinal || end > slice.cursor.endOrdinal) {
					throw new ReflectorToolDeniedError("invalid-range", "Refinement cannot expand a slice");
				}
				return this.#sliceOutput(document, this.#createSlice(document, start, end));
			}
		}
	}

	#document(documentId: string): IndexedDocument {
		const document = this.#documents.get(documentId);
		if (document === undefined) {
			throw new ReflectorToolDeniedError("document-not-permitted", `Document "${documentId}" is not permitted`);
		}
		return document;
	}

	#slice(sliceId: string): EvidenceSlice {
		const slice = this.#slices.get(sliceId);
		if (slice === undefined || slice.manifestDigest !== this.#manifestDigest) {
			throw new ReflectorToolDeniedError("slice-not-permitted", `Slice "${sliceId}" is not permitted`);
		}
		return slice;
	}

	#sliceOutput(
		document: IndexedDocument,
		slice: EvidenceSlice,
	): { readonly output: JsonObject; readonly evidenceIds: readonly string[] } {
		const evidence = document.evidence
			.slice(slice.cursor.startOrdinal, slice.cursor.endOrdinal + 1)
			.map((item, offset) => ({
				unit: document.descriptor.semanticUnits[slice.cursor.startOrdinal + offset],
				evidence: jsonClone({
					evidenceId: item.evidenceId,
					kind: item.kind,
					...(item.kind === "session_item" ? { itemType: item.itemType } : {}),
					payload: item.payload,
				}),
			}));
		return {
			output: { slice: jsonClone(slice), evidence: jsonClone(evidence), untrustedData: true },
			evidenceIds: slice.evidenceIds,
		};
	}
}
