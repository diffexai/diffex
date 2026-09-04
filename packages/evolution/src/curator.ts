import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type {
	ApplicableInstructionReference,
	CuratorToolCallLedgerEvent,
	EvolutionArtifactProducer,
	EvolutionMemoryAddDelta,
	EvolutionMemoryDelta,
	EvolutionMemoryReference,
	EvolutionMemoryRemoveDelta,
	EvolutionMemoryReplaceDelta,
	EvolutionProposal,
	EvolutionProposalInstructionRelationship,
	EvolutionProposalScope,
	ExistingInstructionReference,
	JsonObject,
	Lesson,
} from "./contracts.ts";
import { type CuratorCapabilities, type CuratorToolAudit, CuratorToolRegistry } from "./curator-tools.ts";
import { EvolutionExecutionError } from "./errors.ts";
import {
	assertEvolutionMemoryLessonContent,
	EVOLUTION_MEMORY_MAX_LESSON_SENTENCES,
} from "./evolution-memory-lessons.ts";
import { EvolutionModelReferenceError, referenceArray } from "./model-references.ts";
import type { Curator, CuratorInput, EvolutionLedger, EvolutionModelResponse } from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

const DEFAULT_MAX_RESPONSE_ATTEMPTS = 2;
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createCuratorOutputSchema(capabilities: CuratorCapabilities): JsonObject {
	const stringArray = { type: "array", items: { type: "string", minLength: 1 } };
	const referenceArraySchema = (values: readonly string[], minItems = 0): JsonObject =>
		values.length === 0
			? { type: "array", maxItems: 0, items: { type: "string" } }
			: { type: "array", minItems, items: { type: "string", enum: values } };
	const decisionRequired = [
		"decisionKey",
		"lessonRefs",
		"instructionRefs",
		"memoryRefs",
		"action",
		"exactDelta",
		"conflictingDecisionKeys",
	];
	const decisionProperties = {
		decisionKey: { type: "string", minLength: 1 },
		lessonRefs: referenceArraySchema(capabilities.lessonRefs, 1),
		instructionRefs: referenceArraySchema(capabilities.instructionRefs),
		memoryRefs: referenceArraySchema(["M0", ...capabilities.allMemoryRefs]),
		conflictingDecisionKeys: stringArray,
	};
	const decisionVariant = (action: ProposalDraft["action"], exactDelta: JsonObject): JsonObject => ({
		type: "object",
		additionalProperties: false,
		required: decisionRequired,
		properties: {
			...decisionProperties,
			action: { enum: [action] },
			exactDelta,
		},
	});
	const removalDefinitions: JsonObject =
		capabilities.removableMemoryRefs.length === 0
			? {}
			: {
					addition: {
						type: "object",
						additionalProperties: false,
						required: ["content", "intendedScope"],
						properties: {
							content: {
								type: "string",
								minLength: 1,
								description: "Lesson prose of at most three sentences. Omit the deterministic Lesson number.",
							},
							intendedScope: stringArray,
						},
					},
					removal: {
						type: "object",
						additionalProperties: false,
						required: ["memoryRef", "reason"],
						properties: {
							memoryRef: { type: "string", enum: capabilities.removableMemoryRefs },
							reason: { type: "string", minLength: 1 },
						},
					},
					removeDelta: {
						type: "object",
						additionalProperties: false,
						required: ["operation", "memoryRef", "reason"],
						properties: {
							operation: { enum: ["REMOVE"] },
							memoryRef: { type: "string", enum: capabilities.removableMemoryRefs },
							reason: { type: "string", minLength: 1 },
						},
					},
					replaceDelta: {
						type: "object",
						additionalProperties: false,
						required: ["operation", "removal", "addition"],
						properties: {
							operation: { enum: ["REPLACE"] },
							removal: { $ref: "#/$defs/removal" },
							addition: { $ref: "#/$defs/addition" },
						},
					},
				};
	return {
		$defs: {
			destination: {
				type: "object",
				additionalProperties: false,
				required: ["section", "anchor"],
				properties: {
					section: { type: ["string", "null"] },
					anchor: {
						enum: [null, ...capabilities.allMemoryRefs],
						description:
							"Existing memory item reference to insert after, null to append within a named section, or null with a null section to append globally.",
					},
				},
			},
			addDelta: {
				type: "object",
				additionalProperties: false,
				required: ["operation", "destination", "content", "intendedScope"],
				properties: {
					operation: { enum: ["ADD"] },
					destination: { $ref: "#/$defs/destination" },
					content: {
						type: "string",
						minLength: 1,
						description: "Lesson prose of at most three sentences. Omit the deterministic Lesson number.",
					},
					intendedScope: stringArray,
				},
			},
			...removalDefinitions,
			decision: {
				anyOf: capabilities.memoryOperations.map((operation) =>
					decisionVariant(operation, {
						$ref: `#/$defs/${operation === "ADD" ? "addDelta" : operation === "REMOVE" ? "removeDelta" : "replaceDelta"}`,
					}),
				),
			},
		},
		type: "object",
		additionalProperties: false,
		required: ["decisions"],
		properties: {
			decisions: { type: "array", items: { $ref: "#/$defs/decision" } },
		},
	};
}

export interface StructuredDeltaCuratorDependencies {
	readonly version: string;
	readonly ledger?: EvolutionLedger;
}

export interface StructuredDeltaCuratorOptions {
	readonly maxResponseAttempts?: number;
}

interface ProposalDraft {
	readonly decisionKey: string;
	readonly lessonIds: readonly string[];
	readonly relationship: EvolutionProposalInstructionRelationship;
	readonly action: "ADD" | "REMOVE" | "REPLACE";
	readonly exactDelta: EvolutionMemoryDelta;
	readonly conflictingDecisionKeys: readonly string[];
}

interface EvidenceContext {
	readonly materializationId: string;
	readonly traceId: string | null;
	readonly invocation: MaterializedInvocation;
	readonly evidence: MaterializedEvidence;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CuratorDecisionValidationIssue {
	readonly decisionKey: string | null;
	readonly path: string;
	readonly message: string;
	readonly invalidReferences: readonly string[];
	readonly permittedReferences: readonly string[];
}

class CuratorFieldValidationError extends Error {
	readonly path: string;
	readonly validationCause: unknown;

	constructor(path: string, validationCause: unknown) {
		super(validationCause instanceof Error ? validationCause.message : "Response validation failed");
		this.name = "CuratorFieldValidationError";
		this.path = path;
		this.validationCause = validationCause;
	}
}

class CuratorOutputValidationError extends Error {
	readonly issues: readonly CuratorDecisionValidationIssue[];
	readonly invalidReferences: readonly string[];
	readonly permittedReferences: readonly string[];

	constructor(issues: readonly CuratorDecisionValidationIssue[]) {
		super(
			issues
				.map(
					(issue) =>
						`${issue.decisionKey === null ? "Decision" : `Decision "${issue.decisionKey}"`} at ${issue.path}: ${issue.message}`,
				)
				.join("\n"),
		);
		this.name = "CuratorOutputValidationError";
		this.issues = issues;
		this.invalidReferences = unique(issues.flatMap((issue) => issue.invalidReferences));
		this.permittedReferences = unique(issues.flatMap((issue) => issue.permittedReferences));
	}
}

function atPath<T>(path: string, parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof CuratorFieldValidationError) {
			throw new CuratorFieldValidationError(`${path}.${error.path}`, error.validationCause);
		}
		throw new CuratorFieldValidationError(path, error);
	}
}

function decisionValidationIssue(
	error: unknown,
	index: number,
	decisionKey: string | null,
): CuratorDecisionValidationIssue {
	const fieldError = error instanceof CuratorFieldValidationError ? error : null;
	const cause = fieldError?.validationCause ?? error;
	return {
		decisionKey,
		path: `decisions[${String(index)}]${fieldError === null ? "" : `.${fieldError.path}`}`,
		message: cause instanceof Error ? cause.message : "Response validation failed",
		invalidReferences: cause instanceof EvolutionModelReferenceError ? cause.invalidReferences : [],
		permittedReferences: cause instanceof EvolutionModelReferenceError ? cause.permittedReferences : [],
	};
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function assertOnlyFields(record: Readonly<Record<string, unknown>>, allowed: readonly string[], name: string): void {
	const allowedFields = new Set(allowed);
	const unexpected = Object.keys(record).find((field) => !allowedFields.has(field));
	if (unexpected !== undefined) throw new Error(`${name} does not permit field "${unexpected}"`);
}

function requiredString(record: Readonly<Record<string, unknown>>, name: string): string {
	const value = record[name];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function nullableString(record: Readonly<Record<string, unknown>>, name: string): string | null {
	const value = record[name];
	if (value !== null && (typeof value !== "string" || value.length === 0)) {
		throw new Error(`${name} must be a non-empty string or null`);
	}
	return value;
}

function stringArray(value: unknown, name: string, allowEmpty = true): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${name} must be an array of non-empty strings`);
	}
	if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates`);
	if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
	return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function guidanceRelationship(
	instructionRefs: unknown,
	memoryRefsValue: unknown,
	registry: CuratorToolRegistry,
): EvolutionProposalInstructionRelationship {
	const instructions = atPath("instructionRefs", () =>
		referenceArray(instructionRefs, "instructionRefs", registry.instructions),
	);
	const memoryRefs = atPath("memoryRefs", () => {
		if (!Array.isArray(memoryRefsValue) || memoryRefsValue.some((reference) => typeof reference !== "string")) {
			throw new EvolutionModelReferenceError(
				"memoryRefs",
				[],
				["M0", ...registry.memory.references],
				"must be an array of references",
			);
		}
		const references = memoryRefsValue as readonly string[];
		if (new Set(references).size !== references.length) {
			throw new EvolutionModelReferenceError(
				"memoryRefs",
				references,
				["M0", ...registry.memory.references],
				"contains duplicates",
			);
		}
		const invalidMemoryRefs = references.filter(
			(reference) => reference !== "M0" && !registry.memory.references.includes(reference),
		);
		if (invalidMemoryRefs.length > 0) {
			throw new EvolutionModelReferenceError(
				"memoryRefs",
				invalidMemoryRefs,
				["M0", ...registry.memory.references],
				"contains an unknown reference",
			);
		}
		return references;
	});
	const relevantEntries: ExistingInstructionReference[] = instructions.map(
		(document): ApplicableInstructionReference => ({
			kind: "applicable-instruction",
			path: document.path,
			precedence: document.precedence,
			contentDigest: document.contentDigest,
			locator: document.path,
		}),
	);
	for (const reference of memoryRefs) {
		const binding = reference === "M0" ? null : registry.memory.resolve(reference, "memoryRefs");
		const memoryReference: EvolutionMemoryReference = {
			kind: "evolution-memory",
			memoryItemId: binding?.item.memoryItemId ?? null,
			contentDigest: binding?.item.contentDigest ?? registry.renderedMemoryDigest,
			locator: binding?.block.content ?? "complete-memory",
		};
		relevantEntries.push(memoryReference);
	}
	return {
		classification: relevantEntries.length === 0 ? "novel" : "strengthens",
		relevantEntries,
		strengthening: null,
	};
}

function addition(value: unknown, registry: CuratorToolRegistry): EvolutionMemoryAddDelta {
	if (!isRecord(value)) throw new Error("ADD exactDelta must be an object");
	assertOnlyFields(value, ["operation", "destination", "content", "intendedScope"], "ADD exactDelta");
	if (value.operation !== "ADD") throw new Error("ADD exactDelta operation must be ADD");
	if (!isRecord(value.destination)) throw new Error("ADD destination must be an object");
	assertOnlyFields(value.destination, ["section", "anchor"], "ADD destination");
	const section = nullableString(value.destination, "section");
	const anchorReference = nullableString(value.destination, "anchor");
	const anchorBinding = anchorReference === null ? null : registry.memory.resolve(anchorReference, "anchor");
	if (section !== null && anchorBinding !== null && anchorBinding.block.section !== section) {
		throw new Error(`ADD anchor "${anchorReference}" is outside section "${section}"`);
	}
	const content = requiredString(value, "content");
	assertEvolutionMemoryLessonContent(content);
	return {
		operation: "ADD",
		destination: { section, anchor: anchorBinding?.block.content ?? null },
		content,
		intendedScope: stringArray(value.intendedScope, "intendedScope", false),
	};
}

function removal(
	value: unknown,
	registry: CuratorToolRegistry,
	capabilities: CuratorCapabilities,
	nested: boolean,
): EvolutionMemoryRemoveDelta {
	if (!isRecord(value)) throw new Error("REMOVE exactDelta must be an object");
	assertOnlyFields(
		value,
		nested ? ["memoryRef", "reason"] : ["operation", "memoryRef", "reason"],
		"REMOVE exactDelta",
	);
	if (!nested && value.operation !== "REMOVE") throw new Error("REMOVE exactDelta operation must be REMOVE");
	const reference = requiredString(value, "memoryRef");
	if (!capabilities.removableMemoryRefs.includes(reference)) {
		throw new EvolutionModelReferenceError(
			"memoryRef",
			[reference],
			capabilities.removableMemoryRefs,
			"contains a non-removable or unknown reference",
		);
	}
	const binding = registry.memory.resolve(reference, "memoryRef");
	return {
		operation: "REMOVE",
		memoryItemId: binding.item.memoryItemId,
		expectedContentDigest: binding.item.contentDigest,
		reason: requiredString(value, "reason"),
	};
}

function replacement(
	value: unknown,
	registry: CuratorToolRegistry,
	capabilities: CuratorCapabilities,
): EvolutionMemoryReplaceDelta {
	if (!isRecord(value)) throw new Error("REPLACE exactDelta must be an object");
	assertOnlyFields(value, ["operation", "removal", "addition"], "REPLACE exactDelta");
	if (value.operation !== "REPLACE") throw new Error("REPLACE exactDelta operation must be REPLACE");
	const parsedRemoval = removal(value.removal, registry, capabilities, true);
	if (!isRecord(value.addition)) throw new Error("REPLACE addition must be an object");
	assertOnlyFields(value.addition, ["content", "intendedScope"], "REPLACE addition");
	const content = requiredString(value.addition, "content");
	assertEvolutionMemoryLessonContent(content);
	const { operation: _removeOperation, ...removalDelta } = parsedRemoval;
	return {
		operation: "REPLACE",
		removal: removalDelta,
		addition: {
			content,
			intendedScope: stringArray(value.addition.intendedScope, "intendedScope", false),
		},
	};
}

function delta(
	value: unknown,
	action: ProposalDraft["action"],
	registry: CuratorToolRegistry,
	capabilities: CuratorCapabilities,
): EvolutionMemoryDelta {
	if (action === "ADD") return addition(value, registry);
	if (action === "REMOVE") return removal(value, registry, capabilities, false);
	return replacement(value, registry, capabilities);
}

function proposalDraft(
	value: Readonly<Record<string, unknown>>,
	registry: CuratorToolRegistry,
	capabilities: CuratorCapabilities,
): ProposalDraft {
	const decisionKey = atPath("decisionKey", () => requiredString(value, "decisionKey"));
	const selectedLessons = atPath("lessonRefs", () =>
		referenceArray(value.lessonRefs, "lessonRefs", registry.lessons, { allowEmpty: false }),
	);
	const action = atPath("action", () => {
		if (
			(value.action !== "ADD" && value.action !== "REMOVE" && value.action !== "REPLACE") ||
			!capabilities.memoryOperations.includes(value.action)
		) {
			throw new Error(`Unsupported proposal action "${String(value.action)}"`);
		}
		return value.action;
	});
	return {
		decisionKey,
		lessonIds: selectedLessons.map((lesson) => lesson.lessonId),
		relationship: guidanceRelationship(value.instructionRefs, value.memoryRefs, registry),
		action,
		exactDelta: atPath("exactDelta", () => delta(value.exactDelta, action, registry, capabilities)),
		conflictingDecisionKeys: atPath("conflictingDecisionKeys", () =>
			stringArray(value.conflictingDecisionKeys, "conflictingDecisionKeys"),
		),
	};
}

function finalLessons(input: CuratorInput): readonly Lesson[] {
	const lessonsById = new Map(input.reflection.lessons.map((lesson) => [lesson.lessonId, lesson]));
	if (new Set(input.reflection.finalLessonIds).size !== input.reflection.finalLessonIds.length) {
		throw new EvolutionExecutionError("Final reflection lessons contain duplicate IDs", {
			reasonCode: "artifact-corrupt",
			retryable: false,
		});
	}
	return input.reflection.finalLessonIds.map((lessonId) => {
		const lesson = lessonsById.get(lessonId);
		if (lesson === undefined) {
			throw new EvolutionExecutionError(`Final reflection lesson "${lessonId}" is missing`, {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		return lesson;
	});
}

function evidenceIndex(input: CuratorInput): ReadonlyMap<string, EvidenceContext> {
	const result = new Map<string, EvidenceContext>();
	for (const source of input.input.evidenceSources) {
		const document = input.corpus.documents.find(
			(candidate) =>
				candidate.sourceId === source.sourceId && candidate.materializationId === source.materializationId,
		);
		if (document === undefined) {
			throw new EvolutionExecutionError(`Corpus document for evidence source "${source.sourceId}" is missing`, {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		const permittedEvidenceIds = new Set(document.evidenceIds);
		for (const evidence of source.invocation.evidence) {
			if (!permittedEvidenceIds.has(evidence.evidenceId)) continue;
			if (result.has(evidence.evidenceId)) {
				throw new EvolutionExecutionError(`Evidence ID "${evidence.evidenceId}" is not unique`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
				});
			}
			result.set(evidence.evidenceId, {
				materializationId: source.materializationId,
				traceId: source.invocation.traceId,
				invocation: source.invocation,
				evidence,
			});
		}
	}
	return result;
}

function assertLessonEvidence(lessons: readonly Lesson[], index: ReadonlyMap<string, EvidenceContext>): void {
	for (const lesson of lessons) {
		for (const evidenceId of [...lesson.evidenceIds, ...lesson.counterevidenceIds]) {
			if (!index.has(evidenceId)) {
				throw new EvolutionExecutionError(`Final lesson "${lesson.lessonId}" cites unavailable evidence`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
					diagnostics: { lessonId: lesson.lessonId, evidenceId },
				});
			}
		}
	}
}

function parseDecisions(
	output: JsonObject,
	registry: CuratorToolRegistry,
	capabilities: CuratorCapabilities,
): readonly ProposalDraft[] {
	assertOnlyFields(output, ["decisions"], "Curator response");
	if (!Array.isArray(output.decisions)) throw new Error("Curator response decisions must be an array");
	const seenDecisionKeys = new Set<string>();
	const drafts: ProposalDraft[] = [];
	const draftIndexes = new Map<string, number>();
	const issues: CuratorDecisionValidationIssue[] = [];
	for (const [index, value] of output.decisions.entries()) {
		let decisionKey = isRecord(value) && typeof value.decisionKey === "string" ? value.decisionKey : null;
		try {
			if (!isRecord(value)) throw new Error("Curator decision must be an object");
			assertOnlyFields(
				value,
				[
					"decisionKey",
					"lessonRefs",
					"instructionRefs",
					"memoryRefs",
					"action",
					"exactDelta",
					"conflictingDecisionKeys",
				],
				"Curator decision",
			);
			decisionKey = atPath("decisionKey", () => {
				const parsed = requiredString(value, "decisionKey");
				if (!PROPOSAL_ID_PATTERN.test(parsed)) throw new Error(`Invalid decision key "${parsed}"`);
				if (seenDecisionKeys.has(parsed)) throw new Error(`Duplicate decision key "${parsed}"`);
				return parsed;
			});
			seenDecisionKeys.add(decisionKey);
			const draft = proposalDraft(value, registry, capabilities);
			drafts.push(draft);
			draftIndexes.set(draft.decisionKey, index);
		} catch (error) {
			issues.push(decisionValidationIssue(error, index, decisionKey));
		}
	}
	const emittedDecisionKeys = new Set(drafts.map((draft) => draft.decisionKey));
	for (const draft of drafts) {
		for (const [conflictIndex, conflictingDecisionKey] of draft.conflictingDecisionKeys.entries()) {
			if (conflictingDecisionKey === draft.decisionKey) {
				issues.push({
					decisionKey: draft.decisionKey,
					path: `decisions[${String(draftIndexes.get(draft.decisionKey) ?? 0)}].conflictingDecisionKeys[${String(conflictIndex)}]`,
					message: `Decision "${draft.decisionKey}" cannot conflict with itself`,
					invalidReferences: [],
					permittedReferences: [],
				});
				continue;
			}
			if (!emittedDecisionKeys.has(conflictingDecisionKey)) {
				issues.push({
					decisionKey: draft.decisionKey,
					path: `decisions[${String(draftIndexes.get(draft.decisionKey) ?? 0)}].conflictingDecisionKeys[${String(conflictIndex)}]`,
					message: `Decision "${draft.decisionKey}" cites unknown conflict "${conflictingDecisionKey}"`,
					invalidReferences: [],
					permittedReferences: [],
				});
			}
		}
	}
	if (issues.length > 0) throw new CuratorOutputValidationError(issues);
	return drafts;
}

function evidenceReferences(
	lessons: readonly Lesson[],
	index: ReadonlyMap<string, EvidenceContext>,
): {
	readonly supportingEvidenceIds: readonly string[];
	readonly contradictingEvidenceIds: readonly string[];
	readonly supportingTraceIds: readonly string[];
	readonly contradictingTraceIds: readonly string[];
} {
	const supportingEvidenceIds = unique(lessons.flatMap((lesson) => lesson.evidenceIds));
	const contradictingEvidenceIds = unique(lessons.flatMap((lesson) => lesson.counterevidenceIds));
	if (supportingEvidenceIds.length === 0) throw new Error("A proposal must retain supporting evidence");
	for (const evidenceId of [...supportingEvidenceIds, ...contradictingEvidenceIds]) {
		if (!index.has(evidenceId)) throw new Error(`Lesson cites unknown evidence "${evidenceId}"`);
	}
	const traceIds = (evidenceIds: readonly string[]) =>
		unique(
			evidenceIds
				.map((evidenceId) => index.get(evidenceId)?.traceId ?? null)
				.filter((traceId): traceId is string => traceId !== null),
		);
	return {
		supportingEvidenceIds,
		contradictingEvidenceIds,
		supportingTraceIds: traceIds(supportingEvidenceIds),
		contradictingTraceIds: traceIds(contradictingEvidenceIds),
	};
}

function harnessVersions(invocation: MaterializedInvocation): readonly HarnessVersion[] {
	return unique(
		invocation.evidence.flatMap((evidence) =>
			evidence.kind === "trace_record" && evidence.payload.type === "harness_activate"
				? [evidence.payload.harnessVersion]
				: [],
		),
	);
}

function taskLineageIds(evidence: readonly MaterializedEvidence[]): readonly string[] {
	return unique(
		evidence.flatMap((item) =>
			item.order.causalIdentifiers
				.filter((identifier) => {
					const normalized = identifier.name.toLowerCase();
					return normalized.includes("task") && normalized.includes("lineage");
				})
				.map((identifier) => identifier.value),
		),
	);
}

function proposalScope(
	input: CuratorInput,
	lessons: readonly Lesson[],
	references: ReturnType<typeof evidenceReferences>,
	index: ReadonlyMap<string, EvidenceContext>,
): EvolutionProposalScope {
	const evidence = [...references.supportingEvidenceIds, ...references.contradictingEvidenceIds].map((evidenceId) => {
		const context = index.get(evidenceId);
		if (context === undefined) throw new Error(`Evidence "${evidenceId}" is unavailable`);
		return context;
	});
	const invocations = [...new Set(evidence.map((context) => context.invocation))];
	return {
		repository: input.input.metadata.scope,
		repositoryRevision: input.input.repository.revision,
		materializationIds: unique(evidence.map((context) => context.materializationId)),
		traceIds: unique(evidence.flatMap((context) => (context.traceId === null ? [] : [context.traceId]))),
		sessionIds: unique(
			evidence.flatMap((context) =>
				context.evidence.sessionSource === undefined ? [] : [context.evidence.sessionSource.sessionId],
			),
		),
		taskLineageIds: taskLineageIds(evidence.map((context) => context.evidence)),
		runtimeKinds: unique(invocations.flatMap((invocation) => invocation.producer?.runtime.kind ?? [])),
		runtimeVersions: unique(invocations.flatMap((invocation) => invocation.producer?.runtime.version ?? [])),
		sourceRevisions: unique(invocations.flatMap((invocation) => invocation.producer?.sourceRevision ?? [])),
		harnessVersions: unique(invocations.flatMap(harnessVersions)),
		applicabilityBoundaries: unique(lessons.flatMap((lesson) => lesson.applicabilityBoundaries)),
	};
}

function derivedProposalAudit(
	delta: EvolutionMemoryDelta,
	lessons: readonly Lesson[],
	references: ReturnType<typeof evidenceReferences>,
): {
	readonly expectedBenefit: string;
	readonly acceptanceCriterion: string;
	readonly risk: string;
	readonly rollbackDescription: string;
	readonly curatorConfidence: number;
	readonly uncertainty: string | null;
	readonly counterexamples: readonly string[];
} {
	const uncertainty = unique(lessons.flatMap((lesson) => lesson.uncertainty ?? []));
	const applicabilityBoundaries = unique(lessons.flatMap((lesson) => lesson.applicabilityBoundaries));
	const evidenceCount = references.supportingEvidenceIds.length + references.contradictingEvidenceIds.length;
	const expectedBenefit = unique(lessons.map((lesson) => lesson.actionableTakeaway)).join(" ");
	const acceptanceCriterion =
		delta.operation === "ADD"
			? `EVOLVE.md contains exactly one item with content: ${delta.content}`
			: delta.operation === "REMOVE"
				? `EVOLVE.md no longer contains memory item ${delta.memoryItemId}.`
				: `EVOLVE.md replaces memory item ${delta.removal.memoryItemId} with: ${delta.addition.content}`;
	const rollbackDescription =
		delta.operation === "ADD"
			? "Restore the parent harness revision to remove the added memory item."
			: delta.operation === "REMOVE"
				? "Restore the parent harness revision to recover the removed memory item."
				: "Restore the parent harness revision to reverse the replacement.";
	return {
		expectedBenefit,
		acceptanceCriterion,
		risk:
			uncertainty.length > 0
				? uncertainty.join(" ")
				: `Apply only within: ${applicabilityBoundaries.join(", ") || "the cited lesson scope"}.`,
		rollbackDescription,
		curatorConfidence: evidenceCount === 0 ? 0 : references.supportingEvidenceIds.length / evidenceCount,
		uncertainty: uncertainty.length === 0 ? null : uncertainty.join(" "),
		counterexamples: [],
	};
}

function proposalsFromDrafts(
	drafts: readonly ProposalDraft[],
	input: CuratorInput,
	lessons: readonly Lesson[],
	response: EvolutionModelResponse,
	version: string,
): readonly EvolutionProposal[] {
	const lessonsById = new Map(lessons.map((lesson) => [lesson.lessonId, lesson]));
	const evidence = evidenceIndex(input);
	const proposalIds = new Map(
		drafts.map((draft) => [
			draft.decisionKey,
			stableId("proposal", { idempotencyKey: input.idempotencyKey, decisionKey: draft.decisionKey, draft }),
		]),
	);
	const producer: EvolutionArtifactProducer = {
		name: "diffex-evolution-curator",
		version,
		promptVersion: input.input.promptVersions.curator,
		model: {
			provider: response.model.provider,
			model: response.model.model,
			configurationDigest: input.input.modelConfiguration.configurationDigest,
		},
	};
	return drafts.map((draft): EvolutionProposal => {
		const selectedLessons = draft.lessonIds.map((lessonId) => {
			const lesson = lessonsById.get(lessonId);
			if (lesson === undefined) throw new Error(`Lesson "${lessonId}" is unavailable`);
			return lesson;
		});
		const references = evidenceReferences(selectedLessons, evidence);
		const proposalId = proposalIds.get(draft.decisionKey);
		if (proposalId === undefined) throw new Error(`Proposal ID for "${draft.decisionKey}" is unavailable`);
		const target = {
			kind: "evolution-memory" as const,
			expectedHarnessVersion: input.input.expectedHarnessBaseVersion,
		};
		const common = {
			proposalId,
			scope: proposalScope(input, selectedLessons, references, evidence),
			lessonIds: draft.lessonIds,
			...references,
			...derivedProposalAudit(draft.exactDelta, selectedLessons, references),
			conflictingProposalIds: draft.conflictingDecisionKeys.map((key) => {
				const conflictingId = proposalIds.get(key);
				if (conflictingId === undefined) throw new Error(`Proposal ID for conflict "${key}" is unavailable`);
				return conflictingId;
			}),
			instructionRelationship: draft.relationship,
		};
		const content = {
			...common,
			disposition: "actionable" as const,
			target,
			action: draft.action,
			exactDelta: draft.exactDelta,
			expectedBaseDigest: input.input.harness.memoryContentDigest,
		};
		const metadata = createEvolutionArtifactMetadata({
			artifactId: proposalId,
			producer,
			sourceIds: unique([
				...draft.lessonIds,
				...references.supportingEvidenceIds,
				...references.contradictingEvidenceIds,
			]),
			scope: input.input.metadata.scope,
			createdAt: input.input.metadata.createdAt,
			content,
		});
		return { metadata, ...content };
	});
}

function modelInput(
	input: CuratorInput,
	registry: CuratorToolRegistry,
	capabilities: CuratorCapabilities,
	responseCorrection: string | null,
): JsonObject {
	return {
		control: {
			objective: "curate-evolution-memory-deltas",
			returnOnlySchemaConformingOutput: true,
			outputContainsOnlyMutationInputsAndReferences: true,
			targetIsAlwaysEvolutionMemory: true,
			omitDuplicates: true,
			omitHigherPriorityConflicts: true,
			consolidateOverlappingLessons: true,
			emitOnlyBehaviorChangingProposals: true,
			requireUserTaskOrMeaningfulFailure: true,
			requireCausalAgentBehavior: true,
			requireConcreteFutureBehaviorChange: true,
			requireVerifiableExpectedResult: true,
			omitObserverDocumentation: true,
			omitTelemetryFormatFacts: true,
			routeUsefulTelemetryFactsToDebuggingDocumentation: true,
			memoryOperations: capabilities.memoryOperations,
			additionAnchorReferences: capabilities.allMemoryRefs,
			removableMemoryReferences: capabilities.removableMemoryRefs,
			additionAnchorRule:
				"Use an existing memoryRef to insert after that item, null to append within a named section, or null with a null section to append globally. Sentinels such as end are invalid.",
			maxEvolutionMemoryLessonSentences: EVOLUTION_MEMORY_MAX_LESSON_SENTENCES,
			omitEvolutionMemoryLessonNumber: true,
			...(responseCorrection === null
				? {}
				: {
						responseCorrection: {
							reason: responseCorrection,
							instruction: "Correct the structured response using only permitted references.",
						},
					}),
		},
		jobId: input.jobId,
		lessons: registry.lessonCatalog,
		instructions: registry.instructionCatalog,
		memory: registry.memoryCatalog,
	};
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export class StructuredDeltaCurator implements Curator {
	readonly #dependencies: StructuredDeltaCuratorDependencies;
	readonly #maxResponseAttempts: number;

	constructor(dependencies: StructuredDeltaCuratorDependencies, options: StructuredDeltaCuratorOptions = {}) {
		this.#dependencies = dependencies;
		this.#maxResponseAttempts = positiveInteger(
			options.maxResponseAttempts,
			DEFAULT_MAX_RESPONSE_ATTEMPTS,
			"maxResponseAttempts",
		);
	}

	async curate(input: CuratorInput): Promise<readonly EvolutionProposal[]> {
		input.signal?.throwIfAborted();
		const lessons = finalLessons(input);
		assertLessonEvidence(lessons, evidenceIndex(input));
		const producer: EvolutionArtifactProducer = {
			name: "diffex-evolution-curator",
			version: this.#dependencies.version,
			promptVersion: input.input.promptVersions.curator,
			model: input.input.modelConfiguration,
		};
		const registry = new CuratorToolRegistry({
			jobId: input.jobId,
			input: input.input,
			lessons,
			instructions: input.instructions.documents,
			signal: input.signal,
			audit: (audit) => this.#auditTool(input, producer, audit),
		});
		const capabilities = registry.capabilities;
		const schema = createCuratorOutputSchema(capabilities);
		const validateOutput = (output: JsonObject): void => {
			parseDecisions(output, registry, capabilities);
		};
		let lastError: unknown = null;
		let responseCorrection: string | null = null;
		const invalidAliases = new Set<string>();
		const permittedAliases = new Set<string>();
		const attemptDetails: JsonObject[] = [];
		try {
			for (let attempt = 1; attempt <= this.#maxResponseAttempts; attempt += 1) {
				const response = await abortable(
					input.model.execute({
						stage: "curator",
						model: input.input.modelConfiguration,
						promptVersion: input.input.promptVersions.curator,
						idempotencyKey: input.idempotencyKey,
						input: modelInput(input, registry, capabilities, responseCorrection),
						outputSchema: schema,
						tools: registry.tools,
						validateOutput,
						signal: input.signal,
					}),
					input.signal,
				);
				try {
					const drafts = parseDecisions(response.output, registry, capabilities);
					return proposalsFromDrafts(drafts, input, lessons, response, this.#dependencies.version);
				} catch (error) {
					lastError = error;
					responseCorrection = error instanceof Error ? error.message : "Response validation failed";
					if (error instanceof CuratorOutputValidationError) {
						for (const reference of error.invalidReferences) invalidAliases.add(reference);
						for (const reference of error.permittedReferences) permittedAliases.add(reference);
					} else if (error instanceof EvolutionModelReferenceError) {
						for (const reference of error.invalidReferences) invalidAliases.add(reference);
						for (const reference of error.permittedReferences) permittedAliases.add(reference);
					}
					attemptDetails.push({
						attempt,
						model: response.model,
						submissionMethod: response.submissionMethod ?? "unspecified",
						validationError: responseCorrection,
						output: response.output,
					});
				}
			}
		} finally {
			registry.revoke();
		}
		throw new EvolutionExecutionError("Curator returned an invalid structured response", {
			reasonCode: "curation-invalid-response",
			retryable: false,
			cause: lastError,
			diagnostics: {
				invalidAliases: [...invalidAliases],
				permittedAliases: [...permittedAliases],
				attemptDetails,
				aliasResolutionMaps: {
					instructions: registry.instructions.resolutionMap((instruction) => instruction.path),
					lessons: registry.lessons.resolutionMap((lesson) => lesson.lessonId),
					memory: registry.memory.resolutionMap((binding) => binding.item.memoryItemId),
				},
				recoverableToolDenials: registry.recoverableDenials.map((denial) => ({
					toolName: denial.toolName,
					denialCode: denial.denialCode,
					requestedReferences: denial.requestedReferences,
				})),
			},
		});
	}

	async #auditTool(input: CuratorInput, producer: EvolutionArtifactProducer, audit: CuratorToolAudit): Promise<void> {
		if (this.#dependencies.ledger === undefined) return;
		const eventId = stableId("ledger-event", { jobId: input.jobId, type: "curator-tool-call", audit });
		const event: CuratorToolCallLedgerEvent = {
			metadata: createEvolutionArtifactMetadata({
				artifactId: eventId,
				producer,
				sourceIds: unique([
					...audit.resolvedInstructionPaths,
					...audit.resolvedLessonIds,
					...audit.resolvedMemoryItemIds,
				]),
				scope: input.input.metadata.scope,
				createdAt: input.input.metadata.createdAt,
				content: audit,
			}),
			eventId,
			jobId: input.jobId,
			type: "curator-tool-call",
			...audit,
		};
		await this.#dependencies.ledger.append(event);
	}
}
