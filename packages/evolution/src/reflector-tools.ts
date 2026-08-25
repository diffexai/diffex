import type { MaterializedEvidence } from "@earendil-works/diffex-harness-trace";
import type {
	EvidenceCorpusDocument,
	EvidenceCorpusManifest,
	EvidenceSemanticUnit,
	EvidenceSlice,
	EvidenceSliceEdge,
	EvidenceSliceOpenReason,
	EvolutionInputSnapshot,
	JsonObject,
	JsonValue,
	Lesson,
} from "./contracts.ts";
import { EvolutionExecutionError, EvolutionToolDeniedError } from "./errors.ts";
import { EvolutionModelReferenceCatalog, referenceArray } from "./model-references.ts";
import type { EvolutionModelTool } from "./ports.ts";
import { computeEvolutionContentDigest, serializeEvolutionValue } from "./provenance.ts";

const EVIDENCE_TOOL_NAMES = ["search_evidence", "read_slice", "inspect_adjacent"] as const;

export type ReflectorToolName = (typeof EVIDENCE_TOOL_NAMES)[number] | "inspect_child_lessons";

export interface ReflectorToolAudit {
	readonly toolCallId: string;
	readonly toolName: ReflectorToolName;
	readonly requestDigest: string;
	readonly requestedDocumentRef: string | null;
	readonly requestedSliceRef: string | null;
	readonly resolvedDocumentIds: readonly string[];
	readonly resolvedEvidenceIds: readonly string[];
	readonly resolvedLessonIds: readonly string[];
	readonly resolvedSliceIds: readonly string[];
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

interface IndexedEvidence {
	readonly document: IndexedDocument;
	readonly evidence: MaterializedEvidence;
	readonly unit: EvidenceSemanticUnit;
	readonly ordinal: number;
}

export interface ReflectorNodeReferences {
	readonly documents: EvolutionModelReferenceCatalog<IndexedDocument>;
	readonly evidence: EvolutionModelReferenceCatalog<IndexedEvidence>;
	readonly documentCatalog: readonly JsonObject[];
	readonly evidenceCatalog: readonly JsonObject[];
	readonly sliceCatalog: readonly JsonObject[];
}

export interface ReflectorRecoverableToolDenial {
	readonly toolName: ReflectorToolName;
	readonly denialCode: string;
	readonly requestedDocumentRef: string | null;
	readonly requestedSliceRef: string | null;
}

interface NodeToolBudget {
	readonly maxToolCalls: number;
	readonly signal?: AbortSignal;
	readonly onToolCall?: () => void;
	toolCalls: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(input: JsonObject, name: string): string {
	const value = input[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new EvolutionToolDeniedError("invalid-request", `${name} must be a non-empty reference`);
	}
	return value;
}

function integerField(input: JsonObject, name: string, fallback?: number): number {
	const value = input[name];
	if (value === undefined && fallback !== undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new EvolutionToolDeniedError("invalid-request", `${name} must be a non-negative integer`);
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
	return { type: "object", additionalProperties: false, properties, required };
}

export class ReflectorToolRegistry {
	readonly #jobId: string;
	readonly #manifestDigest: string;
	readonly #documents: readonly IndexedDocument[];
	readonly #documentReferences: EvolutionModelReferenceCatalog<IndexedDocument>;
	readonly #evidenceReferences: EvolutionModelReferenceCatalog<IndexedEvidence>;
	readonly #slices = new Map<string, EvidenceSlice>();
	readonly #sliceReferences = new Map<string, string>();
	readonly #sensitiveReplacements = new Map<string, string>();
	#maxToolCalls: number;
	readonly #signal?: AbortSignal;
	readonly #audit: (event: ReflectorToolAudit) => Promise<void>;
	readonly #recoverableDenials: ReflectorRecoverableToolDenial[] = [];
	readonly #toolBudgets = new WeakMap<readonly EvolutionModelTool[], NodeToolBudget>();
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
		const documents: IndexedDocument[] = [];
		const evidence: IndexedEvidence[] = [];
		for (const descriptor of options.corpus.documents) {
			const source = sources.get(descriptor.sourceId);
			if (
				source === undefined ||
				source.materializationId !== descriptor.materializationId ||
				source.contentDigest !== descriptor.contentDigest ||
				computeEvolutionContentDigest(source.invocation) !== descriptor.contentDigest ||
				source.invocation.evidence.length !== descriptor.semanticUnits.length
			) {
				throw new EvolutionExecutionError(`Corpus document "${descriptor.documentId}" is not bound to its source`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
				});
			}
			const document = { descriptor, evidence: source.invocation.evidence };
			documents.push(document);
			for (const [ordinal, unit] of descriptor.semanticUnits.entries()) {
				const item = source.invocation.evidence[ordinal];
				if (
					item === undefined ||
					unit.ordinal !== ordinal ||
					unit.evidenceIds.length !== 1 ||
					unit.evidenceIds[0] !== item.evidenceId ||
					unit.contentDigest !== computeEvolutionContentDigest(item)
				) {
					throw new EvolutionExecutionError(`Corpus unit "${unit.unitId}" failed integrity validation`, {
						reasonCode: "artifact-corrupt",
						retryable: false,
					});
				}
				evidence.push({ document, evidence: item, unit, ordinal });
			}
			this.#sensitiveReplacements.set(descriptor.materializationId, "[source-reference]");
			if (descriptor.traceId !== null) this.#sensitiveReplacements.set(descriptor.traceId, "[source-reference]");
		}
		this.#documents = documents;
		this.#documentReferences = new EvolutionModelReferenceCatalog("document", documents);
		this.#evidenceReferences = new EvolutionModelReferenceCatalog("evidence", evidence);
		for (const entry of this.#documentReferences.entries) {
			this.#sensitiveReplacements.set(entry.value.descriptor.documentId, entry.ref);
		}
		for (const entry of this.#evidenceReferences.entries) {
			this.#sensitiveReplacements.set(entry.value.evidence.evidenceId, entry.ref);
		}
		for (const item of options.input.harness.activeMemoryItems) {
			this.#sensitiveReplacements.set(item.memoryItemId, "[memory-reference]");
		}
	}

	get toolCalls(): number {
		return this.#toolCalls;
	}

	get slices(): readonly EvidenceSlice[] {
		return [...this.#slices.values()];
	}

	get budgetExhausted(): boolean {
		return this.#toolCalls > this.#maxToolCalls;
	}

	get recoverableDenials(): readonly ReflectorRecoverableToolDenial[] {
		return this.#recoverableDenials;
	}

	setMaxToolCalls(maxToolCalls: number): void {
		if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < this.#toolCalls) {
			throw new Error("maxToolCalls must be a safe integer no lower than consumed tool calls");
		}
		this.#maxToolCalls = maxToolCalls;
	}

	toolBudgetExhausted(tools: readonly EvolutionModelTool[]): boolean {
		const budget = this.#toolBudgets.get(tools);
		return budget !== undefined && budget.toolCalls > budget.maxToolCalls;
	}

	revoke(): void {
		this.#revoked = true;
	}

	nodeReferences(evidenceIds: readonly string[]): ReflectorNodeReferences {
		const permittedIds = new Set(evidenceIds);
		const evidenceValues = this.#evidenceReferences.entries
			.filter((entry) => permittedIds.has(entry.value.evidence.evidenceId))
			.map((entry) => entry.value);
		if (evidenceValues.length !== permittedIds.size) {
			throw new EvolutionExecutionError("Reflection node cites evidence outside the corpus", {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		const documentValues = this.#documents.filter((document) =>
			evidenceValues.some((entry) => entry.document === document),
		);
		const documents = this.#documentReferences.select(documentValues);
		const evidence = this.#evidenceReferences.select(evidenceValues);
		return {
			documents,
			evidence,
			documentCatalog: documents.entries.map((entry) => ({
				documentRef: entry.ref,
				integrity: entry.value.descriptor.integrity,
				terminationStatus: entry.value.descriptor.terminationStatus,
				unitCount: evidenceValues.filter((item) => item.document === entry.value).length,
				diagnostics: entry.value.descriptor.diagnostics.map((diagnostic) => ({
					code: diagnostic.code,
					recoverable: diagnostic.recoverable,
				})),
			})),
			evidenceCatalog: evidence.entries.map((entry) => ({
				evidenceRef: entry.ref,
				documentRef: documents.refFor(entry.value.document),
				ordinal: entry.value.ordinal,
				kind: entry.value.unit.kind,
				preview: this.#preview(entry.value.evidence),
			})),
			sliceCatalog: [...this.#slices.values()]
				.filter((slice) => slice.evidenceIds.every((evidenceId) => permittedIds.has(evidenceId)))
				.map((slice) => this.#sliceDescriptor(slice, evidence, documents)),
		};
	}

	toolsForEvidence(
		references: ReflectorNodeReferences,
		maxToolCalls: number,
		signal?: AbortSignal,
		onToolCall?: () => void,
	): readonly EvolutionModelTool[] {
		const budget: NodeToolBudget = { maxToolCalls, signal, onToolCall, toolCalls: 0 };
		const permittedEvidenceIds = new Set(references.evidence.entries.map((entry) => entry.value.evidence.evidenceId));
		const definitions: readonly [Exclude<ReflectorToolName, "inspect_child_lessons">, string, JsonObject][] = [
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
						documentRef: { type: "string", enum: references.documents.references },
						startOrdinal: { type: "integer", minimum: 0 },
						endOrdinal: { type: "integer", minimum: 0 },
					},
					["documentRef", "startOrdinal", "endOrdinal"],
				),
			],
			[
				"inspect_adjacent",
				"Inspect bounded semantic units immediately adjacent to a slice.",
				toolSchema(
					{
						sliceRef: { type: "string", pattern: "^S[1-9][0-9]*$" },
						before: { type: "integer", minimum: 0 },
						after: { type: "integer", minimum: 0 },
					},
					["sliceRef"],
				),
			],
		];
		const tools = definitions.map(([name, description, inputSchema]) => ({
			name,
			description,
			inputSchema,
			execute: (input: JsonObject) => this.#executeEvidence(name, input, references, permittedEvidenceIds, budget),
		}));
		this.#toolBudgets.set(tools, budget);
		return tools;
	}

	toolsForLessons(
		lessons: EvolutionModelReferenceCatalog<Lesson>,
		maxToolCalls: number,
		signal?: AbortSignal,
		onToolCall?: () => void,
	): readonly EvolutionModelTool[] {
		const budget: NodeToolBudget = { maxToolCalls, signal, onToolCall, toolCalls: 0 };
		const tools: readonly EvolutionModelTool[] = [
			{
				name: "inspect_child_lessons",
				description: "Inspect complete child lesson content without opening raw corpus evidence.",
				inputSchema: toolSchema(
					{
						lessonRefs: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: lessons.references },
						},
					},
					["lessonRefs"],
				),
				execute: (input) => this.#executeLessonInspection(input, lessons, budget),
			},
		];
		this.#toolBudgets.set(tools, budget);
		return tools;
	}

	planInitialSlices(maxUnitsPerSlice: number): readonly EvidenceSlice[] {
		if (!Number.isSafeInteger(maxUnitsPerSlice) || maxUnitsPerSlice < 1) {
			throw new Error("maxUnitsPerSlice must be a positive integer");
		}
		const slices: EvidenceSlice[] = [];
		for (const document of this.#documents) {
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
			const linked = {
				...slice,
				continuation: {
					previousSliceId:
						previous?.cursor.documentId === slice.cursor.documentId && slice.leftEdge.status === "open"
							? previous.sliceId
							: null,
					nextSliceId:
						next?.cursor.documentId === slice.cursor.documentId && slice.rightEdge.status === "open"
							? next.sliceId
							: null,
				},
			};
			this.#slices.set(linked.sliceId, linked);
			return linked;
		});
	}

	async #executeEvidence(
		name: Exclude<ReflectorToolName, "inspect_child_lessons">,
		input: JsonObject,
		references: ReflectorNodeReferences,
		permittedEvidenceIds: ReadonlySet<string>,
		budget: NodeToolBudget,
	): Promise<JsonObject> {
		return this.#execute(name, input, budget, () => this.#runEvidence(name, input, references, permittedEvidenceIds));
	}

	async #executeLessonInspection(
		input: JsonObject,
		lessons: EvolutionModelReferenceCatalog<Lesson>,
		budget: NodeToolBudget,
	): Promise<JsonObject> {
		return this.#execute("inspect_child_lessons", input, budget, () => {
			this.#assertAllowedFields("inspect_child_lessons", input, ["lessonRefs"]);
			const selected = referenceArray(input.lessonRefs, "lessonRefs", lessons, { allowEmpty: false });
			return {
				output: {
					lessons: selected.map((lesson) => ({
						lessonRef: lessons.refFor(lesson),
						kind: lesson.kind,
						summary: lesson.summary,
						preconditions: lesson.preconditions,
						observedOutcome: lesson.observedOutcome,
						applicabilityBoundaries: lesson.applicabilityBoundaries,
						uncertainty: lesson.uncertainty,
						actionableTakeaway: lesson.actionableTakeaway,
						supportingEvidenceCount: lesson.evidenceIds.length,
						counterevidenceCount: lesson.counterevidenceIds.length,
					})),
				},
				resolvedDocumentIds: [],
				resolvedEvidenceIds: [],
				resolvedLessonIds: selected.map((lesson) => lesson.lessonId),
				resolvedSliceIds: [],
			};
		});
	}

	async #execute(
		name: ReflectorToolName,
		input: JsonObject,
		budget: NodeToolBudget,
		run: () => {
			readonly output: JsonObject;
			readonly resolvedDocumentIds: readonly string[];
			readonly resolvedEvidenceIds: readonly string[];
			readonly resolvedLessonIds: readonly string[];
			readonly resolvedSliceIds: readonly string[];
		},
	): Promise<JsonObject> {
		if (!this.#revoked) budget.signal?.throwIfAborted();
		this.#toolCalls += 1;
		budget.toolCalls += 1;
		budget.onToolCall?.();
		const toolCallId = `reflector-tool-${this.#toolCalls}`;
		const requestedDocumentRef = typeof input.documentRef === "string" ? input.documentRef : null;
		const requestedSliceRef = typeof input.sliceRef === "string" ? input.sliceRef : null;
		const requestDigest = computeEvolutionContentDigest(input);
		let resolvedDocumentIds: readonly string[] = [];
		let resolvedEvidenceIds: readonly string[] = [];
		let resolvedLessonIds: readonly string[] = [];
		let resolvedSliceIds: readonly string[] = [];
		let resultDigest: string | null = null;
		let denialCode: string | null = null;
		try {
			if (this.#revoked)
				throw new EvolutionToolDeniedError("registry-revoked", "Reflector tool registry is revoked");
			this.#signal?.throwIfAborted();
			if (budget.toolCalls > budget.maxToolCalls) {
				throw new EvolutionToolDeniedError(
					"tool-budget-exhausted",
					"Reflection node tool-call budget is exhausted",
				);
			}
			if (this.#toolCalls > this.#maxToolCalls) {
				throw new EvolutionToolDeniedError("tool-budget-exhausted", "Reflector tool-call budget is exhausted");
			}
			const result = run();
			resolvedDocumentIds = result.resolvedDocumentIds;
			resolvedEvidenceIds = result.resolvedEvidenceIds;
			resolvedLessonIds = result.resolvedLessonIds;
			resolvedSliceIds = result.resolvedSliceIds;
			resultDigest = computeEvolutionContentDigest(result.output);
			return result.output;
		} catch (error) {
			denialCode = error instanceof EvolutionToolDeniedError ? error.code : "tool-failed";
			if (error instanceof EvolutionToolDeniedError && error.recoverable) {
				this.#recoverableDenials.push({ toolName: name, denialCode, requestedDocumentRef, requestedSliceRef });
			}
			throw error;
		} finally {
			await this.#audit({
				toolCallId,
				toolName: name,
				requestDigest,
				requestedDocumentRef,
				requestedSliceRef,
				resolvedDocumentIds,
				resolvedEvidenceIds,
				resolvedLessonIds,
				resolvedSliceIds,
				resultDigest,
				denialCode,
			});
		}
	}

	#runEvidence(
		name: Exclude<ReflectorToolName, "inspect_child_lessons">,
		input: JsonObject,
		references: ReflectorNodeReferences,
		permittedEvidenceIds: ReadonlySet<string>,
	): {
		readonly output: JsonObject;
		readonly resolvedDocumentIds: readonly string[];
		readonly resolvedEvidenceIds: readonly string[];
		readonly resolvedLessonIds: readonly string[];
		readonly resolvedSliceIds: readonly string[];
	} {
		const result = (
			output: JsonObject,
			documents: readonly IndexedDocument[] = [],
			evidenceIds: readonly string[] = [],
			slices: readonly EvidenceSlice[] = [],
		) => ({
			output,
			resolvedDocumentIds: documents.map((document) => document.descriptor.documentId),
			resolvedEvidenceIds: evidenceIds,
			resolvedLessonIds: [],
			resolvedSliceIds: slices.map((slice) => slice.sliceId),
		});
		switch (name) {
			case "search_evidence": {
				this.#assertAllowedFields(name, input, ["query", "limit"]);
				const query = stringField(input, "query").toLocaleLowerCase();
				const limit = Math.min(integerField(input, "limit", 20), 100);
				const matches = references.evidence.entries
					.filter((entry) => serializeEvolutionValue(entry.value.evidence).toLocaleLowerCase().includes(query))
					.slice(0, limit);
				return result(
					{
						query,
						matches: matches.map((entry) => ({
							documentRef: references.documents.refFor(entry.value.document),
							ordinal: entry.value.ordinal,
							evidenceRef: entry.ref,
						})),
					},
					unique(matches.map((entry) => entry.value.document)),
					matches.map((entry) => entry.value.evidence.evidenceId),
				);
			}
			case "read_slice": {
				this.#assertAllowedFields(name, input, ["documentRef", "startOrdinal", "endOrdinal"]);
				const document = this.#document(stringField(input, "documentRef"), references.documents);
				const startOrdinal = integerField(input, "startOrdinal");
				const endOrdinal = integerField(input, "endOrdinal");
				this.#assertRangePermitted(document, startOrdinal, endOrdinal, permittedEvidenceIds);
				return this.#sliceOutput(document, this.#createSlice(document, startOrdinal, endOrdinal), references);
			}
			case "inspect_adjacent": {
				this.#assertAllowedFields(name, input, ["sliceRef", "before", "after"]);
				const slice = this.#slice(stringField(input, "sliceRef"), permittedEvidenceIds);
				const document = this.#documents.find(
					(candidate) => candidate.descriptor.documentId === slice.cursor.documentId,
				);
				if (document === undefined) throw new Error("Resolved slice document is unavailable");
				const before = Math.min(integerField(input, "before", 1), 20);
				const after = Math.min(integerField(input, "after", 1), 20);
				let start = slice.cursor.startOrdinal;
				let end = slice.cursor.endOrdinal;
				for (let count = 0; count < before && start > 0; count += 1) {
					const adjacent = document.evidence[start - 1];
					if (adjacent === undefined || !permittedEvidenceIds.has(adjacent.evidenceId)) break;
					start -= 1;
				}
				for (let count = 0; count < after && end < document.evidence.length - 1; count += 1) {
					const adjacent = document.evidence[end + 1];
					if (adjacent === undefined || !permittedEvidenceIds.has(adjacent.evidenceId)) break;
					end += 1;
				}
				return this.#sliceOutput(document, this.#createSlice(document, start, end), references);
			}
		}
	}

	#assertAllowedFields(name: ReflectorToolName, input: JsonObject, allowed: readonly string[]): void {
		const permitted = new Set(allowed);
		const unexpected = Object.keys(input).find((field) => !permitted.has(field));
		if (unexpected !== undefined) {
			throw new EvolutionToolDeniedError("invalid-request", `Tool "${name}" does not permit field "${unexpected}"`);
		}
	}

	#document(reference: string, catalog: EvolutionModelReferenceCatalog<IndexedDocument>): IndexedDocument {
		try {
			return catalog.resolve(reference, "documentRef");
		} catch {
			throw new EvolutionToolDeniedError(
				"document-not-permitted",
				`Document reference is not permitted. Permitted document references: ${catalog.references.join(", ")}`,
			);
		}
	}

	#assertRangePermitted(
		document: IndexedDocument,
		startOrdinal: number,
		endOrdinal: number,
		permittedEvidenceIds: ReadonlySet<string>,
	): void {
		if (startOrdinal > endOrdinal || endOrdinal >= document.evidence.length) {
			throw new EvolutionToolDeniedError("invalid-range", "Slice range is outside the document");
		}
		if (
			document.evidence
				.slice(startOrdinal, endOrdinal + 1)
				.some((evidence) => !permittedEvidenceIds.has(evidence.evidenceId))
		) {
			throw new EvolutionToolDeniedError("evidence-not-permitted", "Slice range is outside the current node");
		}
	}

	#slice(reference: string, permittedEvidenceIds: ReadonlySet<string>): EvidenceSlice {
		const sliceId = [...this.#sliceReferences.entries()].find(([, value]) => value === reference)?.[0];
		const slice = sliceId === undefined ? undefined : this.#slices.get(sliceId);
		if (
			slice === undefined ||
			slice.manifestDigest !== this.#manifestDigest ||
			slice.evidenceIds.some((evidenceId) => !permittedEvidenceIds.has(evidenceId))
		) {
			throw new EvolutionToolDeniedError("slice-not-permitted", "Slice reference is not permitted");
		}
		return slice;
	}

	#createSlice(document: IndexedDocument, startOrdinal: number, endOrdinal: number): EvidenceSlice {
		if (startOrdinal > endOrdinal || endOrdinal >= document.evidence.length) {
			throw new EvolutionToolDeniedError("invalid-range", "Slice range is outside the document");
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
		const existing = this.#slices.get(sliceId);
		if (existing !== undefined) return existing;
		const evidenceIds = units.flatMap((unit) => unit.evidenceIds);
		const slice: EvidenceSlice = {
			sliceId,
			manifestDigest: this.#manifestDigest,
			cursor,
			unitIds: units.map((unit) => unit.unitId),
			evidenceIds,
			contentDigest: computeEvolutionContentDigest({
				manifestDigest: this.#manifestDigest,
				cursor,
				unitDigests: units.map((unit) => unit.contentDigest),
			}),
			leftEdge: edge(document, startOrdinal, endOrdinal, "left"),
			rightEdge: edge(document, startOrdinal, endOrdinal, "right"),
			continuation: { previousSliceId: null, nextSliceId: null },
		};
		this.#slices.set(sliceId, slice);
		if (!this.#sliceReferences.has(sliceId)) {
			this.#sliceReferences.set(sliceId, `S${this.#sliceReferences.size + 1}`);
			this.#sensitiveReplacements.set(sliceId, this.#sliceReferences.get(sliceId) as string);
		}
		return slice;
	}

	#sliceOutput(
		document: IndexedDocument,
		slice: EvidenceSlice,
		references: ReflectorNodeReferences,
	): {
		readonly output: JsonObject;
		readonly resolvedDocumentIds: readonly string[];
		readonly resolvedEvidenceIds: readonly string[];
		readonly resolvedLessonIds: readonly string[];
		readonly resolvedSliceIds: readonly string[];
	} {
		const evidence = document.evidence
			.slice(slice.cursor.startOrdinal, slice.cursor.endOrdinal + 1)
			.map((item, offset) => ({
				ordinal: slice.cursor.startOrdinal + offset,
				evidenceRef: this.#evidenceRef(item.evidenceId, references.evidence),
				kind: item.kind,
				...(item.kind === "session_item" ? { itemType: item.itemType } : {}),
				payload: this.#modelSafeClone(item.payload),
			}));
		return {
			output: {
				slice: this.#sliceDescriptor(slice, references.evidence, references.documents),
				evidence,
				untrustedData: true,
			},
			resolvedDocumentIds: [document.descriptor.documentId],
			resolvedEvidenceIds: slice.evidenceIds,
			resolvedLessonIds: [],
			resolvedSliceIds: [slice.sliceId],
		};
	}

	#sliceDescriptor(
		slice: EvidenceSlice,
		evidence: EvolutionModelReferenceCatalog<IndexedEvidence>,
		documents: EvolutionModelReferenceCatalog<IndexedDocument>,
	): JsonObject {
		const document = this.#documents.find((candidate) => candidate.descriptor.documentId === slice.cursor.documentId);
		if (document === undefined) throw new Error("Slice document is unavailable");
		const edgeDescriptor = (value: EvidenceSliceEdge): JsonObject => ({
			status: value.status,
			reasons: value.reasons,
			evidenceRefs: value.evidenceIds.map((evidenceId) => this.#evidenceRef(evidenceId, evidence)),
		});
		const continuationRef = (sliceId: string | null) =>
			sliceId === null ? null : (this.#sliceReferences.get(sliceId) ?? null);
		return {
			sliceRef: this.#sliceReferences.get(slice.sliceId) as string,
			documentRef: documents.refFor(document),
			startOrdinal: slice.cursor.startOrdinal,
			endOrdinal: slice.cursor.endOrdinal,
			evidenceRefs: slice.evidenceIds.map((evidenceId) => this.#evidenceRef(evidenceId, evidence)),
			leftEdge: edgeDescriptor(slice.leftEdge),
			rightEdge: edgeDescriptor(slice.rightEdge),
			continuation: {
				previousSliceRef: continuationRef(slice.continuation.previousSliceId),
				nextSliceRef: continuationRef(slice.continuation.nextSliceId),
			},
		};
	}

	#evidenceRef(evidenceId: string, catalog: EvolutionModelReferenceCatalog<IndexedEvidence>): string {
		const entry = catalog.entries.find((candidate) => candidate.value.evidence.evidenceId === evidenceId);
		if (entry === undefined) throw new Error("Evidence is outside the current node reference catalog");
		return entry.ref;
	}

	#preview(evidence: MaterializedEvidence): string {
		const value = evidence.kind === "session_item" ? evidence.payload : evidence;
		const serialized = serializeEvolutionValue(this.#modelSafeClone(value));
		return serialized.length <= 240 ? serialized : `${serialized.slice(0, 237)}...`;
	}

	#modelSafeClone(value: unknown): JsonValue {
		const replace = (candidate: unknown): JsonValue => {
			if (typeof candidate === "string") {
				let result = candidate;
				for (const [sensitive, replacement] of this.#sensitiveReplacements) {
					result = result.replaceAll(sensitive, replacement);
				}
				return result;
			}
			if (Array.isArray(candidate)) return candidate.map(replace);
			if (!isRecord(candidate)) return candidate as JsonValue;
			return Object.fromEntries(Object.entries(candidate).map(([key, child]) => [key, replace(child)]));
		};
		return replace(jsonClone(value));
	}
}
