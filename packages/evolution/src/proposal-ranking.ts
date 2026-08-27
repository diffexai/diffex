import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type {
	EvidenceRankingScoreComponents,
	EvolutionArtifactProducer,
	EvolutionMemoryAddDelta,
	EvolutionMemoryDelta,
	EvolutionMemoryProposal,
	EvolutionProposal,
	InstructionDocumentSnapshot,
	Lesson,
	ProposalValidationResult,
	ScoredProposal,
	ValidationIssue,
	ValidationReport,
} from "./contracts.ts";
import { evolutionMemoryLessonContentMatches } from "./evolution-memory-lessons.ts";
import { parseEvolutionMemoryBlocks } from "./evolution-memory-writer.ts";
import type { ProposalScorer, ProposalScoringInput, ProposalValidationInput, ProposalValidator } from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

export const EVIDENCE_RANKING_SCORER_VERSION = "evidence-ranking-v1";
export const EVIDENCE_RANKING_ASSURANCE = "provenance-recurrence-and-structure-only" as const;

const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_ELIGIBILITY_THRESHOLD = 40;
const DEFAULT_MAX_SELECTED_PROPOSALS = 5;
const DEFAULT_MINIMUM_INDEPENDENT_TASKS = 2;
const DEFAULT_BROAD_SCOPE_INDEPENDENT_TASKS = 3;
const DEFAULT_MAX_DELTA_BYTES = 8 * 1024;

type EvidenceSignal = "deterministic-outcome" | "direct-user" | "model-self-assessment" | "observable" | "tool-outcome";

interface EvidenceContext {
	readonly evidence: MaterializedEvidence;
	readonly invocation: MaterializedInvocation;
	readonly materializationId: string;
	readonly ingestionCursor: number;
	readonly traceId: string | null;
	readonly taskLineageId: string | null;
	readonly signal: EvidenceSignal;
	readonly signalPoints: number;
	readonly provenancePoints: number;
}

interface ValidatedProposalContext {
	readonly proposal: EvolutionProposal;
	readonly supporting: readonly EvidenceContext[];
	readonly contradicting: readonly EvidenceContext[];
	readonly independentSupportCount: number;
	readonly earliestSupportingTime: string;
	readonly fingerprint: string;
}

export interface DeterministicProposalRankerDependencies {
	readonly version: string;
}

export interface DeterministicProposalRankerOptions {
	readonly eligibilityThreshold?: number;
	readonly maxSelectedProposals?: number;
	readonly minimumIndependentTasks?: number;
	readonly broadScopeIndependentTasks?: number;
	readonly maxDeltaBytes?: number;
}

interface ResolvedOptions {
	readonly eligibilityThreshold: number;
	readonly maxSelectedProposals: number;
	readonly minimumIndependentTasks: number;
	readonly broadScopeIndependentTasks: number;
	readonly maxDeltaBytes: number;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function sorted(values: readonly string[]): string[] {
	return unique(values).sort((left, right) => left.localeCompare(right));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	const sortedLeft = sorted(left);
	const sortedRight = sorted(right);
	return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function hasDuplicates(values: readonly string[]): boolean {
	return new Set(values).size !== values.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function selectionLimit(value: number | undefined): number {
	const resolved = positiveInteger(value, DEFAULT_MAX_SELECTED_PROPOSALS, "maxSelectedProposals");
	if (resolved > DEFAULT_MAX_SELECTED_PROPOSALS) {
		throw new Error(`maxSelectedProposals cannot exceed ${DEFAULT_MAX_SELECTED_PROPOSALS}`);
	}
	return resolved;
}

function boundedScore(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0 || resolved > 100) {
		throw new Error(`${name} must be a finite number from 0 through 100`);
	}
	return resolved;
}

function normalizedText(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function issue(
	proposalId: string,
	code: string,
	message: string,
	severity: ValidationIssue["severity"] = "error",
): ValidationIssue {
	return { code, message, severity, proposalId };
}

function contentWithoutMetadata<T extends { readonly metadata: unknown }>(artifact: T): Omit<T, "metadata"> {
	const { metadata: _metadata, ...content } = artifact;
	return content;
}

function taskLineageId(evidence: MaterializedEvidence): string | null {
	const identifier = evidence.order.causalIdentifiers.find((candidate) => {
		const name = candidate.name.toLocaleLowerCase("en-US");
		return name.includes("task") && name.includes("lineage");
	});
	return identifier?.value ?? null;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: null;
}

function evidenceSignal(evidence: MaterializedEvidence): { readonly signal: EvidenceSignal; readonly points: number } {
	if (evidence.kind === "session_item") {
		const payload = recordValue(evidence.payload);
		const message = recordValue(payload?.message);
		if (message?.role === "user") return { signal: "direct-user", points: 15 };
		if (message?.role === "toolResult" || evidence.itemType.toLocaleLowerCase("en-US").includes("tool")) {
			return { signal: "tool-outcome", points: 9 };
		}
		return { signal: "model-self-assessment", points: 3 };
	}
	if (evidence.kind === "span") {
		return evidence.payload.settled && evidence.payload.status !== null
			? { signal: "deterministic-outcome", points: 12 }
			: { signal: "observable", points: 6 };
	}
	if (evidence.payload.type === "trace_footer") return { signal: "deterministic-outcome", points: 12 };
	if (evidence.payload.type === "span_end" || evidence.payload.type === "span_event") {
		return { signal: "tool-outcome", points: 9 };
	}
	return { signal: "observable", points: 6 };
}

function evidenceProvenancePoints(evidence: MaterializedEvidence, invocation: MaterializedInvocation): number {
	if (invocation.integrity === "complete") return 20;
	if (invocation.integrity === "incompatible") return 0;
	const invalidForBinding = invocation.diagnostics.some(
		(diagnostic) =>
			diagnostic.bindingId !== undefined &&
			diagnostic.bindingId === evidence.sessionSource?.bindingId &&
			[
				"session_changed",
				"session_incompatible",
				"session_invalid",
				"session_missing",
				"session_truncated",
			].includes(diagnostic.code),
	);
	if (invalidForBinding) return 0;
	const beforeVerifiedPrefix = invocation.diagnostics.some(
		(diagnostic) =>
			diagnostic.recoverable === false &&
			diagnostic.traceSequence !== undefined &&
			evidence.order.traceSequence >= diagnostic.traceSequence,
	);
	return beforeVerifiedPrefix ? 0 : 12;
}

function evidenceIndex(input: ProposalValidationInput): {
	readonly index: ReadonlyMap<string, EvidenceContext>;
	readonly globalIssues: readonly ValidationIssue[];
} {
	const index = new Map<string, EvidenceContext>();
	const globalIssues: ValidationIssue[] = [];
	const documents = new Map(input.corpus.documents.map((document) => [document.sourceId, document]));
	if (documents.size !== input.corpus.documents.length) {
		globalIssues.push({
			code: "materialization-registry-mismatch",
			message: "Corpus contains duplicate evidence source registrations",
			severity: "error",
		});
	}
	const sourceIds = new Set(input.input.evidenceSources.map((source) => source.sourceId));
	if (input.corpus.documents.some((document) => !sourceIds.has(document.sourceId))) {
		globalIssues.push({
			code: "materialization-registry-mismatch",
			message: "Corpus contains evidence outside the frozen input snapshot",
			severity: "error",
		});
	}
	for (const source of input.input.evidenceSources) {
		const document = documents.get(source.sourceId);
		if (document === undefined || document.materializationId !== source.materializationId) {
			globalIssues.push({
				code: "materialization-registry-mismatch",
				message: `Evidence source "${source.sourceId}" does not match the materializer-owned corpus registry`,
				severity: "error",
			});
			continue;
		}
		if (
			source.origin !== "product-runtime" ||
			source.ingestionCursor > input.input.ingestionHighWaterCursor ||
			source.contentDigest !== computeEvolutionContentDigest(source.invocation) ||
			document.contentDigest !== source.contentDigest ||
			document.integrity !== source.invocation.integrity ||
			document.traceId !== source.invocation.traceId ||
			document.materializedInvocationVersion !== source.invocation.version
		) {
			globalIssues.push({
				code: "materialization-registry-mismatch",
				message: `Evidence source "${source.sourceId}" failed frozen materialization validation`,
				severity: "error",
			});
			continue;
		}
		for (const evidence of source.invocation.evidence) {
			if (!document.evidenceIds.includes(evidence.evidenceId) || index.has(evidence.evidenceId)) {
				globalIssues.push({
					code: index.has(evidence.evidenceId) ? "duplicate-evidence-id" : "materialization-registry-mismatch",
					message: `Evidence "${evidence.evidenceId}" is not uniquely registered by its materialization`,
					severity: "error",
				});
				continue;
			}
			const signal = evidenceSignal(evidence);
			index.set(evidence.evidenceId, {
				evidence,
				invocation: source.invocation,
				materializationId: source.materializationId,
				ingestionCursor: source.ingestionCursor,
				traceId: source.invocation.traceId,
				taskLineageId: taskLineageId(evidence),
				signal: signal.signal,
				signalPoints: signal.points,
				provenancePoints: evidenceProvenancePoints(evidence, source.invocation),
			});
		}
	}
	return { index, globalIssues };
}

function validateInstructionSnapshots(input: ProposalValidationInput): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (input.input.instructions.length !== input.instructions.documents.length) {
		issues.push({
			code: "instruction-snapshot-stale",
			message: "Applicable instruction paths changed after curation",
			severity: "error",
		});
		return issues;
	}
	for (let index = 0; index < input.input.instructions.length; index += 1) {
		const frozen = input.input.instructions[index];
		const current = input.instructions.documents[index];
		if (
			frozen === undefined ||
			current === undefined ||
			frozen.path !== current.path ||
			frozen.precedence !== current.precedence ||
			frozen.content !== current.content ||
			frozen.contentDigest !== current.contentDigest ||
			computeEvolutionContentDigest(current.content) !== current.contentDigest
		) {
			issues.push({
				code: "instruction-snapshot-stale",
				message: `Applicable instruction at precedence position ${index} changed after curation`,
				severity: "error",
			});
		}
	}
	return issues;
}

function proposalFingerprint(proposal: EvolutionProposal): string {
	return computeEvolutionContentDigest({
		target: proposal.target.kind,
		action: proposal.action,
		delta: proposal.exactDelta,
	});
}

function removedMemoryItemIds(delta: EvolutionMemoryDelta): readonly string[] {
	if (delta.operation === "ADD") return [];
	return [delta.operation === "REMOVE" ? delta.memoryItemId : delta.removal.memoryItemId];
}

function additions(delta: EvolutionMemoryDelta): readonly EvolutionMemoryAddDelta[] {
	return delta.operation === "ADD" ? [delta] : [];
}

function addContents(delta: EvolutionMemoryDelta): readonly string[] {
	if (delta.operation === "REMOVE") return [];
	return [delta.operation === "ADD" ? delta.content : delta.addition.content];
}

function additionDestinationIssues(
	input: ProposalValidationInput,
	proposal: EvolutionMemoryProposal,
): ValidationIssue[] {
	const blocks = parseEvolutionMemoryBlocks(input.input.harness.memory);
	const removedItemIds = new Set(removedMemoryItemIds(proposal.exactDelta));
	return additions(proposal.exactDelta).flatMap((delta) => {
		if (delta.destination.anchor === null) return [];
		const matches = blocks.filter((block) =>
			evolutionMemoryLessonContentMatches(block.content, delta.destination.anchor ?? ""),
		);
		if (matches.length !== 1) {
			return [
				issue(
					proposal.proposalId,
					"addition-anchor-invalid",
					"ADD anchor must match exactly one frozen evolution memory item",
				),
			];
		}
		if (delta.destination.section !== null && matches[0]?.section !== delta.destination.section) {
			return [
				issue(
					proposal.proposalId,
					"addition-anchor-invalid",
					`ADD anchor is outside section "${delta.destination.section}"`,
				),
			];
		}
		const matchedIndex = blocks.indexOf(matches[0] as (typeof blocks)[number]);
		const matchedItem = input.input.harness.activeMemoryItems[matchedIndex];
		return matchedItem !== undefined && removedItemIds.has(matchedItem.memoryItemId)
			? [
					issue(
						proposal.proposalId,
						"addition-anchor-invalid",
						"REPLACE addition cannot anchor to the memory item being removed",
					),
				]
			: [];
	});
}

function isBroadScope(proposal: EvolutionMemoryProposal): boolean {
	const scopes =
		proposal.exactDelta.operation === "ADD"
			? proposal.exactDelta.intendedScope
			: proposal.exactDelta.operation === "REPLACE"
				? proposal.exactDelta.addition.intendedScope
				: proposal.scope.applicabilityBoundaries;
	return scopes.some((value) => /\bglobal\b|repository[- ]wide|all repositories|all tasks/i.test(value));
}

function validatesInstructionReference(
	documents: readonly InstructionDocumentSnapshot[],
	proposal: EvolutionProposal,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const reference of proposal.instructionRelationship.relevantEntries) {
		if (reference.kind === "applicable-instruction") {
			const document = documents.find((candidate) => candidate.path === reference.path);
			if (
				document === undefined ||
				document.precedence !== reference.precedence ||
				document.contentDigest !== reference.contentDigest
			) {
				issues.push(
					issue(
						proposal.proposalId,
						"instruction-reference-stale",
						`Instruction reference "${reference.path}" is stale`,
					),
				);
			}
		}
	}
	return issues;
}

function instructionDuplicateIssues(
	documents: readonly InstructionDocumentSnapshot[],
	proposal: EvolutionProposal,
): ValidationIssue[] {
	if (proposal.disposition === "deferred") return [];
	return addContents(proposal.exactDelta).flatMap((content) => {
		if (documents.some((document) => document.content.includes(content))) {
			return [
				issue(
					proposal.proposalId,
					"duplicate-instruction-exact",
					"Proposed content already exists in an applicable instruction",
				),
			];
		}
		const normalized = normalizedText(content);
		return documents.some((document) => normalizedText(document.content).includes(normalized))
			? [
					issue(
						proposal.proposalId,
						"duplicate-instruction-normalized",
						"Proposed content duplicates an applicable instruction after normalization",
					),
				]
			: [];
	});
}

function validateMemoryReference(input: ProposalValidationInput, proposal: EvolutionProposal): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const reference of proposal.instructionRelationship.relevantEntries) {
		if (reference.kind !== "evolution-memory") continue;
		const digest =
			reference.memoryItemId === null
				? input.input.harness.memoryContentDigest
				: input.input.harness.activeMemoryItems.find((item) => item.memoryItemId === reference.memoryItemId)
						?.contentDigest;
		if (digest === undefined || digest !== reference.contentDigest) {
			issues.push(issue(proposal.proposalId, "memory-reference-stale", "Evolution memory reference is stale"));
		}
	}
	return issues;
}

function proposalShapeIssues(
	input: ProposalValidationInput,
	proposal: EvolutionProposal,
	options: ResolvedOptions,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (!PROPOSAL_ID_PATTERN.test(proposal.proposalId) || proposal.metadata.artifactId !== proposal.proposalId) {
		issues.push(issue(proposal.proposalId, "invalid-proposal-id", "Proposal identity is invalid or inconsistent"));
	}
	if (
		proposal.metadata.schemaVersion !== 1 ||
		proposal.metadata.scope.repositoryId !== input.input.metadata.scope.repositoryId ||
		proposal.metadata.scope.scopeId !== input.input.metadata.scope.scopeId ||
		proposal.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(proposal))
	) {
		issues.push(
			issue(proposal.proposalId, "proposal-schema-invalid", "Proposal metadata or content digest is invalid"),
		);
	}
	if (
		hasDuplicates(proposal.lessonIds) ||
		hasDuplicates(proposal.supportingEvidenceIds) ||
		hasDuplicates(proposal.contradictingEvidenceIds) ||
		hasDuplicates(proposal.conflictingProposalIds)
	) {
		issues.push(
			issue(proposal.proposalId, "duplicate-proposal-reference", "Proposal contains duplicate identifiers"),
		);
	}
	if (
		proposal.scope.repository.repositoryId !== input.input.metadata.scope.repositoryId ||
		proposal.scope.repository.scopeId !== input.input.metadata.scope.scopeId ||
		proposal.scope.repositoryRevision !== input.input.repository.revision ||
		proposal.lessonIds.length === 0 ||
		proposal.supportingEvidenceIds.length === 0 ||
		proposal.expectedBenefit.trim().length === 0 ||
		proposal.acceptanceCriterion.trim().length === 0 ||
		proposal.risk.trim().length === 0 ||
		proposal.rollbackDescription.trim().length === 0 ||
		!Number.isFinite(proposal.curatorConfidence) ||
		proposal.curatorConfidence < 0 ||
		proposal.curatorConfidence > 1
	) {
		issues.push(
			issue(proposal.proposalId, "proposal-schema-invalid", "Proposal required fields or scope are invalid"),
		);
	}
	if (proposal.disposition === "deferred") {
		const targetKind: string = proposal.target.kind;
		const action: string = proposal.action;
		if (
			targetKind === "evolution-memory" ||
			action !== "DEFER" ||
			proposal.exactDelta !== null ||
			proposal.expectedBaseDigest !== null ||
			proposal.finding.trim().length === 0
		) {
			issues.push(
				issue(proposal.proposalId, "unsupported-target", "Deferred proposal contains an executable writer route"),
			);
		}
		return issues;
	}
	const action: string = proposal.action;
	if (
		proposal.target.kind !== "evolution-memory" ||
		action === "DEFER" ||
		action !== proposal.exactDelta.operation ||
		proposal.target.expectedHarnessVersion !== input.input.expectedHarnessBaseVersion ||
		proposal.expectedBaseDigest !== input.input.harness.memoryContentDigest
	) {
		issues.push(
			issue(
				proposal.proposalId,
				"unsupported-target",
				"Actionable proposal does not target the frozen evolution memory base",
			),
		);
	}
	if (Buffer.byteLength(JSON.stringify(proposal.exactDelta), "utf8") > options.maxDeltaBytes) {
		issues.push(
			issue(proposal.proposalId, "delta-size-limit", "Proposal exact delta exceeds the deterministic size limit"),
		);
	}
	const exactDelta = proposal.exactDelta;
	for (const memoryItemId of removedMemoryItemIds(exactDelta)) {
		const item = input.input.harness.activeMemoryItems.find((candidate) => candidate.memoryItemId === memoryItemId);
		const expectedDigest =
			exactDelta.operation === "REMOVE"
				? exactDelta.expectedContentDigest
				: exactDelta.operation === "REPLACE"
					? exactDelta.removal.expectedContentDigest
					: null;
		if (expectedDigest === null || item === undefined || item.contentDigest !== expectedDigest) {
			issues.push(
				issue(
					proposal.proposalId,
					"memory-item-digest-stale",
					`Memory item "${memoryItemId}" changed after curation`,
				),
			);
		}
	}
	issues.push(...additionDestinationIssues(input, proposal));
	for (const content of addContents(proposal.exactDelta)) {
		if (input.input.harness.memory.includes(content)) {
			issues.push(
				issue(proposal.proposalId, "duplicate-content-exact", "Proposed memory content already exists exactly"),
			);
		} else if (normalizedText(input.input.harness.memory).includes(normalizedText(content))) {
			issues.push(
				issue(
					proposal.proposalId,
					"duplicate-content-normalized",
					"Proposed memory content already exists after normalized-text comparison",
				),
			);
		}
	}
	return issues;
}

function lessonClosure(
	input: ProposalValidationInput,
	proposal: EvolutionProposal,
	index: ReadonlyMap<string, EvidenceContext>,
): {
	readonly issues: readonly ValidationIssue[];
	readonly supporting: readonly EvidenceContext[];
	readonly contradicting: readonly EvidenceContext[];
} {
	const issues: ValidationIssue[] = [];
	const lessonsById = new Map(input.reflection.lessons.map((lesson) => [lesson.lessonId, lesson]));
	const finalLessonIds = new Set(input.reflection.finalLessonIds);
	const lessons: Lesson[] = [];
	for (const lessonId of proposal.lessonIds) {
		const lesson = lessonsById.get(lessonId);
		if (lesson === undefined || !finalLessonIds.has(lessonId)) {
			issues.push(
				issue(proposal.proposalId, "lesson-closure-invalid", `Lesson "${lessonId}" is unavailable or not final`),
			);
			continue;
		}
		if (
			lesson.scope.repositoryId !== input.input.metadata.scope.repositoryId ||
			lesson.scope.scopeId !== input.input.metadata.scope.scopeId
		) {
			issues.push(
				issue(proposal.proposalId, "lesson-scope-invalid", `Lesson "${lessonId}" is outside the frozen scope`),
			);
		}
		if (
			lesson.metadata.artifactId !== lesson.lessonId ||
			lesson.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(lesson))
		) {
			issues.push(
				issue(
					proposal.proposalId,
					"lesson-digest-invalid",
					`Lesson "${lessonId}" failed immutable artifact validation`,
				),
			);
		}
		lessons.push(lesson);
	}
	const expectedSupporting = unique(lessons.flatMap((lesson) => lesson.evidenceIds));
	const expectedContradicting = unique(lessons.flatMap((lesson) => lesson.counterevidenceIds));
	if (
		!sameSet(proposal.supportingEvidenceIds, expectedSupporting) ||
		!sameSet(proposal.contradictingEvidenceIds, expectedContradicting)
	) {
		issues.push(
			issue(
				proposal.proposalId,
				"evidence-closure-invalid",
				"Proposal evidence does not close exactly through its lessons",
			),
		);
	}
	const resolve = (evidenceIds: readonly string[], role: "supporting" | "contradicting"): EvidenceContext[] =>
		evidenceIds.flatMap((evidenceId) => {
			const context = index.get(evidenceId);
			if (context === undefined) {
				issues.push(
					issue(
						proposal.proposalId,
						"evidence-unverifiable",
						`${role} evidence "${evidenceId}" is not in the materializer registry`,
					),
				);
				return [];
			}
			if (context.provenancePoints === 0) {
				issues.push(
					issue(
						proposal.proposalId,
						"evidence-quarantined",
						`${role} evidence "${evidenceId}" is outside a verified materialization prefix`,
					),
				);
			}
			if (context.ingestionCursor > input.input.ingestionHighWaterCursor) {
				issues.push(
					issue(
						proposal.proposalId,
						"evidence-after-cutoff",
						`${role} evidence "${evidenceId}" is after the frozen job cutoff`,
					),
				);
			}
			if (
				context.evidence.order.timestamp !== null &&
				context.evidence.order.timestamp > input.input.metadata.createdAt
			) {
				issues.push(
					issue(
						proposal.proposalId,
						"evidence-after-cutoff",
						`${role} evidence "${evidenceId}" did not exist at the frozen job cutoff`,
					),
				);
			}
			return [context];
		});
	const supporting = resolve(proposal.supportingEvidenceIds, "supporting");
	const contradicting = resolve(proposal.contradictingEvidenceIds, "contradicting");
	const supportingTraceIds = unique(supporting.flatMap((context) => context.traceId ?? []));
	const contradictingTraceIds = unique(contradicting.flatMap((context) => context.traceId ?? []));
	if (
		!sameSet(proposal.supportingTraceIds, supportingTraceIds) ||
		!sameSet(proposal.contradictingTraceIds, contradictingTraceIds)
	) {
		issues.push(
			issue(proposal.proposalId, "trace-closure-invalid", "Proposal trace references do not match cited evidence"),
		);
	}
	return {
		issues,
		supporting,
		contradicting,
	};
}

function strongestSignalsByTask(contexts: readonly EvidenceContext[]): ReadonlyMap<string, number> {
	const result = new Map<string, number>();
	for (const context of contexts) {
		if (context.taskLineageId === null) continue;
		result.set(context.taskLineageId, Math.max(result.get(context.taskLineageId) ?? 0, context.signalPoints));
	}
	return result;
}

function provenanceAndRecurrenceIssues(
	proposal: EvolutionProposal,
	supporting: readonly EvidenceContext[],
	contradicting: readonly EvidenceContext[],
	options: ResolvedOptions,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const supportSignals = strongestSignalsByTask(supporting);
	const contradictionSignals = strongestSignalsByTask(contradicting);
	const hasDirectUserSupport = supporting.some((context) => context.signal === "direct-user");
	const requiredTasks =
		proposal.disposition === "actionable" && isBroadScope(proposal)
			? options.broadScopeIndependentTasks
			: options.minimumIndependentTasks;
	if (supportSignals.size < requiredTasks && !(supportSignals.size === 1 && hasDirectUserSupport)) {
		issues.push(
			issue(
				proposal.proposalId,
				"insufficient-independent-support",
				`Proposal requires ${requiredTasks} independent supporting tasks`,
			),
		);
	}
	const supportStrength = [...supportSignals.values()].reduce((sum, points) => sum + points, 0);
	const contradictionStrength = [...contradictionSignals.values()].reduce((sum, points) => sum + points, 0);
	if (contradictionStrength >= supportStrength && contradictionStrength > 0) {
		issues.push(
			issue(
				proposal.proposalId,
				"counterevidence-not-resolved",
				"Independent counterevidence is equal to or stronger than support",
			),
		);
	}
	return issues;
}

function scopeIssues(proposal: EvolutionProposal, contexts: readonly EvidenceContext[]): ValidationIssue[] {
	const materializationIds = unique(contexts.map((context) => context.materializationId));
	const traceIds = unique(contexts.flatMap((context) => (context.traceId === null ? [] : [context.traceId])));
	const sessionIds = unique(contexts.flatMap((context) => context.evidence.sessionSource?.sessionId ?? []));
	const taskLineageIds = unique(contexts.flatMap((context) => context.taskLineageId ?? []));
	const invocations = [...new Set(contexts.map((context) => context.invocation))];
	const runtimeKinds = unique(invocations.flatMap((invocation) => invocation.producer?.runtime.kind ?? []));
	const runtimeVersions = unique(invocations.flatMap((invocation) => invocation.producer?.runtime.version ?? []));
	const sourceRevisions = unique(invocations.flatMap((invocation) => invocation.producer?.sourceRevision ?? []));
	const fields: readonly [string, readonly string[], readonly string[]][] = [
		["materialization", proposal.scope.materializationIds, materializationIds],
		["trace", proposal.scope.traceIds, traceIds],
		["session", proposal.scope.sessionIds, sessionIds],
		["task lineage", proposal.scope.taskLineageIds, taskLineageIds],
		["runtime kind", proposal.scope.runtimeKinds, runtimeKinds],
		["runtime version", proposal.scope.runtimeVersions, runtimeVersions],
		["source revision", proposal.scope.sourceRevisions, sourceRevisions],
	];
	return fields.flatMap(([name, actual, expected]) =>
		sameSet(actual, expected)
			? []
			: [
					issue(
						proposal.proposalId,
						"proposal-scope-invalid",
						`Proposal ${name} scope does not match cited evidence`,
					),
				],
	);
}

function operationConflicts(left: EvolutionProposal, right: EvolutionProposal): boolean {
	if (
		left.conflictingProposalIds.includes(right.proposalId) ||
		right.conflictingProposalIds.includes(left.proposalId)
	) {
		return true;
	}
	if (left.disposition === "deferred" || right.disposition === "deferred") return false;
	const leftRemoved = new Set(removedMemoryItemIds(left.exactDelta));
	return removedMemoryItemIds(right.exactDelta).some((memoryItemId) => leftRemoved.has(memoryItemId));
}

function duplicateAndConflictIssues(
	proposals: readonly EvolutionProposal[],
	proposal: EvolutionProposal,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const candidate of proposals) {
		if (candidate.proposalId === proposal.proposalId) continue;
		if (proposalFingerprint(candidate) === proposalFingerprint(proposal)) {
			issues.push(
				issue(
					proposal.proposalId,
					"duplicate-operation",
					`Proposal duplicates operation "${candidate.proposalId}"`,
					"warning",
				),
			);
		} else if (operationConflicts(proposal, candidate)) {
			issues.push(
				issue(
					proposal.proposalId,
					"operation-conflict",
					`Proposal conflicts with "${candidate.proposalId}"`,
					"warning",
				),
			);
		}
	}
	return issues;
}

function validationDisposition(
	proposal: EvolutionProposal,
	issues: readonly ValidationIssue[],
): ProposalValidationResult["disposition"] {
	if (proposal.disposition === "deferred" && !issues.some((candidate) => candidate.severity === "error"))
		return "deferred";
	if (
		issues.some(
			(candidate) =>
				candidate.code === "evidence-quarantined" || candidate.code === "materialization-registry-mismatch",
		)
	) {
		return "quarantined";
	}
	return issues.some((candidate) => candidate.severity === "error") ? "rejected" : "accepted";
}

function validationContext(
	input: ProposalValidationInput,
	proposal: EvolutionProposal,
	index: ReadonlyMap<string, EvidenceContext>,
	options: ResolvedOptions,
	globalIssues: readonly ValidationIssue[],
): { readonly result: ProposalValidationResult; readonly context: ValidatedProposalContext } {
	const closure = lessonClosure(input, proposal, index);
	const contexts = [...closure.supporting, ...closure.contradicting];
	const issues = [
		...globalIssues.map((candidate) => ({ ...candidate, proposalId: proposal.proposalId })),
		...proposalShapeIssues(input, proposal, options),
		...validatesInstructionReference(input.instructions.documents, proposal),
		...instructionDuplicateIssues(input.instructions.documents, proposal),
		...validateMemoryReference(input, proposal),
		...closure.issues,
		...scopeIssues(proposal, contexts),
		...provenanceAndRecurrenceIssues(proposal, closure.supporting, closure.contradicting, options),
		...duplicateAndConflictIssues(input.proposals, proposal),
	];
	const disposition = validationDisposition(proposal, issues);
	return {
		result: {
			proposalId: proposal.proposalId,
			disposition,
			reasonCodes: unique(issues.map((candidate) => candidate.code)),
			issues,
		},
		context: {
			proposal,
			supporting: closure.supporting,
			contradicting: closure.contradicting,
			independentSupportCount: strongestSignalsByTask(closure.supporting).size,
			earliestSupportingTime:
				sorted(closure.supporting.flatMap((context) => context.evidence.order.timestamp ?? []))[0] ??
				"9999-12-31T23:59:59.999Z",
			fingerprint: proposalFingerprint(proposal),
		},
	};
}

function scoreComponents(context: ValidatedProposalContext): EvidenceRankingScoreComponents {
	const supportSignals = [...strongestSignalsByTask(context.supporting).values()];
	const contradictionSignals = [...strongestSignalsByTask(context.contradicting).values()];
	const supportStrength = supportSignals.reduce((sum, value) => sum + value, 0);
	const contradictionStrength = contradictionSignals.reduce((sum, value) => sum + value, 0);
	const uniqueMaterializations = new Set(context.supporting.map((item) => item.materializationId)).size;
	const uniqueSourceRevisions = new Set(
		context.supporting.flatMap((item) => item.invocation.producer?.sourceRevision ?? []),
	).size;
	const proposal = context.proposal;
	return {
		recurrence: Math.min(30, context.independentSupportCount * 10),
		provenanceIntegrity:
			context.supporting.length === 0
				? 0
				: Math.round(
						context.supporting.reduce((sum, item) => sum + item.provenancePoints, 0) / context.supporting.length,
					),
		sourceSignalStrength: supportSignals.length === 0 ? 0 : Math.max(...supportSignals),
		scopeCoverage: Math.min(15, 5 + uniqueMaterializations * 5 + Math.min(5, uniqueSourceRevisions * 5)),
		curatorConfidence: Math.round(clamp(proposal.curatorConfidence, 0, 1) * 10),
		proposalCompleteness: 10,
		contradictionPenalty:
			supportStrength === 0
				? contradictionStrength > 0
					? 40
					: 0
				: Math.min(40, Math.round((contradictionStrength / supportStrength) * 40)),
	};
}

function finalScore(components: EvidenceRankingScoreComponents): number {
	return clamp(
		components.recurrence +
			components.provenanceIntegrity +
			components.sourceSignalStrength +
			components.scopeCoverage +
			components.curatorConfidence +
			components.proposalCompleteness -
			components.contradictionPenalty,
		0,
		100,
	);
}

function compareRanked(
	left: { readonly context: ValidatedProposalContext; readonly score: number },
	right: { readonly context: ValidatedProposalContext; readonly score: number },
): number {
	return (
		right.score - left.score ||
		right.context.independentSupportCount - left.context.independentSupportCount ||
		left.context.earliestSupportingTime.localeCompare(right.context.earliestSupportingTime) ||
		left.context.proposal.proposalId.localeCompare(right.context.proposal.proposalId)
	);
}

export class DeterministicProposalRanker implements ProposalValidator, ProposalScorer {
	readonly #dependencies: DeterministicProposalRankerDependencies;
	readonly #options: ResolvedOptions;

	constructor(
		dependencies: DeterministicProposalRankerDependencies,
		options: DeterministicProposalRankerOptions = {},
	) {
		this.#dependencies = dependencies;
		this.#options = {
			eligibilityThreshold: boundedScore(
				options.eligibilityThreshold,
				DEFAULT_ELIGIBILITY_THRESHOLD,
				"eligibilityThreshold",
			),
			maxSelectedProposals: selectionLimit(options.maxSelectedProposals),
			minimumIndependentTasks: positiveInteger(
				options.minimumIndependentTasks,
				DEFAULT_MINIMUM_INDEPENDENT_TASKS,
				"minimumIndependentTasks",
			),
			broadScopeIndependentTasks: positiveInteger(
				options.broadScopeIndependentTasks,
				DEFAULT_BROAD_SCOPE_INDEPENDENT_TASKS,
				"broadScopeIndependentTasks",
			),
			maxDeltaBytes: positiveInteger(options.maxDeltaBytes, DEFAULT_MAX_DELTA_BYTES, "maxDeltaBytes"),
		};
	}

	async validate(input: ProposalValidationInput): Promise<ValidationReport> {
		input.signal?.throwIfAborted();
		const instructionIssues = validateInstructionSnapshots(input);
		const frozenInputIssues: ValidationIssue[] = [];
		if (computeEvolutionContentDigest(input.input.harness.memory) !== input.input.harness.memoryContentDigest) {
			frozenInputIssues.push({
				code: "memory-base-digest-stale",
				message: "Frozen EVOLVE.md content digest is invalid",
				severity: "error",
			});
		}
		const evidence = evidenceIndex(input);
		const globalIssues = [...instructionIssues, ...frozenInputIssues, ...evidence.globalIssues];
		const proposalResults = input.proposals.map(
			(proposal) => validationContext(input, proposal, evidence.index, this.#options, globalIssues).result,
		);
		const producer: EvolutionArtifactProducer = {
			name: "diffex-evolution-validator",
			version: this.#dependencies.version,
			promptVersion: input.input.promptVersions.validator,
			model: null,
		};
		const content = {
			validatorVersion: EVIDENCE_RANKING_SCORER_VERSION,
			assurance: EVIDENCE_RANKING_ASSURANCE,
			proposalResults,
		};
		const artifactId = `validation-${computeEvolutionContentDigest({ input: input.input.metadata.contentDigest, content }).slice("sha256:".length, "sha256:".length + 32)}`;
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId,
				producer,
				sourceIds: input.proposals.map((proposal) => proposal.proposalId),
				scope: input.input.metadata.scope,
				createdAt: input.input.metadata.createdAt,
				content,
			}),
			...content,
		};
	}

	async score(input: ProposalScoringInput): Promise<readonly ScoredProposal[]> {
		input.signal?.throwIfAborted();
		const evidence = evidenceIndex(input);
		const expectedValidation = await this.validate(input);
		if (
			input.validation.validatorVersion !== expectedValidation.validatorVersion ||
			input.validation.assurance !== expectedValidation.assurance ||
			computeEvolutionContentDigest(input.validation.proposalResults) !==
				computeEvolutionContentDigest(expectedValidation.proposalResults) ||
			input.validation.metadata.contentDigest !== expectedValidation.metadata.contentDigest
		) {
			throw new Error("Scorer received a validation report that does not match deterministic validation");
		}
		const validationById = new Map(expectedValidation.proposalResults.map((result) => [result.proposalId, result]));
		const contexts = new Map(
			input.proposals.map((proposal) => [
				proposal.proposalId,
				validationContext(input, proposal, evidence.index, this.#options, evidence.globalIssues).context,
			]),
		);
		const ranked = input.proposals
			.flatMap((proposal) => {
				const validation = validationById.get(proposal.proposalId);
				const context = contexts.get(proposal.proposalId);
				if (validation?.disposition !== "accepted" || context === undefined) return [];
				const components = scoreComponents(context);
				return [{ context, components, score: finalScore(components) }];
			})
			.sort(compareRanked);
		const representatives = new Map<string, (typeof ranked)[number]>();
		for (const item of ranked)
			if (!representatives.has(item.context.fingerprint)) representatives.set(item.context.fingerprint, item);
		const selected: (typeof ranked)[number][] = [];
		for (const candidate of representatives.values()) {
			if (candidate.score < this.#options.eligibilityThreshold) continue;
			if (selected.length >= this.#options.maxSelectedProposals) continue;
			if (selected.some((existing) => operationConflicts(candidate.context.proposal, existing.context.proposal)))
				continue;
			selected.push(candidate);
		}
		const selectedIds = new Set(selected.map((item) => item.context.proposal.proposalId));
		const representativeIds = new Set([...representatives.values()].map((item) => item.context.proposal.proposalId));
		const rankedById = new Map(ranked.map((item) => [item.context.proposal.proposalId, item]));
		const producer: EvolutionArtifactProducer = {
			name: "diffex-evolution-scorer",
			version: this.#dependencies.version,
			promptVersion: input.input.promptVersions.validator,
			model: null,
		};
		return input.proposals.map((proposal): ScoredProposal => {
			const validation = validationById.get(proposal.proposalId);
			const rankedItem = rankedById.get(proposal.proposalId);
			let disposition: ScoredProposal["disposition"];
			let reasonCodes: readonly string[];
			if (validation === undefined) {
				disposition = "rejected";
				reasonCodes = ["validation-result-missing"];
			} else if (validation.disposition !== "accepted") {
				disposition = validation.disposition;
				reasonCodes = validation.reasonCodes.length === 0 ? [validation.disposition] : validation.reasonCodes;
			} else if (rankedItem === undefined) {
				disposition = "rejected";
				reasonCodes = ["scoring-context-missing"];
			} else if (!representativeIds.has(proposal.proposalId)) {
				disposition = "superseded";
				reasonCodes = ["exact-proposal-fingerprint-collapsed"];
			} else if (selectedIds.has(proposal.proposalId)) {
				disposition = "selected";
				reasonCodes = ["selected-by-evidence-ranking"];
			} else {
				disposition = "unselected";
				const conflicts = selected.some((item) => operationConflicts(proposal, item.context.proposal));
				reasonCodes =
					rankedItem.score < this.#options.eligibilityThreshold
						? ["below-eligibility-threshold"]
						: conflicts
							? ["conflicts-with-higher-ranked-proposal"]
							: ["selection-limit-reached"];
			}
			const content = {
				proposalId: proposal.proposalId,
				scorerVersion: EVIDENCE_RANKING_SCORER_VERSION,
				evidenceRankingScore: rankedItem?.score ?? null,
				scoreComponents: rankedItem?.components ?? null,
				disposition,
				reasonCodes,
			};
			const artifactId = `score-${computeEvolutionContentDigest({ validation: input.validation.metadata.contentDigest, content }).slice("sha256:".length, "sha256:".length + 32)}`;
			return {
				metadata: createEvolutionArtifactMetadata({
					artifactId,
					producer,
					sourceIds: [proposal.proposalId, input.validation.metadata.artifactId],
					scope: input.input.metadata.scope,
					createdAt: input.input.metadata.createdAt,
					content,
				}),
				proposal,
				...content,
			};
		});
	}
}
