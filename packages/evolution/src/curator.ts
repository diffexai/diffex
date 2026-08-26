import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type {
	ApplicableInstructionReference,
	CuratorToolCallLedgerEvent,
	DeferredEvolutionProposal,
	EvolutionArtifactProducer,
	EvolutionMemoryAddDelta,
	EvolutionMemoryDelta,
	EvolutionMemoryReference,
	EvolutionMemoryRemoveDelta,
	EvolutionMemoryReplaceDelta,
	EvolutionProposal,
	EvolutionProposalInstructionRelationship,
	EvolutionProposalScope,
	EvolutionTarget,
	ExistingInstructionReference,
	InstructionRelationshipClassification,
	InstructionStrengthening,
	InstructionStrengtheningKind,
	JsonObject,
	Lesson,
} from "./contracts.ts";
import { type CuratorToolAudit, CuratorToolRegistry } from "./curator-tools.ts";
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
const STRENGTHENING_KINDS = new Set<InstructionStrengtheningKind>([
	"applicability-boundary",
	"condition",
	"enforcement",
	"precision",
]);
const RELATIONSHIPS = new Set<InstructionRelationshipClassification>([
	"conflicts",
	"duplicate",
	"novel",
	"strengthens",
]);

interface CuratorSchemaReferences {
	readonly instructionRefs: readonly string[];
	readonly lessonRefs: readonly string[];
	readonly memoryRefs: readonly string[];
}

export function createCuratorOutputSchema(references: CuratorSchemaReferences): JsonObject {
	const stringArray = { type: "array", items: { type: "string", minLength: 1 } };
	const referenceArraySchema = (values: readonly string[], minItems = 0): JsonObject => ({
		type: "array",
		minItems,
		items: { type: "string", enum: values },
	});
	return {
		$defs: {
			relevance: {
				type: "object",
				additionalProperties: false,
				required: [
					"userTaskOrFailure",
					"causalAgentBehavior",
					"futureBehaviorChange",
					"verifiableExpectedResult",
					"observerDocumentationOnly",
					"telemetryFormatOnly",
				],
				properties: {
					userTaskOrFailure: { type: "string", minLength: 1 },
					causalAgentBehavior: { type: "string", minLength: 1 },
					futureBehaviorChange: { type: "string", minLength: 1 },
					verifiableExpectedResult: { type: "string", minLength: 1 },
					observerDocumentationOnly: { enum: [false] },
					telemetryFormatOnly: { enum: [false] },
				},
			},
			strengthening: {
				anyOf: [
					{ type: "null" },
					{
						type: "object",
						additionalProperties: false,
						required: ["kind", "description"],
						properties: {
							kind: { enum: [...STRENGTHENING_KINDS] },
							description: { type: "string", minLength: 1 },
						},
					},
				],
			},
			relationship: {
				type: "object",
				additionalProperties: false,
				required: ["classification", "instructionRefs", "memoryRefs", "strengthening"],
				properties: {
					classification: { enum: [...RELATIONSHIPS] },
					instructionRefs: referenceArraySchema(references.instructionRefs),
					memoryRefs: referenceArraySchema(["M0", ...references.memoryRefs]),
					strengthening: { $ref: "#/$defs/strengthening" },
				},
			},
			target: {
				anyOf: [
					{
						type: "object",
						additionalProperties: false,
						required: ["kind"],
						properties: { kind: { enum: ["evolution-memory"] } },
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["kind", "skillName"],
						properties: {
							kind: { enum: ["skill"] },
							skillName: { type: "string", minLength: 1 },
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["kind", "sourcePath"],
						properties: {
							kind: { enum: ["orchestration-source"] },
							sourcePath: { type: "string", minLength: 1 },
						},
					},
				],
			},
			destination: {
				type: "object",
				additionalProperties: false,
				required: ["section", "anchor"],
				properties: {
					section: { type: ["string", "null"] },
					anchor: {
						enum: [null, ...references.memoryRefs],
						description: "Existing memory item reference to insert after, or null to append within the section.",
					},
				},
			},
			addition: {
				type: "object",
				additionalProperties: false,
				required: ["destination", "content", "intendedScope"],
				properties: {
					destination: { $ref: "#/$defs/destination" },
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
					memoryRef: { type: "string", enum: references.memoryRefs },
					reason: { type: "string", minLength: 1 },
				},
			},
			exactDelta: {
				anyOf: [
					{
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
					{
						type: "object",
						additionalProperties: false,
						required: ["operation", "memoryRef", "reason"],
						properties: {
							operation: { enum: ["REMOVE"] },
							memoryRef: { type: "string", enum: references.memoryRefs },
							reason: { type: "string", minLength: 1 },
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["operation", "removal", "addition"],
						properties: {
							operation: { enum: ["REPLACE"] },
							removal: { $ref: "#/$defs/removal" },
							addition: { $ref: "#/$defs/addition" },
						},
					},
					{ type: "null" },
				],
			},
			proposal: {
				type: "object",
				additionalProperties: false,
				required: [
					"target",
					"action",
					"exactDelta",
					"expectedBenefit",
					"acceptanceCriterion",
					"risk",
					"rollbackDescription",
					"curatorConfidence",
					"uncertainty",
					"counterexamples",
					"conflictingDecisionKeys",
					"finding",
				],
				properties: {
					target: { $ref: "#/$defs/target" },
					action: { enum: ["ADD", "DEFER", "REMOVE", "REPLACE"] },
					exactDelta: { $ref: "#/$defs/exactDelta" },
					expectedBenefit: { type: "string", minLength: 1 },
					acceptanceCriterion: { type: "string", minLength: 1 },
					risk: { type: "string", minLength: 1 },
					rollbackDescription: { type: "string", minLength: 1 },
					curatorConfidence: { type: "number", minimum: 0, maximum: 1 },
					uncertainty: { type: ["string", "null"] },
					counterexamples: stringArray,
					conflictingDecisionKeys: stringArray,
					finding: { type: ["string", "null"] },
				},
			},
		},
		type: "object",
		additionalProperties: false,
		required: ["decisions"],
		properties: {
			decisions: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["decisionKey", "lessonRefs", "relevance", "relationship", "proposal"],
					properties: {
						decisionKey: { type: "string", minLength: 1 },
						lessonRefs: referenceArraySchema(references.lessonRefs, 1),
						relevance: { $ref: "#/$defs/relevance" },
						relationship: { $ref: "#/$defs/relationship" },
						proposal: { anyOf: [{ $ref: "#/$defs/proposal" }, { type: "null" }] },
					},
				},
			},
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
	readonly target: EvolutionTarget;
	readonly action: "ADD" | "DEFER" | "REMOVE" | "REPLACE";
	readonly exactDelta: EvolutionMemoryDelta | null;
	readonly expectedBenefit: string;
	readonly acceptanceCriterion: string;
	readonly risk: string;
	readonly rollbackDescription: string;
	readonly curatorConfidence: number;
	readonly uncertainty: string | null;
	readonly counterexamples: readonly string[];
	readonly conflictingDecisionKeys: readonly string[];
	readonly finding: string | null;
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

function confidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("curatorConfidence must be a finite number from 0 through 1");
	}
	return value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function strengthening(value: unknown): InstructionStrengthening | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new Error("strengthening must be an object or null");
	assertOnlyFields(value, ["kind", "description"], "strengthening");
	const kind = value.kind;
	if (typeof kind !== "string" || !STRENGTHENING_KINDS.has(kind as InstructionStrengtheningKind)) {
		throw new Error(`Unsupported strengthening kind "${String(kind)}"`);
	}
	return { kind: kind as InstructionStrengtheningKind, description: requiredString(value, "description") };
}

function relationship(
	value: unknown,
	registry: CuratorToolRegistry,
): {
	readonly classification: InstructionRelationshipClassification;
	readonly relevantEntries: readonly ExistingInstructionReference[];
	readonly strengthening: InstructionStrengthening | null;
} {
	if (!isRecord(value)) throw new Error("relationship must be an object");
	assertOnlyFields(value, ["classification", "instructionRefs", "memoryRefs", "strengthening"], "relationship");
	const classification = value.classification;
	if (
		typeof classification !== "string" ||
		!RELATIONSHIPS.has(classification as InstructionRelationshipClassification)
	) {
		throw new Error(`Unsupported instruction relationship "${String(classification)}"`);
	}
	const instructions = referenceArray(value.instructionRefs, "instructionRefs", registry.instructions);
	if (!Array.isArray(value.memoryRefs) || value.memoryRefs.some((reference) => typeof reference !== "string")) {
		throw new EvolutionModelReferenceError(
			"memoryRefs",
			[],
			["M0", ...registry.memory.references],
			"must be an array of references",
		);
	}
	const memoryRefs = value.memoryRefs as readonly string[];
	if (new Set(memoryRefs).size !== memoryRefs.length) {
		throw new EvolutionModelReferenceError(
			"memoryRefs",
			memoryRefs,
			["M0", ...registry.memory.references],
			"contains duplicates",
		);
	}
	const invalidMemoryRefs = memoryRefs.filter(
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
	const parsedStrengthening = strengthening(value.strengthening);
	if (classification === "strengthens") {
		if (relevantEntries.length === 0) throw new Error("A strengthening must cite an existing entry");
		if (parsedStrengthening === null) throw new Error("A strengthening must describe its concrete delta");
	} else if (parsedStrengthening !== null) {
		throw new Error(`A ${classification} relationship cannot include strengthening details`);
	}
	if ((classification === "duplicate" || classification === "conflicts") && relevantEntries.length === 0) {
		throw new Error(`A ${classification} relationship must cite an existing entry`);
	}
	return {
		classification: classification as InstructionRelationshipClassification,
		relevantEntries,
		strengthening: parsedStrengthening,
	};
}

function target(value: unknown, input: CuratorInput): EvolutionTarget {
	if (!isRecord(value)) throw new Error("target must be an object");
	if (value.kind === "evolution-memory") {
		assertOnlyFields(value, ["kind"], "evolution memory target");
		return { kind: value.kind, expectedHarnessVersion: input.input.expectedHarnessBaseVersion };
	}
	if (value.kind === "skill") {
		assertOnlyFields(value, ["kind", "skillName"], "skill target");
		return { kind: value.kind, skillName: requiredString(value, "skillName") };
	}
	if (value.kind === "orchestration-source") {
		assertOnlyFields(value, ["kind", "sourcePath"], "orchestration source target");
		return { kind: value.kind, sourcePath: requiredString(value, "sourcePath") };
	}
	throw new Error(`Unsupported target kind "${String(value.kind)}"`);
}

function addition(value: unknown, registry: CuratorToolRegistry, nested = false): EvolutionMemoryAddDelta {
	if (!isRecord(value)) throw new Error("ADD exactDelta must be an object");
	assertOnlyFields(
		value,
		nested ? ["destination", "content", "intendedScope"] : ["operation", "destination", "content", "intendedScope"],
		"ADD exactDelta",
	);
	if (!nested && value.operation !== "ADD") throw new Error("ADD exactDelta operation must be ADD");
	if (!isRecord(value.destination)) throw new Error("ADD destination must be an object");
	assertOnlyFields(value.destination, ["section", "anchor"], "ADD destination");
	const section = nullableString(value.destination, "section");
	const anchorReference = nullableString(value.destination, "anchor");
	if (section === null && anchorReference === null) {
		throw new Error("ADD must identify a destination section or anchor");
	}
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

function removal(value: unknown, registry: CuratorToolRegistry, nested: boolean): EvolutionMemoryRemoveDelta {
	if (!isRecord(value)) throw new Error("REMOVE exactDelta must be an object");
	assertOnlyFields(
		value,
		nested ? ["memoryRef", "reason"] : ["operation", "memoryRef", "reason"],
		"REMOVE exactDelta",
	);
	if (!nested && value.operation !== "REMOVE") throw new Error("REMOVE exactDelta operation must be REMOVE");
	const reference = requiredString(value, "memoryRef");
	const binding = registry.memory.resolve(reference, "memoryRef");
	return {
		operation: "REMOVE",
		memoryItemId: binding.item.memoryItemId,
		expectedContentDigest: binding.item.contentDigest,
		reason: requiredString(value, "reason"),
	};
}

function replacement(value: unknown, registry: CuratorToolRegistry): EvolutionMemoryReplaceDelta {
	if (!isRecord(value)) throw new Error("REPLACE exactDelta must be an object");
	assertOnlyFields(value, ["operation", "removal", "addition"], "REPLACE exactDelta");
	if (value.operation !== "REPLACE") throw new Error("REPLACE exactDelta operation must be REPLACE");
	const parsedRemoval = removal(value.removal, registry, true);
	const parsedAddition = addition(value.addition, registry, true);
	if (
		parsedAddition.destination.anchor !== null &&
		computeEvolutionContentDigest(parsedAddition.destination.anchor) === parsedRemoval.expectedContentDigest
	) {
		throw new Error("REPLACE addition cannot anchor to the memory item being removed");
	}
	const { operation: _removeOperation, ...removalDelta } = parsedRemoval;
	const { operation: _addOperation, ...additionDelta } = parsedAddition;
	return { operation: "REPLACE", removal: removalDelta, addition: additionDelta };
}

function delta(
	value: unknown,
	action: ProposalDraft["action"],
	registry: CuratorToolRegistry,
): EvolutionMemoryDelta | null {
	if (action === "DEFER") {
		if (value !== null) throw new Error("Deferred proposals cannot include exactDelta");
		return null;
	}
	if (action === "ADD") return addition(value, registry);
	if (action === "REMOVE") return removal(value, registry, false);
	return replacement(value, registry);
}

function proposalDraft(
	value: unknown,
	decisionKey: string,
	lessonIds: readonly string[],
	parsedRelationship: EvolutionProposalInstructionRelationship,
	input: CuratorInput,
	registry: CuratorToolRegistry,
): ProposalDraft {
	if (!isRecord(value)) throw new Error("proposal must be an object");
	assertOnlyFields(
		value,
		[
			"target",
			"action",
			"exactDelta",
			"expectedBenefit",
			"acceptanceCriterion",
			"risk",
			"rollbackDescription",
			"curatorConfidence",
			"uncertainty",
			"counterexamples",
			"conflictingDecisionKeys",
			"finding",
		],
		"proposal",
	);
	const parsedTarget = target(value.target, input);
	const action = value.action;
	if (action !== "ADD" && action !== "DEFER" && action !== "REMOVE" && action !== "REPLACE") {
		throw new Error(`Unsupported proposal action "${String(action)}"`);
	}
	if (parsedTarget.kind === "evolution-memory" && action === "DEFER") {
		throw new Error("Evolution memory proposals must contain an executable delta");
	}
	if (parsedTarget.kind !== "evolution-memory" && action !== "DEFER") {
		throw new Error(`Target "${parsedTarget.kind}" must be deferred`);
	}
	const finding = value.finding;
	if (action === "DEFER") {
		if (typeof finding !== "string" || finding.length === 0)
			throw new Error("Deferred proposals must include a finding");
	} else if (finding !== null) {
		throw new Error("Actionable proposal finding must be null");
	}
	return {
		decisionKey,
		lessonIds,
		relationship: parsedRelationship,
		target: parsedTarget,
		action,
		exactDelta: delta(value.exactDelta, action, registry),
		expectedBenefit: requiredString(value, "expectedBenefit"),
		acceptanceCriterion: requiredString(value, "acceptanceCriterion"),
		risk: requiredString(value, "risk"),
		rollbackDescription: requiredString(value, "rollbackDescription"),
		curatorConfidence: confidence(value.curatorConfidence),
		uncertainty: nullableString(value, "uncertainty"),
		counterexamples: stringArray(value.counterexamples, "counterexamples"),
		conflictingDecisionKeys: stringArray(value.conflictingDecisionKeys, "conflictingDecisionKeys"),
		finding: typeof finding === "string" ? finding : null,
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
	response: EvolutionModelResponse,
	input: CuratorInput,
	registry: CuratorToolRegistry,
): readonly ProposalDraft[] {
	assertOnlyFields(response.output, ["decisions"], "Curator response");
	if (!Array.isArray(response.output.decisions)) throw new Error("Curator response decisions must be an array");
	const seenDecisionKeys = new Set<string>();
	const drafts: ProposalDraft[] = [];
	for (const value of response.output.decisions) {
		if (!isRecord(value)) throw new Error("Curator decision must be an object");
		assertOnlyFields(
			value,
			["decisionKey", "lessonRefs", "relevance", "relationship", "proposal"],
			"Curator decision",
		);
		const decisionKey = requiredString(value, "decisionKey");
		if (!PROPOSAL_ID_PATTERN.test(decisionKey)) throw new Error(`Invalid decision key "${decisionKey}"`);
		if (seenDecisionKeys.has(decisionKey)) throw new Error(`Duplicate decision key "${decisionKey}"`);
		seenDecisionKeys.add(decisionKey);
		if (!isRecord(value.relevance)) throw new Error("relevance must be an object");
		assertOnlyFields(
			value.relevance,
			[
				"userTaskOrFailure",
				"causalAgentBehavior",
				"futureBehaviorChange",
				"verifiableExpectedResult",
				"observerDocumentationOnly",
				"telemetryFormatOnly",
			],
			"relevance",
		);
		for (const field of [
			"userTaskOrFailure",
			"causalAgentBehavior",
			"futureBehaviorChange",
			"verifiableExpectedResult",
		] as const) {
			requiredString(value.relevance, field);
		}
		if (value.relevance.observerDocumentationOnly !== false || value.relevance.telemetryFormatOnly !== false) {
			throw new Error("Observer documentation and telemetry-format facts are not actionable evolution memory");
		}
		const selectedLessons = referenceArray(value.lessonRefs, "lessonRefs", registry.lessons, { allowEmpty: false });
		const parsedRelationship = relationship(value.relationship, registry);
		if (parsedRelationship.classification === "duplicate" || parsedRelationship.classification === "conflicts") {
			if (value.proposal !== null) {
				throw new Error(`${parsedRelationship.classification} decisions must not contain a proposal`);
			}
			continue;
		}
		if (value.proposal === null) throw new Error(`${parsedRelationship.classification} decisions require a proposal`);
		const actionableRelationship: EvolutionProposalInstructionRelationship = {
			classification: parsedRelationship.classification,
			relevantEntries: parsedRelationship.relevantEntries,
			strengthening: parsedRelationship.strengthening,
		};
		drafts.push(
			proposalDraft(
				value.proposal,
				decisionKey,
				selectedLessons.map((lesson) => lesson.lessonId),
				actionableRelationship,
				input,
				registry,
			),
		);
	}
	const emittedDecisionKeys = new Set(drafts.map((draft) => draft.decisionKey));
	for (const draft of drafts) {
		for (const conflictingDecisionKey of draft.conflictingDecisionKeys) {
			if (conflictingDecisionKey === draft.decisionKey) {
				throw new Error(`Decision "${draft.decisionKey}" cannot conflict with itself`);
			}
			if (!emittedDecisionKeys.has(conflictingDecisionKey)) {
				throw new Error(`Decision "${draft.decisionKey}" cites unknown conflict "${conflictingDecisionKey}"`);
			}
		}
	}
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
		const common = {
			proposalId,
			scope: proposalScope(input, selectedLessons, references, evidence),
			lessonIds: draft.lessonIds,
			...references,
			expectedBenefit: draft.expectedBenefit,
			acceptanceCriterion: draft.acceptanceCriterion,
			risk: draft.risk,
			rollbackDescription: draft.rollbackDescription,
			curatorConfidence: draft.curatorConfidence,
			uncertainty: draft.uncertainty,
			counterexamples: draft.counterexamples,
			conflictingProposalIds: draft.conflictingDecisionKeys.map((key) => {
				const conflictingId = proposalIds.get(key);
				if (conflictingId === undefined) throw new Error(`Proposal ID for conflict "${key}" is unavailable`);
				return conflictingId;
			}),
			instructionRelationship: draft.relationship,
		};
		const content = {
			...common,
			disposition: draft.target.kind === "evolution-memory" ? "actionable" : "deferred",
			target: draft.target,
			action: draft.action,
			exactDelta: draft.exactDelta,
			expectedBaseDigest: draft.target.kind === "evolution-memory" ? input.input.harness.memoryContentDigest : null,
			...(draft.finding === null ? {} : { finding: draft.finding }),
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
		if (draft.target.kind === "evolution-memory") {
			if (draft.action === "DEFER" || draft.exactDelta === null) {
				throw new Error("Evolution memory proposal lost its executable delta");
			}
			return {
				metadata,
				...common,
				disposition: "actionable",
				target: draft.target,
				action: draft.action,
				exactDelta: draft.exactDelta,
				expectedBaseDigest: input.input.harness.memoryContentDigest,
			};
		}
		if (draft.action !== "DEFER" || draft.exactDelta !== null || draft.finding === null) {
			throw new Error("Deferred proposal contains an executable delta");
		}
		const proposal: DeferredEvolutionProposal = {
			metadata,
			...common,
			disposition: "deferred",
			target: draft.target,
			action: "DEFER",
			exactDelta: null,
			expectedBaseDigest: null,
			finding: draft.finding,
		};
		return proposal;
	});
}

function modelInput(input: CuratorInput, registry: CuratorToolRegistry, responseCorrection: string | null): JsonObject {
	return {
		control: {
			objective: "curate-target-neutral-structured-deltas",
			returnOnlySchemaConformingOutput: true,
			omitDuplicates: true,
			omitHigherPriorityConflicts: true,
			strengthenOnlyWithConcretePrecision: true,
			consolidateOverlappingLessons: true,
			emitOnlyBehaviorChangingProposals: true,
			requireUserTaskOrMeaningfulFailure: true,
			requireCausalAgentBehavior: true,
			requireConcreteFutureBehaviorChange: true,
			requireVerifiableExpectedResult: true,
			omitObserverDocumentation: true,
			omitTelemetryFormatFacts: true,
			routeUsefulTelemetryFactsToDebuggingDocumentation: true,
			memoryOperations: ["ADD", "REMOVE", "REPLACE"],
			additionAnchorReferences: registry.memory.references,
			additionAnchorRule:
				"Use an existing memoryRef to insert after that item, or null to append within the named section. Sentinels such as end are invalid.",
			deferredTargets: ["skill", "orchestration-source"],
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
		const schema = createCuratorOutputSchema({
			instructionRefs: registry.instructions.references,
			lessonRefs: registry.lessons.references,
			memoryRefs: registry.memory.references,
		});
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
						input: modelInput(input, registry, responseCorrection),
						outputSchema: schema,
						tools: registry.tools,
						signal: input.signal,
					}),
					input.signal,
				);
				try {
					const drafts = parseDecisions(response, input, registry);
					return proposalsFromDrafts(drafts, input, lessons, response, this.#dependencies.version);
				} catch (error) {
					lastError = error;
					responseCorrection = error instanceof Error ? error.message : "Response validation failed";
					if (error instanceof EvolutionModelReferenceError) {
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
