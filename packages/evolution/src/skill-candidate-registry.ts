import type {
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionArtifactReference,
	EvolutionInputSnapshot,
	EvolutionScope,
	SkillCandidate,
	SkillCandidateDispositionRecord,
	SkillCandidateEvidenceContribution,
	SkillCandidateGroup,
	SkillCandidateGroupingProfile,
	SkillCandidatePriorityScore,
	SkillCandidatePriorityScoreComponents,
	SkillCandidateProposalRecordedEvent,
	SkillCandidateProposalRevision,
	SkillCandidateRegistryEvent,
	SkillCandidateState,
	SkillCandidateStateTransitionedEvent,
	SkillDraft,
	SkillDraftValidationReport,
	SkillEvaluationReport,
} from "./contracts.ts";
import { SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION, SKILL_EVALUATION_SCHEMA_VERSION } from "./contracts.ts";
import type {
	EvolutionArtifactStore,
	SkillCandidateDraftRecordingInput,
	SkillCandidateEvaluationRecordingInput,
	SkillCandidateEvaluationStartInput,
	SkillCandidateRegistry,
	SkillCandidateRegistryConsolidationInput,
	SkillCandidateRegistryConsolidationResult,
	SkillCandidateRegistryStore,
	SkillCandidateValidationRecordingInput,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

export const SKILL_CANDIDATE_PRIORITY_SCORER_VERSION = "skill-candidate-priority-v1";

const DEFAULT_MINIMUM_INDEPENDENT_TASKS = 2;
const DEFAULT_MAX_COMMIT_ATTEMPTS = 5;
const TERM_PATTERN = /[\p{L}\p{N}]+/gu;
const STOP_TERMS = new Set([
	"after",
	"before",
	"from",
	"into",
	"must",
	"only",
	"same",
	"that",
	"their",
	"then",
	"this",
	"through",
	"when",
	"with",
]);
const MANAGED_QUALIFICATION_STATES = new Set<SkillCandidateState>(["proposed", "evidence-qualified", "quarantined"]);

interface MutableGroup {
	readonly groupId: string;
	readonly profile: SkillCandidateGroupingProfile;
	readonly proposalRevisions: SkillCandidateProposalRevision[];
	state: SkillCandidateState;
	readonly dispositionHistory: SkillCandidateDispositionRecord[];
	priorityScore: EvolutionArtifactReference | null;
	draft: EvolutionArtifactReference | null;
	readonly draftProposalRevisionIds: string[];
	validation: EvolutionArtifactReference | null;
	readonly validationProposalRevisionIds: string[];
	evaluation: EvolutionArtifactReference | null;
	readonly evaluationProposalRevisionIds: string[];
	readonly scoredProposalRevisionIds: string[];
}

export interface DeterministicSkillCandidatePriorityScorerDependencies {
	readonly version: string;
}

export interface DeterministicSkillCandidatePriorityScorerOptions {
	readonly minimumIndependentTasks?: number;
}

export interface PersistentSkillCandidateRegistryDependencies {
	readonly version: string;
	readonly artifacts: EvolutionArtifactStore;
	readonly store: SkillCandidateRegistryStore;
	readonly scorer?: DeterministicSkillCandidatePriorityScorer;
}

export interface PersistentSkillCandidateRegistryOptions {
	readonly maxCommitAttempts?: number;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = uniqueSorted(left);
	const normalizedRight = uniqueSorted(right);
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((value, index) => value === normalizedRight[index])
	);
}

function terms(values: readonly string[]): string[] {
	const result = new Set<string>();
	for (const value of values) {
		for (const match of value.normalize("NFKC").toLocaleLowerCase("en-US").matchAll(TERM_PATTERN)) {
			const term = match[0];
			if (term.length >= 3 && !STOP_TERMS.has(term)) result.add(term);
		}
	}
	return [...result].sort((left, right) => left.localeCompare(right));
}

function overlap(left: readonly string[], right: readonly string[]): number {
	if (left.length === 0 || right.length === 0) return left.length === right.length ? 1 : 0;
	const rightValues = new Set(right);
	const shared = new Set(left.filter((value) => rightValues.has(value))).size;
	return shared / Math.min(new Set(left).size, rightValues.size);
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function contentWithoutMetadata<T extends { readonly metadata: unknown }>(value: T): Omit<T, "metadata"> {
	const { metadata: _metadata, ...content } = value;
	return content;
}

function metadata(
	artifactId: string,
	producer: EvolutionArtifactProducer,
	sourceIds: readonly string[],
	scope: EvolutionScope,
	createdAt: string,
	content: unknown,
): EvolutionArtifactMetadata {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt, content });
}

function groupingProfile(candidate: SkillCandidate): SkillCandidateGroupingProfile {
	return {
		workspace: {
			repositoryId: candidate.workspace.repositoryId,
			...(candidate.workspace.directoryId === undefined ? {} : { directoryId: candidate.workspace.directoryId }),
			evolutionScope: candidate.workspace.evolutionScope,
		},
		existingSkillIds: uniqueSorted(candidate.existingSkillIds),
		skillability: candidate.skillability.classification,
		triggerTerms: terms([candidate.trigger.description]),
		proceduralIntentTerms: terms([
			...candidate.procedure.steps.flatMap((step) => [
				step.action,
				...(step.condition === null ? [] : [step.condition]),
			]),
			...candidate.procedure.requiredTools,
			...candidate.procedure.environment,
			candidate.verificationContract.completionCondition,
		]),
		applicabilityTerms: terms([...candidate.preconditions, ...candidate.applicabilityBoundaries]),
	};
}

function workspaceMatches(left: SkillCandidateGroupingProfile, right: SkillCandidateGroupingProfile): boolean {
	return (
		left.workspace.repositoryId === right.workspace.repositoryId &&
		left.workspace.directoryId === right.workspace.directoryId &&
		left.workspace.evolutionScope.repositoryId === right.workspace.evolutionScope.repositoryId &&
		left.workspace.evolutionScope.scopeId === right.workspace.evolutionScope.scopeId
	);
}

function profilesAreCompatible(left: SkillCandidateGroupingProfile, right: SkillCandidateGroupingProfile): boolean {
	return (
		workspaceMatches(left, right) &&
		sameValues(left.existingSkillIds, right.existingSkillIds) &&
		left.skillability === right.skillability &&
		overlap(left.triggerTerms, right.triggerTerms) >= 0.65 &&
		overlap(left.proceduralIntentTerms, right.proceduralIntentTerms) >= 0.65 &&
		(left.applicabilityTerms.length === 0 ||
			right.applicabilityTerms.length === 0 ||
			overlap(left.applicabilityTerms, right.applicabilityTerms) >= 0.5)
	);
}

function profileSimilarity(left: SkillCandidateGroupingProfile, right: SkillCandidateGroupingProfile): number {
	return (
		overlap(left.triggerTerms, right.triggerTerms) * 4 +
		overlap(left.proceduralIntentTerms, right.proceduralIntentTerms) * 5 +
		overlap(left.applicabilityTerms, right.applicabilityTerms)
	);
}

function taskLineagesByEvidence(input: EvolutionInputSnapshot): ReadonlyMap<string, readonly string[]> {
	const result = new Map<string, readonly string[]>();
	for (const source of input.evidenceSources) {
		for (const evidence of source.invocation.evidence) {
			if (result.has(evidence.evidenceId)) throw new Error(`Duplicate evidence ID "${evidence.evidenceId}"`);
			result.set(
				evidence.evidenceId,
				uniqueSorted(
					evidence.order.causalIdentifiers
						.filter((identifier) => {
							const name = identifier.name.toLocaleLowerCase("en-US");
							return name.includes("task") && name.includes("lineage");
						})
						.map((identifier) => identifier.value),
				),
			);
		}
	}
	return result;
}

function evidenceContribution(
	candidate: SkillCandidate,
	lineagesByEvidence: ReadonlyMap<string, readonly string[]>,
): SkillCandidateEvidenceContribution {
	const resolve = (evidenceIds: readonly string[]): string[] =>
		uniqueSorted(
			evidenceIds.flatMap((evidenceId) => {
				const lineages = lineagesByEvidence.get(evidenceId);
				if (lineages === undefined) throw new Error(`Candidate cites unavailable evidence "${evidenceId}"`);
				return lineages;
			}),
		);
	const supportingTaskLineageIds = resolve(candidate.supportingEvidenceIds);
	const contradictingTaskLineageIds = resolve(candidate.contradictingEvidenceIds);
	if (!sameValues(candidate.taskLineageIds, [...supportingTaskLineageIds, ...contradictingTaskLineageIds])) {
		throw new Error(`Candidate "${candidate.candidateId}" task lineage closure is invalid`);
	}
	return {
		supportingEvidenceIds: uniqueSorted(candidate.supportingEvidenceIds),
		contradictingEvidenceIds: uniqueSorted(candidate.contradictingEvidenceIds),
		supportingTraceIds: uniqueSorted(candidate.supportingTraceIds),
		contradictingTraceIds: uniqueSorted(candidate.contradictingTraceIds),
		supportingTaskLineageIds,
		contradictingTaskLineageIds,
	};
}

function mergeEvidence(revisions: readonly SkillCandidateProposalRevision[]): SkillCandidateEvidenceContribution {
	return {
		supportingEvidenceIds: uniqueSorted(revisions.flatMap((revision) => revision.evidence.supportingEvidenceIds)),
		contradictingEvidenceIds: uniqueSorted(
			revisions.flatMap((revision) => revision.evidence.contradictingEvidenceIds),
		),
		supportingTraceIds: uniqueSorted(revisions.flatMap((revision) => revision.evidence.supportingTraceIds)),
		contradictingTraceIds: uniqueSorted(revisions.flatMap((revision) => revision.evidence.contradictingTraceIds)),
		supportingTaskLineageIds: uniqueSorted(
			revisions.flatMap((revision) => revision.evidence.supportingTaskLineageIds),
		),
		contradictingTaskLineageIds: uniqueSorted(
			revisions.flatMap((revision) => revision.evidence.contradictingTaskLineageIds),
		),
	};
}

function materializeGroups(events: readonly SkillCandidateRegistryEvent[]): Map<string, MutableGroup> {
	const groups = new Map<string, MutableGroup>();
	for (const event of [...events].sort((left, right) => left.registrySequence - right.registrySequence)) {
		if (event.type === "skill-candidate-proposal-recorded") {
			const group = groups.get(event.groupId);
			if (group === undefined) {
				groups.set(event.groupId, {
					groupId: event.groupId,
					profile: event.profile,
					proposalRevisions: [event.proposalRevision],
					state: "proposed",
					dispositionHistory: [],
					priorityScore: null,
					draft: null,
					draftProposalRevisionIds: [],
					validation: null,
					validationProposalRevisionIds: [],
					evaluation: null,
					evaluationProposalRevisionIds: [],
					scoredProposalRevisionIds: [],
				});
			} else if (
				!group.proposalRevisions.some((revision) => revision.revisionId === event.proposalRevision.revisionId)
			) {
				if (!profilesAreCompatible(group.profile, event.profile)) {
					throw new Error(`Candidate registry group "${event.groupId}" contains an incompatible proposal`);
				}
				group.proposalRevisions.push(event.proposalRevision);
			}
			continue;
		}
		if (event.type === "skill-candidate-priority-scored") {
			const group = groups.get(event.groupId);
			if (group === undefined) throw new Error(`Candidate score references unknown group "${event.groupId}"`);
			group.priorityScore = event.score;
			group.scoredProposalRevisionIds.splice(
				0,
				group.scoredProposalRevisionIds.length,
				...event.proposalRevisionIds,
			);
			continue;
		}
		if (event.type === "skill-candidate-draft-recorded") {
			const group = groups.get(event.groupId);
			if (group === undefined) throw new Error(`Candidate draft references unknown group "${event.groupId}"`);
			if (
				!sameValues(
					event.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				)
			) {
				throw new Error(`Candidate draft for group "${event.groupId}" has a stale revision set`);
			}
			if (
				group.draft !== null &&
				sameValues(group.draftProposalRevisionIds, event.proposalRevisionIds) &&
				(group.draft.artifactId !== event.draft.artifactId ||
					group.draft.contentDigest !== event.draft.contentDigest)
			) {
				throw new Error(`Candidate group "${event.groupId}" has conflicting drafts`);
			}
			group.draft = event.draft;
			group.draftProposalRevisionIds.splice(0, group.draftProposalRevisionIds.length, ...event.proposalRevisionIds);
			continue;
		}
		if (event.type === "skill-candidate-validation-recorded") {
			const group = groups.get(event.groupId);
			if (group === undefined) throw new Error(`Candidate validation references unknown group "${event.groupId}"`);
			if (
				!sameValues(
					event.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				) ||
				group.draft?.artifactId !== event.draft.artifactId ||
				group.draft.contentDigest !== event.draft.contentDigest
			) {
				throw new Error(`Candidate validation for group "${event.groupId}" has a stale draft or revision set`);
			}
			if (
				group.validation !== null &&
				sameValues(group.validationProposalRevisionIds, event.proposalRevisionIds) &&
				(group.validation.artifactId !== event.validation.artifactId ||
					group.validation.contentDigest !== event.validation.contentDigest)
			) {
				throw new Error(`Candidate group "${event.groupId}" has conflicting validation reports`);
			}
			group.validation = event.validation;
			group.validationProposalRevisionIds.splice(
				0,
				group.validationProposalRevisionIds.length,
				...event.proposalRevisionIds,
			);
			continue;
		}
		if (event.type === "skill-candidate-evaluation-recorded") {
			const group = groups.get(event.groupId);
			if (group === undefined) throw new Error(`Candidate evaluation references unknown group "${event.groupId}"`);
			if (
				!sameValues(
					event.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				) ||
				group.draft?.artifactId !== event.draft.artifactId ||
				group.draft.contentDigest !== event.draft.contentDigest ||
				group.validation?.artifactId !== event.validation.artifactId ||
				group.validation.contentDigest !== event.validation.contentDigest
			) {
				throw new Error(`Candidate evaluation for group "${event.groupId}" has stale prerequisites`);
			}
			if (
				group.evaluation !== null &&
				sameValues(group.evaluationProposalRevisionIds, event.proposalRevisionIds) &&
				(group.evaluation.artifactId !== event.evaluation.artifactId ||
					group.evaluation.contentDigest !== event.evaluation.contentDigest)
			) {
				throw new Error(`Candidate group "${event.groupId}" has conflicting evaluation reports`);
			}
			group.evaluation = event.evaluation;
			group.evaluationProposalRevisionIds.splice(
				0,
				group.evaluationProposalRevisionIds.length,
				...event.proposalRevisionIds,
			);
			continue;
		}
		if (event.type === "skill-candidate-state-transitioned") {
			const group = groups.get(event.groupId);
			if (group === undefined) throw new Error(`Candidate transition references unknown group "${event.groupId}"`);
			if (event.from !== null && event.from !== group.state) {
				throw new Error(`Candidate group "${event.groupId}" disposition history is not contiguous`);
			}
			group.state = event.to;
			group.dispositionHistory.push({
				eventId: event.eventId,
				from: event.from,
				to: event.to,
				reasonCodes: event.reasonCodes,
				createdAt: event.metadata.createdAt,
			});
		}
	}
	return groups;
}

function immutableGroup(group: MutableGroup): SkillCandidateGroup {
	const proposalRevisions = [...group.proposalRevisions].sort(
		(left, right) => left.createdAt.localeCompare(right.createdAt) || left.revisionId.localeCompare(right.revisionId),
	);
	const revisionSetDigest = computeEvolutionContentDigest(
		proposalRevisions.map((revision) => ({ revisionId: revision.revisionId, candidate: revision.candidate })),
	);
	return {
		groupId: group.groupId,
		profile: group.profile,
		proposalRevisions,
		state: group.state,
		dispositionHistory: [...group.dispositionHistory],
		evidence: mergeEvidence(proposalRevisions),
		priorityScore: group.priorityScore,
		draft: sameValues(
			group.draftProposalRevisionIds,
			proposalRevisions.map((revision) => revision.revisionId),
		)
			? group.draft
			: null,
		validation: sameValues(
			group.validationProposalRevisionIds,
			proposalRevisions.map((revision) => revision.revisionId),
		)
			? group.validation
			: null,
		evaluation: sameValues(
			group.evaluationProposalRevisionIds,
			proposalRevisions.map((revision) => revision.revisionId),
		)
			? group.evaluation
			: null,
		synthesisIdempotencyKey: stableId("skill-synthesis", { groupId: group.groupId, revisionSetDigest }),
		validationIdempotencyKey: stableId("skill-validation", {
			groupId: group.groupId,
			revisionSetDigest,
			draft: group.draft,
		}),
		evaluationIdempotencyKey: stableId("skill-evaluation", { groupId: group.groupId, revisionSetDigest }),
	};
}

function assertDraft(
	draft: SkillDraft,
	reference: EvolutionArtifactReference,
	group: SkillCandidateGroup,
	input: SkillCandidateDraftRecordingInput,
): void {
	if (
		draft.artifactKind !== "skill-draft" ||
		draft.draftId === "" ||
		draft.metadata.artifactId !== draft.draftId ||
		draft.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(draft)) ||
		reference.artifactId !== draft.draftId ||
		reference.contentDigest !== computeEvolutionContentDigest(draft) ||
		draft.groupId !== group.groupId ||
		draft.synthesisIdempotencyKey !== group.synthesisIdempotencyKey ||
		draft.synthesisIdempotencyKey !== input.idempotencyKey ||
		!sameValues(draft.proposalRevisionIds, input.proposalRevisionIds) ||
		draft.metadata.scope.repositoryId !== input.scope.repositoryId ||
		draft.metadata.scope.scopeId !== input.scope.scopeId
	) {
		throw new Error(`Skill draft for candidate group "${group.groupId}" has an invalid immutable identity`);
	}
}

function assertValidation(
	validation: SkillDraftValidationReport,
	reference: EvolutionArtifactReference,
	group: SkillCandidateGroup,
	input: SkillCandidateValidationRecordingInput,
): void {
	if (
		validation.artifactKind !== "skill-draft-validation" ||
		validation.validationId === "" ||
		validation.metadata.artifactId !== validation.validationId ||
		validation.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(validation)) ||
		reference.artifactId !== validation.validationId ||
		reference.contentDigest !== computeEvolutionContentDigest(validation) ||
		validation.groupId !== group.groupId ||
		validation.draft.artifactId !== input.draft.artifactId ||
		validation.draft.contentDigest !== input.draft.contentDigest ||
		input.idempotencyKey !== group.validationIdempotencyKey ||
		validation.metadata.scope.repositoryId !== input.scope.repositoryId ||
		validation.metadata.scope.scopeId !== input.scope.scopeId
	) {
		throw new Error(`Skill validation for candidate group "${group.groupId}" has an invalid immutable identity`);
	}
}

function assertEvaluation(
	evaluation: SkillEvaluationReport,
	reference: EvolutionArtifactReference,
	group: SkillCandidateGroup,
	input: SkillCandidateEvaluationRecordingInput,
): void {
	const gatesPassed =
		evaluation.gates.suite.passed && evaluation.gates.retrieval.passed && evaluation.gates.behavior.passed;
	if (
		evaluation.artifactKind !== "skill-evaluation" ||
		evaluation.schemaVersion !== SKILL_EVALUATION_SCHEMA_VERSION ||
		evaluation.evaluationId === "" ||
		evaluation.metadata.artifactId !== evaluation.evaluationId ||
		evaluation.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(evaluation)) ||
		reference.artifactId !== evaluation.evaluationId ||
		reference.contentDigest !== computeEvolutionContentDigest(evaluation) ||
		evaluation.groupId !== group.groupId ||
		evaluation.draft.artifactId !== input.draft.artifactId ||
		evaluation.draft.contentDigest !== input.draft.contentDigest ||
		evaluation.validation.artifactId !== input.validation.artifactId ||
		evaluation.validation.contentDigest !== input.validation.contentDigest ||
		evaluation.evaluationIdempotencyKey !== group.evaluationIdempotencyKey ||
		evaluation.evaluationIdempotencyKey !== input.idempotencyKey ||
		evaluation.disposition !== (gatesPassed ? "accepted" : "quarantined") ||
		!sameValues(evaluation.proposalRevisionIds, input.proposalRevisionIds) ||
		evaluation.metadata.scope.repositoryId !== input.scope.repositoryId ||
		evaluation.metadata.scope.scopeId !== input.scope.scopeId
	) {
		throw new Error(`Skill evaluation for candidate group "${group.groupId}" has an invalid immutable identity`);
	}
}

function assertCandidate(
	candidate: SkillCandidate,
	reference: EvolutionArtifactReference,
	input: EvolutionInputSnapshot,
): void {
	if (
		candidate.artifactKind !== "skill-candidate" ||
		candidate.candidateId === "" ||
		candidate.metadata.artifactId !== candidate.candidateId ||
		candidate.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(candidate)) ||
		reference.artifactId !== candidate.candidateId ||
		reference.contentDigest !== computeEvolutionContentDigest(candidate)
	) {
		throw new Error("Skill candidate immutable artifact identity is invalid");
	}
	if (
		candidate.metadata.scope.repositoryId !== input.metadata.scope.repositoryId ||
		candidate.metadata.scope.scopeId !== input.metadata.scope.scopeId ||
		candidate.workspace.repositoryId !== input.repository.repositoryId ||
		candidate.workspace.directoryId !== input.repository.directoryId ||
		candidate.workspace.rootPath !== input.repository.rootPath ||
		candidate.workspace.repositoryRevision !== input.repository.revision ||
		candidate.workspace.evolutionScope.repositoryId !== input.metadata.scope.repositoryId ||
		candidate.workspace.evolutionScope.scopeId !== input.metadata.scope.scopeId
	) {
		throw new Error(`Skill candidate "${candidate.candidateId}" is outside the frozen workspace`);
	}
	if (
		candidate.trigger.description.trim() === "" ||
		candidate.procedure.steps.length === 0 ||
		candidate.verificationContract.checks.length === 0 ||
		candidate.verificationContract.completionCondition.trim() === ""
	) {
		throw new Error(`Skill candidate "${candidate.candidateId}" is procedurally incomplete`);
	}
}

function eventMetadata(
	eventId: string,
	producer: EvolutionArtifactProducer,
	sourceIds: readonly string[],
	scope: EvolutionScope,
	createdAt: string,
	content: unknown,
): EvolutionArtifactMetadata {
	return metadata(eventId, producer, sourceIds, scope, createdAt, content);
}

function withEventMetadata<T extends Omit<SkillCandidateRegistryEvent, "metadata">>(
	value: T,
	producer: EvolutionArtifactProducer,
	sourceIds: readonly string[],
	scope: EvolutionScope,
	createdAt: string,
): T & { readonly metadata: EvolutionArtifactMetadata } {
	return {
		...value,
		metadata: eventMetadata(value.eventId, producer, sourceIds, scope, createdAt, value),
	};
}

function nextSequence(events: readonly SkillCandidateRegistryEvent[], offset: number): number {
	return events.length + offset + 1;
}

function transitionEvent(
	groupId: string,
	from: SkillCandidateState | null,
	to: SkillCandidateState,
	reasonCodes: readonly string[],
	registrySequence: number,
	idempotencyKey: string,
	producer: EvolutionArtifactProducer,
	scope: EvolutionScope,
	createdAt: string,
): SkillCandidateStateTransitionedEvent {
	const content = {
		schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
		eventId: stableId("skill-candidate-event", {
			idempotencyKey,
			registrySequence,
			type: "skill-candidate-state-transitioned",
			groupId,
			from,
			to,
		}),
		registrySequence,
		type: "skill-candidate-state-transitioned" as const,
		groupId,
		from,
		to,
		reasonCodes,
	};
	return withEventMetadata(content, producer, [groupId], scope, createdAt);
}

function groupForProfile(
	groups: ReadonlyMap<string, MutableGroup>,
	profile: SkillCandidateGroupingProfile,
): MutableGroup | null {
	return (
		[...groups.values()]
			.filter((group) => profilesAreCompatible(group.profile, profile))
			.sort(
				(left, right) =>
					profileSimilarity(right.profile, profile) - profileSimilarity(left.profile, profile) ||
					left.groupId.localeCompare(right.groupId),
			)[0] ?? null
	);
}

function boundedPositiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function clamp(value: number): number {
	return Math.min(100, Math.max(0, value));
}

export class DeterministicSkillCandidatePriorityScorer {
	readonly #producer: EvolutionArtifactProducer;
	readonly #minimumIndependentTasks: number;

	constructor(
		dependencies: DeterministicSkillCandidatePriorityScorerDependencies,
		options: DeterministicSkillCandidatePriorityScorerOptions = {},
	) {
		this.#producer = {
			name: "diffex-skill-candidate-priority-scorer",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
		this.#minimumIndependentTasks = boundedPositiveInteger(
			options.minimumIndependentTasks,
			DEFAULT_MINIMUM_INDEPENDENT_TASKS,
			"minimumIndependentTasks",
		);
	}

	qualification(group: SkillCandidateGroup): {
		readonly state: SkillCandidateState;
		readonly reasonCodes: readonly string[];
	} {
		const hasStaleArtifacts =
			(group.state === "drafted" ||
				group.state === "structurally-valid" ||
				group.state === "evaluation-pending" ||
				group.state === "accepted" ||
				group.state === "rejected") &&
			group.draft === null;
		if (group.evaluation !== null) return { state: group.state, reasonCodes: [] };
		if (!hasStaleArtifacts && !MANAGED_QUALIFICATION_STATES.has(group.state)) {
			return { state: group.state, reasonCodes: [] };
		}
		const support = group.evidence.supportingTaskLineageIds.length;
		const contradiction = group.evidence.contradictingTaskLineageIds.length;
		if (contradiction > 0 && contradiction >= support) {
			return { state: "quarantined", reasonCodes: ["counterevidence-meets-or-exceeds-support"] };
		}
		if (support >= this.#minimumIndependentTasks) {
			return {
				state: "evidence-qualified",
				reasonCodes: [hasStaleArtifacts ? "proposal-revision-set-changed" : "independent-recurrence-qualified"],
			};
		}
		return { state: "proposed", reasonCodes: ["awaiting-independent-recurrence"] };
	}

	score(group: SkillCandidateGroup, scope: EvolutionScope, createdAt: string): SkillCandidatePriorityScore {
		const evidence = group.evidence;
		const latest = group.proposalRevisions.at(-1);
		if (latest === undefined) throw new Error(`Candidate group "${group.groupId}" has no proposal revisions`);
		const components: SkillCandidatePriorityScoreComponents = {
			independentSupport: Math.min(40, evidence.supportingTaskLineageIds.length * 20),
			evidenceBreadth: Math.min(
				20,
				evidence.supportingEvidenceIds.length * 2 + evidence.supportingTraceIds.length * 4,
			),
			proceduralCompleteness: Math.min(
				15,
				5 +
					Math.min(5, group.profile.proceduralIntentTerms.length) +
					Math.min(5, group.profile.triggerTerms.length),
			),
			verificationCompleteness: 10,
			scopeSpecificity: group.profile.applicabilityTerms.length > 0 ? 10 : 5,
			counterevidencePenalty:
				evidence.supportingTaskLineageIds.length === 0
					? Math.min(40, evidence.contradictingTaskLineageIds.length * 20)
					: Math.min(
							40,
							Math.round(
								(evidence.contradictingTaskLineageIds.length / evidence.supportingTaskLineageIds.length) * 40,
							),
						),
		};
		const evidencePriorityScore = clamp(
			components.independentSupport +
				components.evidenceBreadth +
				components.proceduralCompleteness +
				components.verificationCompleteness +
				components.scopeSpecificity -
				components.counterevidencePenalty,
		);
		const content = {
			artifactKind: "skill-candidate-priority-score" as const,
			scoreId: stableId("skill-candidate-score", {
				groupId: group.groupId,
				proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
				components,
			}),
			groupId: group.groupId,
			scorerVersion: SKILL_CANDIDATE_PRIORITY_SCORER_VERSION,
			evidencePriorityScore,
			scoreComponents: components,
			proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
			supportingTaskLineageIds: evidence.supportingTaskLineageIds,
			contradictingTaskLineageIds: evidence.contradictingTaskLineageIds,
		};
		return {
			metadata: metadata(
				content.scoreId,
				this.#producer,
				group.proposalRevisions.map((revision) => revision.candidateId),
				scope,
				createdAt,
				content,
			),
			...content,
		};
	}
}

export class PersistentSkillCandidateRegistry implements SkillCandidateRegistry {
	readonly #artifacts: EvolutionArtifactStore;
	readonly #store: SkillCandidateRegistryStore;
	readonly #scorer: DeterministicSkillCandidatePriorityScorer;
	readonly #producer: EvolutionArtifactProducer;
	readonly #maxCommitAttempts: number;

	constructor(
		dependencies: PersistentSkillCandidateRegistryDependencies,
		options: PersistentSkillCandidateRegistryOptions = {},
	) {
		this.#artifacts = dependencies.artifacts;
		this.#store = dependencies.store;
		this.#scorer =
			dependencies.scorer ?? new DeterministicSkillCandidatePriorityScorer({ version: dependencies.version });
		this.#producer = {
			name: "diffex-skill-candidate-registry",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
		this.#maxCommitAttempts = boundedPositiveInteger(
			options.maxCommitAttempts,
			DEFAULT_MAX_COMMIT_ATTEMPTS,
			"maxCommitAttempts",
		);
	}

	async list(scope: EvolutionScope): Promise<readonly SkillCandidateGroup[]> {
		const snapshot = await this.#store.loadSkillCandidateRegistry(scope);
		return [...materializeGroups(snapshot.events).values()]
			.map(immutableGroup)
			.sort((left, right) => left.groupId.localeCompare(right.groupId));
	}

	async recordDraft(input: SkillCandidateDraftRecordingInput): Promise<SkillCandidateGroup> {
		for (let attempt = 0; attempt < this.#maxCommitAttempts; attempt += 1) {
			const snapshot = await this.#store.loadSkillCandidateRegistry(input.scope);
			const groups = materializeGroups(snapshot.events);
			const mutable = groups.get(input.groupId);
			if (mutable === undefined) throw new Error(`Unknown candidate group "${input.groupId}"`);
			let group = immutableGroup(mutable);
			if (
				!sameValues(
					input.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				)
			) {
				throw new Error(`Candidate group "${input.groupId}" changed before its draft was recorded`);
			}
			if (group.state !== "evidence-qualified" && group.state !== "drafted") {
				throw new Error(`Candidate group "${input.groupId}" is not eligible to record a draft`);
			}
			const artifact = await this.#artifacts.get(input.draft);
			if (!("artifactKind" in artifact) || artifact.artifactKind !== "skill-draft") {
				throw new Error(`Candidate group "${input.groupId}" draft artifact is invalid`);
			}
			assertDraft(artifact, input.draft, group, input);
			if (
				group.draft !== null &&
				(group.draft.artifactId !== input.draft.artifactId ||
					group.draft.contentDigest !== input.draft.contentDigest)
			) {
				throw new Error(`Candidate group "${input.groupId}" already has a different draft`);
			}
			const planned: SkillCandidateRegistryEvent[] = [];
			if (group.draft === null) {
				const registrySequence = nextSequence(snapshot.events, planned.length);
				const content = {
					schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
					eventId: stableId("skill-candidate-event", {
						idempotencyKey: input.idempotencyKey,
						registrySequence,
						type: "skill-candidate-draft-recorded",
						groupId: input.groupId,
					}),
					registrySequence,
					type: "skill-candidate-draft-recorded" as const,
					groupId: input.groupId,
					draft: input.draft,
					proposalRevisionIds: input.proposalRevisionIds,
					idempotencyKey: input.idempotencyKey,
				};
				planned.push(
					withEventMetadata(
						content,
						this.#producer,
						[input.groupId, input.draft.artifactId],
						input.scope,
						input.createdAt,
					),
				);
				mutable.draft = input.draft;
				mutable.draftProposalRevisionIds.splice(
					0,
					mutable.draftProposalRevisionIds.length,
					...input.proposalRevisionIds,
				);
				group = immutableGroup(mutable);
			}
			if (group.state === "evidence-qualified") {
				const transition = transitionEvent(
					input.groupId,
					"evidence-qualified",
					"drafted",
					["outcome-aware-draft-recorded"],
					nextSequence(snapshot.events, planned.length),
					input.idempotencyKey,
					this.#producer,
					input.scope,
					input.createdAt,
				);
				planned.push(transition);
				mutable.state = "drafted";
				mutable.dispositionHistory.push({
					eventId: transition.eventId,
					from: transition.from,
					to: transition.to,
					reasonCodes: transition.reasonCodes,
					createdAt: input.createdAt,
				});
			}
			if (planned.length === 0) return immutableGroup(mutable);
			const committed = await this.#store.appendSkillCandidateRegistryEvents(
				input.scope,
				snapshot.revision,
				planned,
			);
			if (committed === "committed") return immutableGroup(mutable);
		}
		throw new Error("Skill candidate registry changed too often to record a draft");
	}

	async recordValidation(input: SkillCandidateValidationRecordingInput): Promise<SkillCandidateGroup> {
		for (let attempt = 0; attempt < this.#maxCommitAttempts; attempt += 1) {
			const snapshot = await this.#store.loadSkillCandidateRegistry(input.scope);
			const groups = materializeGroups(snapshot.events);
			const mutable = groups.get(input.groupId);
			if (mutable === undefined) throw new Error(`Unknown candidate group "${input.groupId}"`);
			let group = immutableGroup(mutable);
			if (
				!sameValues(
					input.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				) ||
				group.draft?.artifactId !== input.draft.artifactId ||
				group.draft.contentDigest !== input.draft.contentDigest
			) {
				throw new Error(`Candidate group "${input.groupId}" changed before validation was recorded`);
			}
			if (group.state !== "drafted" && group.state !== "structurally-valid" && group.state !== "rejected") {
				throw new Error(`Candidate group "${input.groupId}" is not eligible to record validation`);
			}
			const artifact = await this.#artifacts.get(input.validation);
			if (!("artifactKind" in artifact) || artifact.artifactKind !== "skill-draft-validation") {
				throw new Error(`Candidate group "${input.groupId}" validation artifact is invalid`);
			}
			assertValidation(artifact, input.validation, group, input);
			if (
				group.validation !== null &&
				(group.validation.artifactId !== input.validation.artifactId ||
					group.validation.contentDigest !== input.validation.contentDigest)
			) {
				throw new Error(`Candidate group "${input.groupId}" already has a different validation report`);
			}
			const targetState = artifact.disposition === "accepted" ? "structurally-valid" : "rejected";
			if (group.state !== "drafted" && group.state !== targetState) {
				throw new Error(`Candidate group "${input.groupId}" validation disposition conflicts with its state`);
			}
			const planned: SkillCandidateRegistryEvent[] = [];
			if (group.validation === null) {
				const registrySequence = nextSequence(snapshot.events, planned.length);
				const content = {
					schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
					eventId: stableId("skill-candidate-event", {
						idempotencyKey: input.idempotencyKey,
						registrySequence,
						type: "skill-candidate-validation-recorded",
						groupId: input.groupId,
					}),
					registrySequence,
					type: "skill-candidate-validation-recorded" as const,
					groupId: input.groupId,
					draft: input.draft,
					validation: input.validation,
					proposalRevisionIds: input.proposalRevisionIds,
					idempotencyKey: input.idempotencyKey,
				};
				planned.push(
					withEventMetadata(
						content,
						this.#producer,
						[input.groupId, input.draft.artifactId, input.validation.artifactId],
						input.scope,
						input.createdAt,
					),
				);
				mutable.validation = input.validation;
				mutable.validationProposalRevisionIds.splice(
					0,
					mutable.validationProposalRevisionIds.length,
					...input.proposalRevisionIds,
				);
				group = immutableGroup(mutable);
			}
			if (group.state === "drafted") {
				const reasonCodes =
					artifact.disposition === "accepted"
						? ["deterministic-draft-validation-passed"]
						: uniqueSorted(artifact.issues.map((validationIssue) => validationIssue.code));
				const transition = transitionEvent(
					input.groupId,
					"drafted",
					targetState,
					reasonCodes,
					nextSequence(snapshot.events, planned.length),
					input.idempotencyKey,
					this.#producer,
					input.scope,
					input.createdAt,
				);
				planned.push(transition);
				mutable.state = targetState;
				mutable.dispositionHistory.push({
					eventId: transition.eventId,
					from: transition.from,
					to: transition.to,
					reasonCodes: transition.reasonCodes,
					createdAt: input.createdAt,
				});
			}
			if (planned.length === 0) return immutableGroup(mutable);
			const committed = await this.#store.appendSkillCandidateRegistryEvents(
				input.scope,
				snapshot.revision,
				planned,
			);
			if (committed === "committed") return immutableGroup(mutable);
		}
		throw new Error("Skill candidate registry changed too often to record validation");
	}

	async startEvaluation(input: SkillCandidateEvaluationStartInput): Promise<SkillCandidateGroup> {
		for (let attempt = 0; attempt < this.#maxCommitAttempts; attempt += 1) {
			const snapshot = await this.#store.loadSkillCandidateRegistry(input.scope);
			const mutable = materializeGroups(snapshot.events).get(input.groupId);
			if (mutable === undefined) throw new Error(`Unknown candidate group "${input.groupId}"`);
			const group = immutableGroup(mutable);
			if (
				!sameValues(
					input.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				) ||
				group.draft?.artifactId !== input.draft.artifactId ||
				group.draft.contentDigest !== input.draft.contentDigest ||
				group.validation?.artifactId !== input.validation.artifactId ||
				group.validation.contentDigest !== input.validation.contentDigest ||
				input.idempotencyKey !== group.evaluationIdempotencyKey
			) {
				throw new Error(`Candidate group "${input.groupId}" changed before evaluation started`);
			}
			if (group.state === "evaluation-pending") return group;
			if (group.state !== "structurally-valid") {
				throw new Error(`Candidate group "${input.groupId}" is not eligible to start evaluation`);
			}
			const validation = await this.#artifacts.get(input.validation);
			if (
				!("artifactKind" in validation) ||
				validation.artifactKind !== "skill-draft-validation" ||
				validation.disposition !== "accepted" ||
				computeEvolutionContentDigest(validation) !== input.validation.contentDigest
			) {
				throw new Error(`Candidate group "${input.groupId}" does not have accepted validation`);
			}
			const transition = transitionEvent(
				input.groupId,
				"structurally-valid",
				"evaluation-pending",
				["retrieval-and-behavior-evaluation-started"],
				nextSequence(snapshot.events, 0),
				input.idempotencyKey,
				this.#producer,
				input.scope,
				input.createdAt,
			);
			const committed = await this.#store.appendSkillCandidateRegistryEvents(input.scope, snapshot.revision, [
				transition,
			]);
			if (committed === "committed") {
				mutable.state = "evaluation-pending";
				mutable.dispositionHistory.push({
					eventId: transition.eventId,
					from: transition.from,
					to: transition.to,
					reasonCodes: transition.reasonCodes,
					createdAt: input.createdAt,
				});
				return immutableGroup(mutable);
			}
		}
		throw new Error("Skill candidate registry changed too often to start evaluation");
	}

	async recordEvaluation(input: SkillCandidateEvaluationRecordingInput): Promise<SkillCandidateGroup> {
		for (let attempt = 0; attempt < this.#maxCommitAttempts; attempt += 1) {
			const snapshot = await this.#store.loadSkillCandidateRegistry(input.scope);
			const mutable = materializeGroups(snapshot.events).get(input.groupId);
			if (mutable === undefined) throw new Error(`Unknown candidate group "${input.groupId}"`);
			let group = immutableGroup(mutable);
			if (
				!sameValues(
					input.proposalRevisionIds,
					group.proposalRevisions.map((revision) => revision.revisionId),
				) ||
				group.draft?.artifactId !== input.draft.artifactId ||
				group.draft.contentDigest !== input.draft.contentDigest ||
				group.validation?.artifactId !== input.validation.artifactId ||
				group.validation.contentDigest !== input.validation.contentDigest
			) {
				throw new Error(`Candidate group "${input.groupId}" changed before evaluation was recorded`);
			}
			if (group.state !== "evaluation-pending" && group.state !== "accepted" && group.state !== "quarantined") {
				throw new Error(`Candidate group "${input.groupId}" is not eligible to record evaluation`);
			}
			const artifact = await this.#artifacts.get(input.evaluation);
			if (!("artifactKind" in artifact) || artifact.artifactKind !== "skill-evaluation") {
				throw new Error(`Candidate group "${input.groupId}" evaluation artifact is invalid`);
			}
			assertEvaluation(artifact, input.evaluation, group, input);
			const validation = await this.#artifacts.get(input.validation);
			if (
				!("artifactKind" in validation) ||
				validation.artifactKind !== "skill-draft-validation" ||
				validation.disposition !== "accepted" ||
				validation.validatedHarnessVersion !== artifact.harnessVersion
			) {
				throw new Error(`Candidate group "${input.groupId}" evaluation uses stale validation`);
			}
			if (
				group.evaluation !== null &&
				(group.evaluation.artifactId !== input.evaluation.artifactId ||
					group.evaluation.contentDigest !== input.evaluation.contentDigest)
			) {
				throw new Error(`Candidate group "${input.groupId}" already has a different evaluation report`);
			}
			const targetState = artifact.disposition;
			if (group.state !== "evaluation-pending" && group.state !== targetState) {
				throw new Error(`Candidate group "${input.groupId}" evaluation disposition conflicts with its state`);
			}
			const planned: SkillCandidateRegistryEvent[] = [];
			if (group.evaluation === null) {
				const registrySequence = nextSequence(snapshot.events, planned.length);
				const content = {
					schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
					eventId: stableId("skill-candidate-event", {
						idempotencyKey: input.idempotencyKey,
						registrySequence,
						type: "skill-candidate-evaluation-recorded",
						groupId: input.groupId,
					}),
					registrySequence,
					type: "skill-candidate-evaluation-recorded" as const,
					groupId: input.groupId,
					draft: input.draft,
					validation: input.validation,
					evaluation: input.evaluation,
					proposalRevisionIds: input.proposalRevisionIds,
					idempotencyKey: input.idempotencyKey,
				};
				planned.push(
					withEventMetadata(
						content,
						this.#producer,
						[input.groupId, input.draft.artifactId, input.validation.artifactId, input.evaluation.artifactId],
						input.scope,
						input.createdAt,
					),
				);
				mutable.evaluation = input.evaluation;
				mutable.evaluationProposalRevisionIds.splice(
					0,
					mutable.evaluationProposalRevisionIds.length,
					...input.proposalRevisionIds,
				);
				group = immutableGroup(mutable);
			}
			if (group.state === "evaluation-pending") {
				const failedReasons = uniqueSorted([
					...artifact.gates.suite.reasonCodes,
					...artifact.gates.retrieval.reasonCodes,
					...artifact.gates.behavior.reasonCodes,
				]);
				const transition = transitionEvent(
					input.groupId,
					"evaluation-pending",
					targetState,
					targetState === "accepted"
						? ["retrieval-and-behavior-gates-passed"]
						: failedReasons.length === 0
							? ["evaluation-gates-not-passed"]
							: failedReasons,
					nextSequence(snapshot.events, planned.length),
					input.idempotencyKey,
					this.#producer,
					input.scope,
					input.createdAt,
				);
				planned.push(transition);
				mutable.state = targetState;
				mutable.dispositionHistory.push({
					eventId: transition.eventId,
					from: transition.from,
					to: transition.to,
					reasonCodes: transition.reasonCodes,
					createdAt: input.createdAt,
				});
			}
			if (planned.length === 0) return immutableGroup(mutable);
			const committed = await this.#store.appendSkillCandidateRegistryEvents(
				input.scope,
				snapshot.revision,
				planned,
			);
			if (committed === "committed") return immutableGroup(mutable);
		}
		throw new Error("Skill candidate registry changed too often to record evaluation");
	}

	async consolidate(
		input: SkillCandidateRegistryConsolidationInput,
	): Promise<SkillCandidateRegistryConsolidationResult> {
		input.signal?.throwIfAborted();
		const lineagesByEvidence = taskLineagesByEvidence(input.input);
		const candidates = [...input.candidates].sort((left, right) =>
			left.candidate.candidateId.localeCompare(right.candidate.candidateId),
		);
		for (const item of candidates) assertCandidate(item.candidate, item.reference, input.input);

		for (let attempt = 0; attempt < this.#maxCommitAttempts; attempt += 1) {
			input.signal?.throwIfAborted();
			const snapshot = await this.#store.loadSkillCandidateRegistry(input.input.metadata.scope);
			const groups = materializeGroups(snapshot.events);
			const existingCandidateIds = new Set(
				[...groups.values()].flatMap((group) =>
					group.proposalRevisions.map(
						(revision) => `${revision.sourceEvolutionJobId}\u0000${revision.candidateId}`,
					),
				),
			);
			const planned: SkillCandidateRegistryEvent[] = [];
			const changedGroupIds = new Set<string>();

			for (const item of candidates) {
				const candidateKey = `${input.sourceEvolutionJobId}\u0000${item.candidate.candidateId}`;
				if (existingCandidateIds.has(candidateKey)) continue;
				const profile = groupingProfile(item.candidate);
				let group = groupForProfile(groups, profile);
				if (group === null) {
					const groupId = stableId("skill-candidate-group", profile);
					group = {
						groupId,
						profile,
						proposalRevisions: [],
						state: "proposed",
						dispositionHistory: [],
						priorityScore: null,
						draft: null,
						draftProposalRevisionIds: [],
						validation: null,
						validationProposalRevisionIds: [],
						evaluation: null,
						evaluationProposalRevisionIds: [],
						scoredProposalRevisionIds: [],
					};
					groups.set(groupId, group);
				}
				const evidence = evidenceContribution(item.candidate, lineagesByEvidence);
				const proposalRevision: SkillCandidateProposalRevision = {
					revisionId: stableId("skill-candidate-revision", {
						sourceEvolutionJobId: input.sourceEvolutionJobId,
						candidate: item.reference,
					}),
					candidateId: item.candidate.candidateId,
					candidate: item.reference,
					sourceEvolutionJobId: input.sourceEvolutionJobId,
					createdAt: input.createdAt,
					evidence,
				};
				const registrySequence = nextSequence(snapshot.events, planned.length);
				const content = {
					schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
					eventId: stableId("skill-candidate-event", {
						idempotencyKey: input.idempotencyKey,
						registrySequence,
						proposalRevision,
					}),
					registrySequence,
					type: "skill-candidate-proposal-recorded" as const,
					groupId: group.groupId,
					profile,
					proposalRevision,
				};
				const event: SkillCandidateProposalRecordedEvent = withEventMetadata(
					content,
					this.#producer,
					[item.candidate.candidateId, input.sourceEvolutionJobId],
					input.input.metadata.scope,
					input.createdAt,
				);
				planned.push(event);
				group.proposalRevisions.push(proposalRevision);
				changedGroupIds.add(group.groupId);
				existingCandidateIds.add(candidateKey);
			}

			for (const group of groups.values()) {
				const revisionIds = group.proposalRevisions.map((revision) => revision.revisionId);
				const qualification = this.#scorer.qualification(immutableGroup(group));
				if (!sameValues(group.scoredProposalRevisionIds, revisionIds) || qualification.state !== group.state) {
					changedGroupIds.add(group.groupId);
				}
			}

			for (const groupId of [...changedGroupIds].sort((left, right) => left.localeCompare(right))) {
				const group = groups.get(groupId);
				if (group === undefined) throw new Error(`Candidate group "${groupId}" disappeared during consolidation`);
				if (group.dispositionHistory.length === 0) {
					const initial = transitionEvent(
						group.groupId,
						null,
						"proposed",
						["candidate-recorded"],
						nextSequence(snapshot.events, planned.length),
						input.idempotencyKey,
						this.#producer,
						input.input.metadata.scope,
						input.createdAt,
					);
					planned.push(initial);
					group.dispositionHistory.push({
						eventId: initial.eventId,
						from: null,
						to: "proposed",
						reasonCodes: initial.reasonCodes,
						createdAt: input.createdAt,
					});
				}
				const immutable = immutableGroup(group);
				const score = this.#scorer.score(immutable, input.input.metadata.scope, input.createdAt);
				const scoreReference = await this.#artifacts.put(score);
				const scoreSequence = nextSequence(snapshot.events, planned.length);
				const scoreContent = {
					schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
					eventId: stableId("skill-candidate-event", {
						idempotencyKey: input.idempotencyKey,
						registrySequence: scoreSequence,
						score: scoreReference,
					}),
					registrySequence: scoreSequence,
					type: "skill-candidate-priority-scored" as const,
					groupId,
					score: scoreReference,
					proposalRevisionIds: immutable.proposalRevisions.map((revision) => revision.revisionId),
				};
				planned.push(
					withEventMetadata(
						scoreContent,
						this.#producer,
						[score.scoreId, groupId],
						input.input.metadata.scope,
						input.createdAt,
					),
				);
				group.priorityScore = scoreReference;
				group.scoredProposalRevisionIds.splice(
					0,
					group.scoredProposalRevisionIds.length,
					...scoreContent.proposalRevisionIds,
				);
				const qualification = this.#scorer.qualification(immutableGroup(group));
				if (qualification.state !== group.state) {
					const transition = transitionEvent(
						groupId,
						group.state,
						qualification.state,
						qualification.reasonCodes,
						nextSequence(snapshot.events, planned.length),
						input.idempotencyKey,
						this.#producer,
						input.input.metadata.scope,
						input.createdAt,
					);
					planned.push(transition);
					group.state = qualification.state;
					group.dispositionHistory.push({
						eventId: transition.eventId,
						from: transition.from,
						to: transition.to,
						reasonCodes: transition.reasonCodes,
						createdAt: input.createdAt,
					});
				}
			}

			if (planned.length === 0) {
				return {
					groups: [...groups.values()]
						.map(immutableGroup)
						.sort((left, right) => left.groupId.localeCompare(right.groupId)),
					changedGroupIds: [],
				};
			}
			const committed = await this.#store.appendSkillCandidateRegistryEvents(
				input.input.metadata.scope,
				snapshot.revision,
				planned,
			);
			if (committed === "conflict") continue;
			return {
				groups: [...groups.values()]
					.map(immutableGroup)
					.sort((left, right) => left.groupId.localeCompare(right.groupId)),
				changedGroupIds: [...changedGroupIds].sort((left, right) => left.localeCompare(right)),
			};
		}
		throw new Error("Skill candidate registry changed too often to consolidate this batch");
	}
}
