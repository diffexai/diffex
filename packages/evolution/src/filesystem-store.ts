import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type {
	EvolutionArtifactReference,
	EvolutionJob,
	EvolutionLeaseToken,
	EvolutionLedgerEvent,
	EvolutionProcessedEvidenceCursor,
	EvolutionScope,
	SkillCandidateRegistryEvent,
	SkillCandidateRegistrySnapshot,
	SkillLifecycleObservation,
	SkillLifecycleSkillVersion,
} from "./contracts.ts";
import {
	EVOLUTION_SCHEMA_VERSION,
	SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
	SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
} from "./contracts.ts";
import {
	LESSON_SCORE_SCHEMA_VERSION,
	type LessonScoreIdentity,
	type LessonScoreLedger,
	type LessonScoreStore,
} from "./lesson-score-store.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionCancellationRequest,
	EvolutionCancellationStore,
	EvolutionCursorCommitResult,
	EvolutionCursorStore,
	EvolutionJobStore,
	EvolutionLeaseStore,
	EvolutionLedger,
	SkillCandidateRegistryAppendResult,
	SkillCandidateRegistryStore,
	SkillLifecycleObservationAppendResult,
	SkillLifecycleObservationStore,
} from "./ports.ts";
import { computeEvolutionContentDigest, serializeEvolutionValue } from "./provenance.ts";

const ARTIFACT_FILE_NAME = "artifact.json";
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_UPDATE_MS = 10_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const JOB_STAGES = new Set([
	"queued",
	"snapshotting",
	"counter-slot",
	"reflecting",
	"curating",
	"validating",
	"skill-curating",
	"writing",
	"activating",
	"completed",
]);
const ACTIVE_JOB_STAGES = new Set([...JOB_STAGES].filter((stage) => stage !== "completed"));
const SKILL_CANDIDATE_REGISTRY_EVENT_TYPES = new Set([
	"skill-candidate-draft-recorded",
	"skill-candidate-evaluation-recorded",
	"skill-candidate-group-capsule-recorded",
	"skill-candidate-priority-scored",
	"skill-candidate-proposal-recorded",
	"skill-candidate-state-transitioned",
	"skill-candidate-validation-recorded",
	"skill-candidate-work-checkpointed",
	"skill-candidate-work-failed",
]);
const SKILL_CANDIDATE_STATES = new Set([
	"proposed",
	"evidence-qualified",
	"synthesis-failed",
	"drafted",
	"structurally-valid",
	"evaluation-pending",
	"accepted",
	"quarantined",
	"rejected",
	"retired",
]);
const SKILL_CANDIDATE_WORK_STAGES = new Set([
	"consolidating",
	"scoring",
	"synthesizing",
	"validating",
	"evaluating",
	"activating",
	"completed",
]);
const SKILL_LIFECYCLE_SIGNALS = new Set(["helpful", "harmful", "neutral", "unknown"]);
const SKILL_LIFECYCLE_SIGNAL_SOURCES = new Set([
	"direct-user",
	"environment",
	"model-self-assessment",
	"replay",
	"test",
	"tool",
]);
const SKILL_LIFECYCLE_ATTRIBUTION_METHODS = new Set([
	"co-occurrence",
	"deterministic",
	"direct",
	"inferred",
	"self-assessed",
]);
const SKILL_LIFECYCLE_INVOCATION_EVENTS = new Set([
	"available",
	"explicitly-referenced",
	"force-loaded",
	"listed",
	"read",
	"selected",
]);
const SKILL_LIFECYCLE_ISSUE_KINDS = new Set([
	"duplicate-guidance",
	"obsolete-guidance",
	"procedure-defect",
	"trigger-mismatch",
]);
const JOB_OUTCOMES = new Set([
	"active",
	"completed",
	"interrupted",
	"retryable-failed",
	"terminal-failed",
	"superseded",
]);

interface StoredLease {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly kind: EvolutionLeaseToken["kind"];
	readonly key: string;
	readonly ownerId: string;
	readonly fence: number;
	readonly expiresAt: string;
	readonly releasedAt: string | null;
}

export class EvolutionStorageCorruptionError extends Error {
	readonly path: string;

	constructor(path: string, message: string, options?: ErrorOptions) {
		super(`Corrupt evolution storage at "${path}": ${message}`, options);
		this.name = "EvolutionStorageCorruptionError";
		this.path = path;
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeId(value: string, description: string): void {
	if (!SAFE_ID_PATTERN.test(value)) throw new Error(`Invalid ${description} "${value}"`);
}

function parseIsoTimestamp(value: string, description: string): number {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(`${description} must be a valid ISO timestamp`);
	return timestamp;
}

function parseJson(contents: string, path: string): unknown {
	try {
		return JSON.parse(contents);
	} catch (cause) {
		throw new EvolutionStorageCorruptionError(path, "invalid JSON", { cause });
	}
}

function assertDirectFile(path: string, stats: Awaited<ReturnType<typeof lstat>>): void {
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new EvolutionStorageCorruptionError(path, "expected a direct regular file");
	}
}

function assertMetadata(value: unknown, path: string, expectedArtifactId?: string): void {
	if (
		!isRecord(value) ||
		value.schemaVersion !== EVOLUTION_SCHEMA_VERSION ||
		typeof value.artifactId !== "string" ||
		!SAFE_ID_PATTERN.test(value.artifactId) ||
		(expectedArtifactId !== undefined && value.artifactId !== expectedArtifactId) ||
		!isRecord(value.producer) ||
		typeof value.producer.name !== "string" ||
		typeof value.producer.version !== "string" ||
		(typeof value.producer.promptVersion !== "string" && value.producer.promptVersion !== null) ||
		(value.producer.model !== null &&
			(!isRecord(value.producer.model) ||
				typeof value.producer.model.provider !== "string" ||
				typeof value.producer.model.model !== "string" ||
				typeof value.producer.model.configurationDigest !== "string" ||
				!DIGEST_PATTERN.test(value.producer.model.configurationDigest))) ||
		!Array.isArray(value.sourceIds) ||
		value.sourceIds.some((sourceId) => typeof sourceId !== "string" || sourceId.length === 0) ||
		typeof value.contentDigest !== "string" ||
		!DIGEST_PATTERN.test(value.contentDigest) ||
		!isRecord(value.scope) ||
		typeof value.scope.repositoryId !== "string" ||
		typeof value.scope.scopeId !== "string" ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt))
	) {
		throw new EvolutionStorageCorruptionError(path, "artifact metadata is invalid or incompatible");
	}
}

function parseArtifact(contents: string, path: string): EvolutionArtifact {
	const parsed = parseJson(contents, path);
	if (!isRecord(parsed)) throw new EvolutionStorageCorruptionError(path, "artifact is invalid");
	assertMetadata(parsed.metadata, path);
	return parsed as unknown as EvolutionArtifact;
}

function parseJob(contents: string, path: string): EvolutionJob {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		typeof parsed.jobId !== "string" ||
		!SAFE_ID_PATTERN.test(parsed.jobId) ||
		!Number.isSafeInteger(parsed.revision) ||
		(parsed.revision as number) < 0 ||
		!Number.isSafeInteger(parsed.attempt) ||
		(parsed.attempt as number) < 0 ||
		!JOB_STAGES.has(String(parsed.stage)) ||
		!JOB_OUTCOMES.has(String(parsed.outcome)) ||
		(parsed.trigger !== "automatic" && parsed.trigger !== "manual") ||
		!Array.isArray(parsed.checkpoints) ||
		!isRecord(parsed.metadata) ||
		!isRecord(parsed.metadata.scope) ||
		typeof parsed.metadata.scope.repositoryId !== "string" ||
		typeof parsed.metadata.scope.scopeId !== "string" ||
		!isRecord(parsed.inputSnapshot) ||
		typeof parsed.inputSnapshot.artifactId !== "string" ||
		!SAFE_ID_PATTERN.test(parsed.inputSnapshot.artifactId) ||
		typeof parsed.inputSnapshot.contentDigest !== "string" ||
		!DIGEST_PATTERN.test(parsed.inputSnapshot.contentDigest) ||
		!isRecord(parsed.evidenceRange) ||
		!Number.isSafeInteger(parsed.evidenceRange.afterCursor) ||
		!Number.isSafeInteger(parsed.evidenceRange.throughCursor) ||
		(parsed.evidenceRange.afterCursor as number) < 0 ||
		(parsed.evidenceRange.throughCursor as number) < (parsed.evidenceRange.afterCursor as number) ||
		typeof parsed.createdAt !== "string" ||
		typeof parsed.updatedAt !== "string" ||
		(typeof parsed.terminalAt !== "string" && parsed.terminalAt !== null) ||
		(typeof parsed.retryNotBefore !== "string" && parsed.retryNotBefore !== null) ||
		(typeof parsed.reasonCode !== "string" && parsed.reasonCode !== null) ||
		(typeof parsed.failureMessage !== "string" && parsed.failureMessage !== null) ||
		(parsed.completion !== null && !isRecord(parsed.completion)) ||
		(parsed.resolution !== null && !isRecord(parsed.resolution)) ||
		parsed.checkpoints.some(
			(checkpoint) =>
				!isRecord(checkpoint) ||
				checkpoint.schemaVersion !== EVOLUTION_SCHEMA_VERSION ||
				!ACTIVE_JOB_STAGES.has(String(checkpoint.stage)) ||
				typeof checkpoint.idempotencyKey !== "string" ||
				!Array.isArray(checkpoint.outputArtifacts) ||
				checkpoint.outputArtifacts.some(
					(reference) =>
						!isRecord(reference) ||
						typeof reference.artifactId !== "string" ||
						!SAFE_ID_PATTERN.test(reference.artifactId) ||
						typeof reference.contentDigest !== "string" ||
						!DIGEST_PATTERN.test(reference.contentDigest),
				) ||
				!isRecord(checkpoint.state) ||
				(typeof checkpoint.startedAt !== "string" && checkpoint.startedAt !== undefined) ||
				typeof checkpoint.completedAt !== "string",
		)
	) {
		throw new EvolutionStorageCorruptionError(path, "job manifest is invalid");
	}
	assertMetadata(parsed.metadata, path, parsed.jobId);
	const { metadata, ...jobContent } = parsed;
	if (metadata.contentDigest !== computeEvolutionContentDigest(jobContent)) {
		throw new EvolutionStorageCorruptionError(path, "job manifest content digest is invalid");
	}
	return parsed as unknown as EvolutionJob;
}

function parseLedgerEvent(contents: string, path: string): EvolutionLedgerEvent {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		typeof parsed.eventId !== "string" ||
		!SAFE_ID_PATTERN.test(parsed.eventId) ||
		typeof parsed.jobId !== "string" ||
		!SAFE_ID_PATTERN.test(parsed.jobId) ||
		typeof parsed.type !== "string"
	) {
		throw new EvolutionStorageCorruptionError(path, "ledger event is invalid");
	}
	assertMetadata(parsed.metadata, path, parsed.eventId);
	return parsed as unknown as EvolutionLedgerEvent;
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isCandidateWorkErrorDiagnostic(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.message === "string" &&
		(value.reasonCode === null || typeof value.reasonCode === "string") &&
		(value.retryable === null || typeof value.retryable === "boolean") &&
		isJsonValue(value.diagnostics) &&
		(value.cause === null ||
			(isRecord(value.cause) && typeof value.cause.name === "string" && typeof value.cause.message === "string"))
	);
}

function isCandidateGroupFailureDiagnostic(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.groupId === null || typeof value.groupId === "string") &&
		(value.synthesisIdempotencyKey === undefined || typeof value.synthesisIdempotencyKey === "string") &&
		isCandidateWorkErrorDiagnostic(value.error)
	);
}

function isArtifactReference(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.artifactId === "string" &&
		SAFE_ID_PATTERN.test(value.artifactId) &&
		typeof value.contentDigest === "string" &&
		DIGEST_PATTERN.test(value.contentDigest)
	);
}

function isCandidateEvidenceContribution(value: unknown): boolean {
	return (
		isRecord(value) &&
		isStringArray(value.supportingEvidenceIds) &&
		isStringArray(value.contradictingEvidenceIds) &&
		isStringArray(value.supportingTraceIds) &&
		isStringArray(value.contradictingTraceIds) &&
		isStringArray(value.supportingTaskLineageIds) &&
		isStringArray(value.contradictingTaskLineageIds)
	);
}

function isCandidateRegistryEventContent(
	value: Readonly<Record<string, unknown>>,
	allowLegacyWorkFailure: boolean,
): boolean {
	if (value.type === "skill-candidate-group-capsule-recorded") {
		return (
			typeof value.groupId === "string" &&
			isArtifactReference(value.capsule) &&
			isStringArray(value.proposalRevisionIds)
		);
	}
	if (value.type === "skill-candidate-draft-recorded") {
		return (
			typeof value.groupId === "string" &&
			isArtifactReference(value.draft) &&
			isStringArray(value.proposalRevisionIds) &&
			typeof value.idempotencyKey === "string"
		);
	}
	if (value.type === "skill-candidate-evaluation-recorded") {
		return (
			typeof value.groupId === "string" &&
			isArtifactReference(value.draft) &&
			isArtifactReference(value.validation) &&
			isArtifactReference(value.evaluation) &&
			isStringArray(value.proposalRevisionIds) &&
			typeof value.idempotencyKey === "string"
		);
	}
	if (value.type === "skill-candidate-validation-recorded") {
		return (
			typeof value.groupId === "string" &&
			isArtifactReference(value.draft) &&
			isArtifactReference(value.validation) &&
			isStringArray(value.proposalRevisionIds) &&
			typeof value.idempotencyKey === "string"
		);
	}
	if (value.type === "skill-candidate-priority-scored") {
		return (
			typeof value.groupId === "string" &&
			isArtifactReference(value.score) &&
			isStringArray(value.proposalRevisionIds)
		);
	}
	if (value.type === "skill-candidate-proposal-recorded") {
		if (!isRecord(value.profile) || !isRecord(value.profile.workspace) || !isRecord(value.proposalRevision)) {
			return false;
		}
		return (
			typeof value.groupId === "string" &&
			typeof value.profile.workspace.repositoryId === "string" &&
			(value.profile.workspace.directoryId === undefined ||
				typeof value.profile.workspace.directoryId === "string") &&
			isRecord(value.profile.workspace.evolutionScope) &&
			typeof value.profile.workspace.evolutionScope.repositoryId === "string" &&
			typeof value.profile.workspace.evolutionScope.scopeId === "string" &&
			isStringArray(value.profile.existingSkillIds) &&
			typeof value.profile.skillability === "string" &&
			isStringArray(value.profile.triggerTerms) &&
			isStringArray(value.profile.proceduralIntentTerms) &&
			isStringArray(value.profile.applicabilityTerms) &&
			typeof value.proposalRevision.revisionId === "string" &&
			typeof value.proposalRevision.candidateId === "string" &&
			isArtifactReference(value.proposalRevision.candidate) &&
			typeof value.proposalRevision.sourceEvolutionJobId === "string" &&
			typeof value.proposalRevision.createdAt === "string" &&
			isCandidateEvidenceContribution(value.proposalRevision.evidence)
		);
	}
	if (value.type === "skill-candidate-state-transitioned") {
		return (
			typeof value.groupId === "string" &&
			(value.from === null || (typeof value.from === "string" && SKILL_CANDIDATE_STATES.has(value.from))) &&
			typeof value.to === "string" &&
			SKILL_CANDIDATE_STATES.has(value.to) &&
			isStringArray(value.reasonCodes)
		);
	}
	if (value.type === "skill-candidate-work-checkpointed") {
		return (
			typeof value.workId === "string" &&
			typeof value.sourceEvolutionJobId === "string" &&
			typeof value.stage === "string" &&
			SKILL_CANDIDATE_WORK_STAGES.has(value.stage) &&
			typeof value.idempotencyKey === "string" &&
			Number.isSafeInteger(value.attempt) &&
			(value.attempt as number) > 0 &&
			isStringArray(value.groupIds)
		);
	}
	if (
		value.type !== "skill-candidate-work-failed" ||
		typeof value.workId !== "string" ||
		typeof value.sourceEvolutionJobId !== "string" ||
		typeof value.idempotencyKey !== "string" ||
		!Number.isSafeInteger(value.attempt) ||
		(value.attempt as number) < 1 ||
		typeof value.message !== "string" ||
		(value.retryNotBefore !== null &&
			(typeof value.retryNotBefore !== "string" || !Number.isFinite(Date.parse(value.retryNotBefore))))
	) {
		return false;
	}
	const hasStage = value.stage !== undefined;
	const hasDiagnostics = value.diagnostics !== undefined;
	if (hasStage !== hasDiagnostics) return false;
	if (!hasStage) return allowLegacyWorkFailure;
	return (
		typeof value.stage === "string" &&
		SKILL_CANDIDATE_WORK_STAGES.has(value.stage) &&
		Array.isArray(value.diagnostics) &&
		value.diagnostics.length > 0 &&
		value.diagnostics.every(isCandidateGroupFailureDiagnostic)
	);
}

function parseSkillCandidateRegistryEvent(
	contents: string,
	path: string,
	allowLegacyWorkFailure = false,
): SkillCandidateRegistryEvent {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION ||
		typeof parsed.eventId !== "string" ||
		!SAFE_ID_PATTERN.test(parsed.eventId) ||
		!Number.isSafeInteger(parsed.registrySequence) ||
		(parsed.registrySequence as number) < 1 ||
		typeof parsed.type !== "string" ||
		!SKILL_CANDIDATE_REGISTRY_EVENT_TYPES.has(parsed.type) ||
		!isCandidateRegistryEventContent(parsed, allowLegacyWorkFailure)
	) {
		throw new EvolutionStorageCorruptionError(path, "skill candidate registry event is invalid");
	}
	assertMetadata(parsed.metadata, path, parsed.eventId);
	const { metadata, ...content } = parsed;
	if (!isRecord(metadata) || metadata.contentDigest !== computeEvolutionContentDigest(content)) {
		throw new EvolutionStorageCorruptionError(path, "skill candidate registry event content digest is invalid");
	}
	return parsed as unknown as SkillCandidateRegistryEvent;
}

function isSkillLifecycleVersion(value: unknown): value is SkillLifecycleSkillVersion {
	return (
		isRecord(value) &&
		typeof value.skillId === "string" &&
		value.skillId.length > 0 &&
		typeof value.version === "string" &&
		value.version.length > 0 &&
		typeof value.contentDigest === "string" &&
		DIGEST_PATTERN.test(value.contentDigest) &&
		(value.sourceKind === "evolved" || value.sourceKind === "installed") &&
		typeof value.harnessRevision === "string" &&
		DIGEST_PATTERN.test(value.harnessRevision) &&
		isRecord(value.workspace) &&
		typeof value.workspace.repositoryId === "string" &&
		value.workspace.repositoryId.length > 0 &&
		(value.workspace.directoryId === undefined || typeof value.workspace.directoryId === "string")
	);
}

function parseSkillLifecycleObservation(contents: string, path: string): SkillLifecycleObservation {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION ||
		typeof parsed.observationId !== "string" ||
		!SAFE_ID_PATTERN.test(parsed.observationId) ||
		!isRecord(parsed.scope) ||
		typeof parsed.scope.repositoryId !== "string" ||
		typeof parsed.scope.scopeId !== "string" ||
		!isSkillLifecycleVersion(parsed.skill) ||
		parsed.skill.workspace.repositoryId !== parsed.scope.repositoryId ||
		!Array.isArray(parsed.relatedSkills) ||
		parsed.relatedSkills.some((skill) => !isSkillLifecycleVersion(skill)) ||
		!isStringArray(parsed.invocationEvents) ||
		parsed.invocationEvents.length === 0 ||
		parsed.invocationEvents.some((event) => !SKILL_LIFECYCLE_INVOCATION_EVENTS.has(event)) ||
		typeof parsed.topLevelTaskLineageId !== "string" ||
		parsed.topLevelTaskLineageId.length === 0 ||
		!isStringArray(parsed.traceIds) ||
		!isStringArray(parsed.evidenceIds) ||
		typeof parsed.signal !== "string" ||
		!SKILL_LIFECYCLE_SIGNALS.has(parsed.signal) ||
		typeof parsed.signalSource !== "string" ||
		!SKILL_LIFECYCLE_SIGNAL_SOURCES.has(parsed.signalSource) ||
		typeof parsed.attributionMethod !== "string" ||
		!SKILL_LIFECYCLE_ATTRIBUTION_METHODS.has(parsed.attributionMethod) ||
		(parsed.issueKind !== null &&
			(typeof parsed.issueKind !== "string" || !SKILL_LIFECYCLE_ISSUE_KINDS.has(parsed.issueKind))) ||
		(parsed.status !== "candidate" && parsed.status !== "final") ||
		typeof parsed.policyVersion !== "string" ||
		parsed.policyVersion.length === 0 ||
		typeof parsed.timestamp !== "string" ||
		!Number.isFinite(Date.parse(parsed.timestamp)) ||
		typeof parsed.idempotencyKey !== "string" ||
		parsed.idempotencyKey.length === 0
	) {
		throw new EvolutionStorageCorruptionError(path, "skill lifecycle observation is invalid");
	}
	return parsed as unknown as SkillLifecycleObservation;
}

function isLessonScoreIdentity(value: unknown): value is LessonScoreIdentity {
	return (
		isRecord(value) &&
		typeof value.memoryItemId === "string" &&
		SAFE_ID_PATTERN.test(value.memoryItemId) &&
		typeof value.contentDigest === "string" &&
		DIGEST_PATTERN.test(value.contentDigest) &&
		typeof value.creationRevision === "string" &&
		DIGEST_PATTERN.test(value.creationRevision)
	);
}

function parseLessonScoreLedger(contents: string, path: string, scope: EvolutionScope): LessonScoreLedger {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== LESSON_SCORE_SCHEMA_VERSION ||
		!isRecord(parsed.scope) ||
		typeof parsed.scope.repositoryId !== "string" ||
		typeof parsed.scope.scopeId !== "string" ||
		parsed.scope.repositoryId !== scope.repositoryId ||
		parsed.scope.scopeId !== scope.scopeId ||
		!Number.isSafeInteger(parsed.revision) ||
		(parsed.revision as number) < 0 ||
		!Array.isArray(parsed.catalogs) ||
		parsed.catalogs.some(
			(catalog) =>
				!isRecord(catalog) ||
				typeof catalog.harnessRevision !== "string" ||
				!DIGEST_PATTERN.test(catalog.harnessRevision) ||
				!Array.isArray(catalog.items) ||
				!catalog.items.every(isLessonScoreIdentity),
		) ||
		!isStringArray(parsed.appliedOutputIds) ||
		parsed.appliedOutputIds.some((id) => id.length === 0) ||
		new Set(parsed.appliedOutputIds).size !== parsed.appliedOutputIds.length ||
		!Array.isArray(parsed.rows) ||
		parsed.rows.some(
			(row) =>
				!isRecord(row) ||
				typeof row.harnessRevision !== "string" ||
				!DIGEST_PATTERN.test(row.harnessRevision) ||
				typeof row.points !== "number" ||
				!Number.isFinite(row.points) ||
				typeof row.lastAppliedOutputIdempotencyKey !== "string" ||
				row.lastAppliedOutputIdempotencyKey.length === 0 ||
				!isLessonScoreIdentity(row),
		)
	) {
		throw new EvolutionStorageCorruptionError(path, "lesson score ledger is invalid or incompatible");
	}
	const ledger = parsed as unknown as LessonScoreLedger;
	const catalogs = new Map(ledger.catalogs.map((catalog) => [catalog.harnessRevision, catalog]));
	const creations = new Map<string, string>();
	if (
		catalogs.size !== ledger.catalogs.length ||
		ledger.catalogs.some((catalog) => {
			const ids = new Set<string>();
			return catalog.items.some((item) => {
				const creation = creations.get(item.memoryItemId);
				if (ids.has(item.memoryItemId) || (creation !== undefined && creation !== item.creationRevision)) {
					return true;
				}
				ids.add(item.memoryItemId);
				creations.set(item.memoryItemId, item.creationRevision);
				return false;
			});
		}) ||
		new Set(ledger.rows.map((row) => row.memoryItemId)).size !== ledger.rows.length ||
		ledger.rows.some(
			(row) =>
				!catalogs
					.get(row.harnessRevision)
					?.items.some(
						(item) =>
							item.memoryItemId === row.memoryItemId &&
							item.contentDigest === row.contentDigest &&
							item.creationRevision === row.creationRevision,
					),
		)
	) {
		throw new EvolutionStorageCorruptionError(path, "lesson score ledger has inconsistent identities");
	}
	return ledger;
}

function parseCancellation(contents: string, path: string, expectedJobId: string): EvolutionCancellationRequest {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		parsed.jobId !== expectedJobId ||
		typeof parsed.requestedAt !== "string" ||
		!Number.isFinite(Date.parse(parsed.requestedAt))
	) {
		throw new EvolutionStorageCorruptionError(path, "cancellation request is invalid");
	}
	return parsed as unknown as EvolutionCancellationRequest;
}

function parseCursor(contents: string, path: string): EvolutionProcessedEvidenceCursor {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== EVOLUTION_SCHEMA_VERSION ||
		!isRecord(parsed.scope) ||
		!Number.isSafeInteger(parsed.sequence) ||
		(parsed.sequence as number) < 0 ||
		(typeof parsed.committedByJobId !== "string" && parsed.committedByJobId !== null) ||
		typeof parsed.updatedAt !== "string"
	) {
		throw new EvolutionStorageCorruptionError(path, "processed-evidence cursor is invalid");
	}
	return parsed as unknown as EvolutionProcessedEvidenceCursor;
}

function parseLease(contents: string, path: string): StoredLease {
	const parsed = parseJson(contents, path);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== EVOLUTION_SCHEMA_VERSION ||
		(parsed.kind !== "candidate-work" && parsed.kind !== "scope" && parsed.kind !== "writer") ||
		typeof parsed.key !== "string" ||
		typeof parsed.ownerId !== "string" ||
		!Number.isSafeInteger(parsed.fence) ||
		(parsed.fence as number) < 1 ||
		typeof parsed.expiresAt !== "string" ||
		(typeof parsed.releasedAt !== "string" && parsed.releasedAt !== null)
	) {
		throw new EvolutionStorageCorruptionError(path, "lease record is invalid");
	}
	return parsed as unknown as StoredLease;
}

function scopeMatches(left: EvolutionScope, right: EvolutionScope): boolean {
	return left.repositoryId === right.repositoryId && left.scopeId === right.scopeId;
}

function artifactDirectoryName(digest: string): string {
	if (!DIGEST_PATTERN.test(digest)) throw new Error(`Invalid artifact digest "${digest}"`);
	return digest.replace("sha256:", "sha256-");
}

export interface FileEvolutionPersistenceOptions {
	readonly storeLockStaleMs?: number;
	readonly storeLockUpdateMs?: number;
}

export class FileEvolutionPersistence
	implements
		EvolutionArtifactStore,
		EvolutionCancellationStore,
		EvolutionCursorStore,
		EvolutionJobStore,
		EvolutionLeaseStore,
		EvolutionLedger,
		LessonScoreStore,
		SkillCandidateRegistryStore,
		SkillLifecycleObservationStore
{
	readonly #rootPath: string;
	readonly #artifactPath: string;
	readonly #cancellationPath: string;
	readonly #cursorPath: string;
	readonly #jobPath: string;
	readonly #leasePath: string;
	readonly #ledgerPath: string;
	readonly #lessonScorePath: string;
	readonly #skillCandidateRegistryPath: string;
	readonly #skillLifecycleObservationPath: string;
	readonly #storeLockPath: string;
	readonly #storeLockStaleMs: number;
	readonly #storeLockUpdateMs: number;

	constructor(rootPath: string, options: FileEvolutionPersistenceOptions = {}) {
		this.#rootPath = resolve(rootPath);
		this.#artifactPath = join(this.#rootPath, "artifacts");
		this.#cancellationPath = join(this.#rootPath, "cancellations");
		this.#cursorPath = join(this.#rootPath, "cursors");
		this.#jobPath = join(this.#rootPath, "jobs");
		this.#leasePath = join(this.#rootPath, "leases");
		this.#ledgerPath = join(this.#rootPath, "ledger");
		this.#lessonScorePath = join(this.#rootPath, "lesson-scores");
		this.#skillCandidateRegistryPath = join(this.#rootPath, "skill-candidates");
		this.#skillLifecycleObservationPath = join(this.#rootPath, "skill-observations");
		this.#storeLockPath = join(this.#rootPath, ".store");
		this.#storeLockStaleMs = options.storeLockStaleMs ?? STORE_LOCK_STALE_MS;
		this.#storeLockUpdateMs = options.storeLockUpdateMs ?? STORE_LOCK_UPDATE_MS;
		if (this.#storeLockStaleMs < 2_000) throw new Error("storeLockStaleMs must be at least 2000");
		if (this.#storeLockUpdateMs < 1_000 || this.#storeLockUpdateMs > this.#storeLockStaleMs / 2) {
			throw new Error("storeLockUpdateMs must be between 1000 and half of storeLockStaleMs");
		}
	}

	async #ensureDirectories(): Promise<void> {
		for (const path of [
			this.#rootPath,
			this.#artifactPath,
			this.#cancellationPath,
			this.#cursorPath,
			this.#jobPath,
			this.#leasePath,
			this.#ledgerPath,
			this.#lessonScorePath,
			this.#skillCandidateRegistryPath,
			this.#skillLifecycleObservationPath,
		]) {
			await mkdir(path, { recursive: true, mode: 0o700 });
			const stats = await lstat(path);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new EvolutionStorageCorruptionError(path, "expected a direct directory");
			}
		}
	}

	async #withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
		await this.#ensureDirectories();
		let compromised: Error | null = null;
		const release = await lockfile.lock(this.#storeLockPath, {
			lockfilePath: `${this.#storeLockPath}.lock`,
			realpath: false,
			retries: { retries: 200, factor: 1, minTimeout: 5, maxTimeout: 25, randomize: true },
			stale: this.#storeLockStaleMs,
			update: this.#storeLockUpdateMs,
			onCompromised(error) {
				compromised = error;
			},
		});
		let result!: T;
		let operationFailed = false;
		let operationError: unknown;
		try {
			result = await operation();
		} catch (error) {
			operationFailed = true;
			operationError = error;
		}
		let releaseError: unknown;
		try {
			await release();
		} catch (error) {
			if (!hasErrorCode(error, "ERELEASED")) releaseError = error;
		}
		if (operationFailed) throw operationError;
		if (compromised !== null) throw compromised;
		if (releaseError !== undefined) throw releaseError;
		return result;
	}

	async #readOptional(path: string): Promise<string | null> {
		try {
			const stats = await lstat(path);
			assertDirectFile(path, stats);
			return await readFile(path, "utf8");
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		}
	}

	async #atomicReplace(path: string, value: unknown): Promise<void> {
		const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporaryPath, `${serializeEvolutionValue(value)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporaryPath, path);
		} catch (error) {
			try {
				await unlink(temporaryPath);
			} catch (cleanupError) {
				if (!hasErrorCode(cleanupError, "ENOENT")) throw cleanupError;
			}
			throw error;
		}
	}

	#scopeFileName(scope: EvolutionScope): string {
		return artifactDirectoryName(computeEvolutionContentDigest(scope));
	}

	#skillCandidateScopePath(scope: EvolutionScope): string {
		return join(this.#skillCandidateRegistryPath, this.#scopeFileName(scope));
	}

	async #readSkillCandidateRegistryEvents(scope: EvolutionScope): Promise<SkillCandidateRegistryEvent[]> {
		const scopePath = this.#skillCandidateScopePath(scope);
		let entries: Dirent[];
		try {
			entries = await readdir(scopePath, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return [];
			throw error;
		}
		const events: SkillCandidateRegistryEvent[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
			const path = join(scopePath, entry.name, "event.json");
			const contents = await this.#readOptional(path);
			if (contents === null) {
				throw new EvolutionStorageCorruptionError(path, "skill candidate registry event is missing");
			}
			const event = parseSkillCandidateRegistryEvent(contents, path, true);
			if (event.eventId !== entry.name) {
				throw new EvolutionStorageCorruptionError(
					path,
					"skill candidate registry event ID does not match its path",
				);
			}
			if (!scopeMatches(event.metadata.scope, scope)) {
				throw new EvolutionStorageCorruptionError(path, "skill candidate registry scope does not match its path");
			}
			events.push(event);
		}
		events.sort(
			(left, right) => left.registrySequence - right.registrySequence || left.eventId.localeCompare(right.eventId),
		);
		for (let index = 0; index < events.length; index += 1) {
			if (events[index]?.registrySequence !== index + 1) {
				throw new EvolutionStorageCorruptionError(scopePath, "skill candidate registry sequence is not contiguous");
			}
		}
		return events;
	}

	#skillLifecycleScopePath(scope: EvolutionScope): string {
		return join(this.#skillLifecycleObservationPath, this.#scopeFileName(scope));
	}

	async #readSkillLifecycleObservations(scope: EvolutionScope): Promise<SkillLifecycleObservation[]> {
		const scopePath = this.#skillLifecycleScopePath(scope);
		let entries: Dirent[];
		try {
			entries = await readdir(scopePath, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return [];
			throw error;
		}
		const observations: SkillLifecycleObservation[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
			const path = join(scopePath, entry.name, "observation.json");
			const contents = await this.#readOptional(path);
			if (contents === null) {
				throw new EvolutionStorageCorruptionError(path, "skill lifecycle observation is missing");
			}
			const observation = parseSkillLifecycleObservation(contents, path);
			if (observation.observationId !== entry.name) {
				throw new EvolutionStorageCorruptionError(path, "skill lifecycle observation ID does not match its path");
			}
			if (!scopeMatches(observation.scope, scope)) {
				throw new EvolutionStorageCorruptionError(
					path,
					"skill lifecycle observation scope does not match its path",
				);
			}
			observations.push(observation);
		}
		return observations.sort(
			(left, right) =>
				left.timestamp.localeCompare(right.timestamp) || left.observationId.localeCompare(right.observationId),
		);
	}

	#leaseFile(kind: EvolutionLeaseToken["kind"], key: string): string {
		const digest = artifactDirectoryName(computeEvolutionContentDigest({ kind, key }));
		return join(this.#leasePath, `${kind}-${digest}.json`);
	}

	async #loadLease(kind: EvolutionLeaseToken["kind"], key: string): Promise<StoredLease | null> {
		const path = this.#leaseFile(kind, key);
		const contents = await this.#readOptional(path);
		return contents === null ? null : parseLease(contents, path);
	}

	async #assertLeaseHeld(lease: EvolutionLeaseToken): Promise<void> {
		const stored = await this.#loadLease(lease.kind, lease.key);
		if (
			stored === null ||
			stored.ownerId !== lease.ownerId ||
			stored.fence !== lease.fence ||
			stored.releasedAt !== null ||
			parseIsoTimestamp(stored.expiresAt, "lease expiry") <= Date.now()
		) {
			throw new Error(`Evolution ${lease.kind} lease was lost`);
		}
	}

	assertHeld(lease: EvolutionLeaseToken): Promise<void> {
		return this.#withStoreLock(() => this.#assertLeaseHeld(lease));
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		await this.#ensureDirectories();
		const content = serializeEvolutionValue(artifact);
		parseArtifact(content, join(this.#artifactPath, artifact.metadata.artifactId));
		const contentDigest = computeEvolutionContentDigest(artifact);
		const destination = join(this.#artifactPath, artifactDirectoryName(contentDigest));
		const artifactPath = join(destination, ARTIFACT_FILE_NAME);
		try {
			const existing = await this.#readOptional(artifactPath);
			if (existing !== null) {
				if (existing.trimEnd() !== content) {
					throw new EvolutionStorageCorruptionError(artifactPath, "immutable artifact content changed");
				}
				return { artifactId: artifact.metadata.artifactId, contentDigest };
			}
		} catch (error) {
			if (!(error instanceof EvolutionStorageCorruptionError) || !hasErrorCode(error.cause, "ENOENT")) throw error;
		}

		let temporaryDirectory: string | null = await mkdtemp(join(this.#artifactPath, ".artifact.tmp-"));
		try {
			await writeFile(join(temporaryDirectory, ARTIFACT_FILE_NAME), `${content}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			try {
				await rename(temporaryDirectory, destination);
				temporaryDirectory = null;
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
				const existing = await this.#readOptional(artifactPath);
				if (existing === null || existing.trimEnd() !== content) {
					throw new EvolutionStorageCorruptionError(
						artifactPath,
						"immutable artifact race produced different content",
					);
				}
			}
		} finally {
			if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
		}
		return { artifactId: artifact.metadata.artifactId, contentDigest };
	}

	async get(reference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		assertSafeId(reference.artifactId, "artifact ID");
		const path = join(this.#artifactPath, artifactDirectoryName(reference.contentDigest), ARTIFACT_FILE_NAME);
		const contents = await this.#readOptional(path);
		if (contents === null) throw new EvolutionStorageCorruptionError(path, "referenced artifact is missing");
		const artifact = parseArtifact(contents, path);
		const actualDigest = computeEvolutionContentDigest(artifact);
		if (actualDigest !== reference.contentDigest) {
			throw new EvolutionStorageCorruptionError(path, "content digest does not match its reference");
		}
		if (artifact.metadata.artifactId !== reference.artifactId) {
			throw new EvolutionStorageCorruptionError(path, "artifact ID does not match its reference");
		}
		return artifact;
	}

	async requestCancellation(jobId: string, requestedAt: string): Promise<EvolutionCancellationRequest> {
		assertSafeId(jobId, "job ID");
		parseIsoTimestamp(requestedAt, "cancellation request time");
		return this.#withStoreLock(async () => {
			const path = join(this.#cancellationPath, `${jobId}.json`);
			const existing = await this.#readOptional(path);
			if (existing !== null) return parseCancellation(existing, path, jobId);
			const request: EvolutionCancellationRequest = { jobId, requestedAt };
			try {
				await writeFile(path, `${serializeEvolutionValue(request)}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
				return request;
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
				const raced = await this.#readOptional(path);
				if (raced === null) throw error;
				return parseCancellation(raced, path, jobId);
			}
		});
	}

	async loadCancellation(jobId: string): Promise<EvolutionCancellationRequest | null> {
		assertSafeId(jobId, "job ID");
		const path = join(this.#cancellationPath, `${jobId}.json`);
		const contents = await this.#readOptional(path);
		return contents === null ? null : parseCancellation(contents, path, jobId);
	}

	async create(job: EvolutionJob, lease: EvolutionLeaseToken): Promise<void> {
		assertSafeId(job.jobId, "job ID");
		await this.#withStoreLock(async () => {
			await this.#assertLeaseHeld(lease);
			const path = join(this.#jobPath, `${job.jobId}.json`);
			parseJob(serializeEvolutionValue(job), path);
			try {
				await writeFile(path, `${serializeEvolutionValue(job)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
				const existing = await this.#readOptional(path);
				if (existing === null || existing.trimEnd() !== serializeEvolutionValue(job)) {
					throw new Error(`Evolution job "${job.jobId}" already exists with different content`);
				}
			}
		});
	}

	async save(job: EvolutionJob, expectedRevision: number, lease: EvolutionLeaseToken): Promise<void> {
		assertSafeId(job.jobId, "job ID");
		await this.#withStoreLock(async () => {
			await this.#assertLeaseHeld(lease);
			const path = join(this.#jobPath, `${job.jobId}.json`);
			parseJob(serializeEvolutionValue(job), path);
			const contents = await this.#readOptional(path);
			if (contents === null) throw new Error(`Unknown evolution job "${job.jobId}"`);
			const current = parseJob(contents, path);
			if (current.revision !== expectedRevision) {
				throw new Error(
					`Evolution job "${job.jobId}" revision conflict: expected ${expectedRevision}, found ${current.revision}`,
				);
			}
			if (job.revision !== expectedRevision + 1) {
				throw new Error(`Evolution job "${job.jobId}" must advance exactly one revision`);
			}
			await this.#atomicReplace(path, job);
		});
	}

	async list(scope?: EvolutionScope): Promise<readonly EvolutionJob[]> {
		await this.#ensureDirectories();
		const jobs: EvolutionJob[] = [];
		for (const entry of await readdir(this.#jobPath, { withFileTypes: true })) {
			if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
			const path = join(this.#jobPath, entry.name);
			const job = parseJob(await readFile(path, "utf8"), path);
			if (scope === undefined || scopeMatches(job.metadata.scope, scope)) jobs.push(job);
		}
		return jobs.sort(
			(left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId),
		);
	}

	async load(scope: EvolutionScope): Promise<EvolutionProcessedEvidenceCursor>;
	async load(jobId: string): Promise<EvolutionJob | null>;
	async load(value: EvolutionScope | string): Promise<EvolutionProcessedEvidenceCursor | EvolutionJob | null> {
		if (typeof value === "string") {
			assertSafeId(value, "job ID");
			const path = join(this.#jobPath, `${value}.json`);
			const contents = await this.#readOptional(path);
			return contents === null ? null : parseJob(contents, path);
		}
		const path = join(this.#cursorPath, `${this.#scopeFileName(value)}.json`);
		const contents = await this.#readOptional(path);
		if (contents === null) {
			return {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				scope: value,
				sequence: 0,
				committedByJobId: null,
				updatedAt: new Date(0).toISOString(),
			};
		}
		const cursor = parseCursor(contents, path);
		if (!scopeMatches(cursor.scope, value)) {
			throw new EvolutionStorageCorruptionError(path, "cursor scope does not match its path");
		}
		return cursor;
	}

	async commit(
		scope: EvolutionScope,
		expectedSequence: number,
		nextSequence: number,
		jobId: string,
		updatedAt: string,
		lease: EvolutionLeaseToken,
	): Promise<EvolutionCursorCommitResult> {
		if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) throw new Error("Invalid expected cursor");
		if (!Number.isSafeInteger(nextSequence) || nextSequence < expectedSequence)
			throw new Error("Invalid next cursor");
		assertSafeId(jobId, "job ID");
		return this.#withStoreLock(async () => {
			await this.#assertLeaseHeld(lease);
			const current = await this.load(scope);
			if (current.sequence === nextSequence && current.committedByJobId === jobId) return "already-committed";
			if (current.sequence !== expectedSequence) return "conflict";
			const next: EvolutionProcessedEvidenceCursor = {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				scope,
				sequence: nextSequence,
				committedByJobId: jobId,
				updatedAt,
			};
			await this.#atomicReplace(join(this.#cursorPath, `${this.#scopeFileName(scope)}.json`), next);
			return "committed";
		});
	}

	async acquire(
		kind: EvolutionLeaseToken["kind"],
		key: string,
		ownerId: string,
		now: string,
		ttlMs: number,
	): Promise<EvolutionLeaseToken | null> {
		if (key === "" || ownerId === "") throw new Error("Evolution lease key and owner must be non-empty");
		if (!Number.isFinite(ttlMs) || ttlMs < 2_000) throw new Error("Evolution lease ttlMs must be at least 2000");
		const nowMs = parseIsoTimestamp(now, "lease acquisition time");
		return this.#withStoreLock(async () => {
			const current = await this.#loadLease(kind, key);
			if (
				current !== null &&
				current.releasedAt === null &&
				parseIsoTimestamp(current.expiresAt, "lease expiry") > nowMs
			) {
				return null;
			}
			const stored: StoredLease = {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				kind,
				key,
				ownerId,
				fence: (current?.fence ?? 0) + 1,
				expiresAt: new Date(nowMs + ttlMs).toISOString(),
				releasedAt: null,
			};
			await this.#atomicReplace(this.#leaseFile(kind, key), stored);
			return stored;
		});
	}

	async renew(lease: EvolutionLeaseToken, now: string, ttlMs: number): Promise<EvolutionLeaseToken | null> {
		if (!Number.isFinite(ttlMs) || ttlMs < 2_000) throw new Error("Evolution lease ttlMs must be at least 2000");
		const nowMs = parseIsoTimestamp(now, "lease renewal time");
		return this.#withStoreLock(async () => {
			const current = await this.#loadLease(lease.kind, lease.key);
			if (
				current === null ||
				current.ownerId !== lease.ownerId ||
				current.fence !== lease.fence ||
				current.releasedAt !== null ||
				parseIsoTimestamp(current.expiresAt, "lease expiry") <= nowMs
			) {
				return null;
			}
			const renewed: StoredLease = { ...current, expiresAt: new Date(nowMs + ttlMs).toISOString() };
			await this.#atomicReplace(this.#leaseFile(lease.kind, lease.key), renewed);
			return renewed;
		});
	}

	async release(lease: EvolutionLeaseToken): Promise<void> {
		await this.#withStoreLock(async () => {
			const current = await this.#loadLease(lease.kind, lease.key);
			if (current === null || current.ownerId !== lease.ownerId || current.fence !== lease.fence) return;
			await this.#atomicReplace(this.#leaseFile(lease.kind, lease.key), {
				...current,
				expiresAt: new Date(0).toISOString(),
				releasedAt: new Date().toISOString(),
			} satisfies StoredLease);
		});
	}

	async #loadLessonScoreLedger(scope: EvolutionScope): Promise<LessonScoreLedger> {
		await this.#ensureDirectories();
		const path = join(this.#lessonScorePath, `${this.#scopeFileName(scope)}.json`);
		const contents = await this.#readOptional(path);
		return contents === null
			? {
					schemaVersion: LESSON_SCORE_SCHEMA_VERSION,
					scope,
					revision: 0,
					catalogs: [],
					rows: [],
					appliedOutputIds: [],
				}
			: parseLessonScoreLedger(contents, path, scope);
	}

	async #saveLessonScoreLedger(ledger: LessonScoreLedger): Promise<void> {
		const path = join(this.#lessonScorePath, `${this.#scopeFileName(ledger.scope)}.json`);
		parseLessonScoreLedger(serializeEvolutionValue(ledger), path, ledger.scope);
		await this.#atomicReplace(path, ledger);
	}

	async registerLessonScoreRevision(
		...args: Parameters<LessonScoreStore["registerLessonScoreRevision"]>
	): Promise<void> {
		const [scope, snapshot] = args;
		const catalog = {
			harnessRevision: snapshot.harnessVersion,
			items: snapshot.activeMemoryItems.map((item) => {
				if (item.supersessionRevision !== null) throw new Error("Cannot score superseded memory items");
				return {
					memoryItemId: item.memoryItemId,
					contentDigest: item.contentDigest,
					creationRevision: item.creationRevision,
				};
			}),
		};
		await this.#withStoreLock(async () => {
			const ledger = await this.#loadLessonScoreLedger(scope);
			const prior = ledger.catalogs.find((item) => item.harnessRevision === catalog.harnessRevision);
			if (prior !== undefined) {
				if (serializeEvolutionValue(prior) !== serializeEvolutionValue(catalog)) {
					throw new Error("Lesson score revision was registered with different active memory items");
				}
				return;
			}
			await this.#saveLessonScoreLedger({
				...ledger,
				revision: ledger.revision + 1,
				catalogs: [...ledger.catalogs, catalog],
			});
		});
	}

	async loadLessonScores(
		...args: Parameters<LessonScoreStore["loadLessonScores"]>
	): ReturnType<LessonScoreStore["loadLessonScores"]> {
		const [scope, harnessRevision] = args;
		const ledger = await this.#loadLessonScoreLedger(scope);
		const catalog = ledger.catalogs.find((item) => item.harnessRevision === harnessRevision);
		if (catalog === undefined) throw new Error(`Unregistered lesson score revision "${harnessRevision}"`);
		const rows = new Map(ledger.rows.map((row) => [row.memoryItemId, row]));
		return {
			revision: ledger.revision,
			scope,
			harnessRevision,
			scores: catalog.items.map((item) => {
				const row = rows.get(item.memoryItemId);
				return {
					...item,
					points: row?.points ?? 0,
					lastAppliedOutputIdempotencyKey: row?.lastAppliedOutputIdempotencyKey ?? null,
				};
			}),
		};
	}

	async applyLessonScoreReport(
		...args: Parameters<LessonScoreStore["applyLessonScoreReport"]>
	): ReturnType<LessonScoreStore["applyLessonScoreReport"]> {
		const [scope, report, currentHarnessRevision] = args;
		return this.#withStoreLock(async () => {
			const ledger = await this.#loadLessonScoreLedger(scope);
			const bound = ledger.catalogs.find((catalog) => catalog.harnessRevision === report.harnessRevision);
			const current = ledger.catalogs.find((catalog) => catalog.harnessRevision === currentHarnessRevision);
			if (!bound || !current) throw new Error("Unregistered lesson score revision");
			if (typeof report.outputId !== "string" || report.outputId.length === 0 || !Array.isArray(report.judgments)) {
				throw new Error("Invalid lesson score report");
			}
			const judgments = new Map<string, "helpful" | "harmful">();
			for (const judgment of report.judgments) {
				if (!isRecord(judgment)) throw new Error("Invalid lesson score judgment");
				const { item: reference, signal } = judgment;
				if (
					!isLessonScoreIdentity(reference) ||
					(signal !== "helpful" && signal !== "harmful") ||
					judgments.has(reference.memoryItemId) ||
					!bound.items.some(
						(item) =>
							item.memoryItemId === reference.memoryItemId &&
							item.contentDigest === reference.contentDigest &&
							item.creationRevision === reference.creationRevision,
					)
				) {
					throw new Error("Invalid lesson score judgment");
				}
				judgments.set(reference.memoryItemId, signal);
			}
			if (ledger.appliedOutputIds.includes(report.outputId)) return "already-applied";
			const rows = new Map(ledger.rows.map((row) => [row.memoryItemId, row]));
			const survivors = new Map(current.items.map((item) => [item.memoryItemId, item]));
			for (const boundItem of bound.items) {
				const item = survivors.get(boundItem.memoryItemId);
				if (!item || item.creationRevision !== boundItem.creationRevision) continue;
				// Renumbering changes the digest, not identity. REPLACE always mints a new identity.
				const signal = judgments.get(item.memoryItemId);
				rows.set(item.memoryItemId, {
					...item,
					harnessRevision: currentHarnessRevision,
					points:
						(rows.get(item.memoryItemId)?.points ?? 0) +
						(signal === "helpful" ? 1 : signal === "harmful" ? -1.5 : -1),
					lastAppliedOutputIdempotencyKey: report.outputId,
				});
			}
			await this.#saveLessonScoreLedger({
				...ledger,
				revision: ledger.revision + 1,
				rows: [...rows.values()],
				appliedOutputIds: [...ledger.appliedOutputIds, report.outputId],
			});
			return "committed";
		});
	}

	async saveLessonScores(
		...args: Parameters<LessonScoreStore["saveLessonScores"]>
	): ReturnType<LessonScoreStore["saveLessonScores"]> {
		const [scope, expectedRevision, rows] = args;
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			throw new Error("Invalid lesson score ledger revision");
		}
		if (new Set(rows.map((row) => row.memoryItemId)).size !== rows.length) {
			throw new Error("Duplicate lesson score rows");
		}
		return this.#withStoreLock(async () => {
			const ledger = await this.#loadLessonScoreLedger(scope);
			if (ledger.revision !== expectedRevision) return "conflict";
			if (rows.length === 0) return "committed";
			const updated = new Map(ledger.rows.map((row) => [row.memoryItemId, row]));
			for (const row of rows) updated.set(row.memoryItemId, row);
			await this.#saveLessonScoreLedger({ ...ledger, revision: ledger.revision + 1, rows: [...updated.values()] });
			return "committed";
		});
	}

	async loadSkillCandidateRegistry(scope: EvolutionScope): Promise<SkillCandidateRegistrySnapshot> {
		await this.#ensureDirectories();
		const events = await this.#readSkillCandidateRegistryEvents(scope);
		return { revision: events.length, events };
	}

	async appendSkillCandidateRegistryEvents(
		scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
		lease?: EvolutionLeaseToken,
	): Promise<SkillCandidateRegistryAppendResult> {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
			throw new Error("Invalid skill candidate registry revision");
		}
		if (events.length === 0) return "committed";
		return this.#withStoreLock(async () => {
			if (lease !== undefined) await this.#assertLeaseHeld(lease);
			const existing = await this.#readSkillCandidateRegistryEvents(scope);
			if (existing.length !== expectedRevision) return "conflict";
			const scopePath = this.#skillCandidateScopePath(scope);
			await mkdir(scopePath, { recursive: true, mode: 0o700 });
			const stats = await lstat(scopePath);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new EvolutionStorageCorruptionError(scopePath, "expected a direct directory");
			}
			for (let index = 0; index < events.length; index += 1) {
				const event = events[index];
				if (event === undefined || event.registrySequence !== expectedRevision + index + 1) {
					throw new Error("Skill candidate registry events must advance a contiguous sequence");
				}
				if (!scopeMatches(event.metadata.scope, scope)) {
					throw new Error("Skill candidate registry event scope does not match the registry");
				}
				assertSafeId(event.eventId, "skill candidate registry event ID");
				const destination = join(scopePath, event.eventId);
				const eventPath = join(destination, "event.json");
				const content = serializeEvolutionValue(event);
				parseSkillCandidateRegistryEvent(content, eventPath);
				const alreadyStored = await this.#readOptional(eventPath);
				if (alreadyStored !== null) {
					if (alreadyStored.trimEnd() !== content) {
						throw new EvolutionStorageCorruptionError(
							eventPath,
							"skill candidate registry event ID was reused with different content",
						);
					}
					continue;
				}
				let temporaryDirectory: string | null = await mkdtemp(join(scopePath, ".event.tmp-"));
				try {
					await writeFile(join(temporaryDirectory, "event.json"), `${content}\n`, {
						encoding: "utf8",
						flag: "wx",
						mode: 0o600,
					});
					await rename(temporaryDirectory, destination);
					temporaryDirectory = null;
				} finally {
					if (temporaryDirectory !== null) {
						await rm(temporaryDirectory, { recursive: true, force: true });
					}
				}
			}
			return "committed";
		});
	}

	async listSkillLifecycleObservations(scope: EvolutionScope): Promise<readonly SkillLifecycleObservation[]> {
		await this.#ensureDirectories();
		return this.#readSkillLifecycleObservations(scope);
	}

	async appendSkillLifecycleObservation(
		observation: SkillLifecycleObservation,
	): Promise<SkillLifecycleObservationAppendResult> {
		assertSafeId(observation.observationId, "skill lifecycle observation ID");
		const content = serializeEvolutionValue(observation);
		parseSkillLifecycleObservation(content, observation.observationId);
		return this.#withStoreLock(async () => {
			const existing = await this.#readSkillLifecycleObservations(observation.scope);
			const prior = existing.find(
				(item) =>
					item.observationId === observation.observationId || item.idempotencyKey === observation.idempotencyKey,
			);
			if (prior !== undefined) {
				if (serializeEvolutionValue(prior) !== content) {
					throw new Error("Skill lifecycle observation identity was reused with different content");
				}
				return "already-recorded";
			}
			if (
				observation.status === "final" &&
				existing.some(
					(item) =>
						item.status === "final" &&
						item.skill.skillId === observation.skill.skillId &&
						item.skill.version === observation.skill.version &&
						item.skill.workspace.repositoryId === observation.skill.workspace.repositoryId &&
						item.skill.workspace.directoryId === observation.skill.workspace.directoryId &&
						item.topLevelTaskLineageId === observation.topLevelTaskLineageId,
				)
			) {
				throw new Error(
					"A final skill lifecycle observation already exists for this skill version and task lineage",
				);
			}
			const scopePath = this.#skillLifecycleScopePath(observation.scope);
			await mkdir(scopePath, { recursive: true, mode: 0o700 });
			const stats = await lstat(scopePath);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new EvolutionStorageCorruptionError(scopePath, "expected a direct directory");
			}
			const destination = join(scopePath, observation.observationId);
			let temporaryDirectory: string | null = await mkdtemp(join(scopePath, ".observation.tmp-"));
			try {
				await writeFile(join(temporaryDirectory, "observation.json"), `${content}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
				await rename(temporaryDirectory, destination);
				temporaryDirectory = null;
			} finally {
				if (temporaryDirectory !== null) {
					await rm(temporaryDirectory, { recursive: true, force: true });
				}
			}
			return "committed";
		});
	}

	async append(event: EvolutionLedgerEvent): Promise<void> {
		assertSafeId(event.jobId, "job ID");
		assertSafeId(event.eventId, "ledger event ID");
		await this.#ensureDirectories();
		const jobLedgerPath = join(this.#ledgerPath, event.jobId);
		await mkdir(jobLedgerPath, { recursive: true, mode: 0o700 });
		const destination = join(jobLedgerPath, event.eventId);
		const eventPath = join(destination, "event.json");
		const content = serializeEvolutionValue(event);
		parseLedgerEvent(content, eventPath);
		const existing = await this.#readOptional(eventPath);
		if (existing !== null) {
			if (existing.trimEnd() !== content) {
				throw new EvolutionStorageCorruptionError(eventPath, "ledger event ID was reused with different content");
			}
			return;
		}
		let temporaryDirectory: string | null = await mkdtemp(join(jobLedgerPath, ".event.tmp-"));
		try {
			await writeFile(join(temporaryDirectory, "event.json"), `${content}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			try {
				await rename(temporaryDirectory, destination);
				temporaryDirectory = null;
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) throw error;
				const raced = await this.#readOptional(eventPath);
				if (raced === null || raced.trimEnd() !== content) {
					throw new EvolutionStorageCorruptionError(eventPath, "ledger append race produced different content");
				}
			}
		} finally {
			if (temporaryDirectory !== null) await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	async read(jobId: string): Promise<readonly EvolutionLedgerEvent[]> {
		assertSafeId(jobId, "job ID");
		const jobLedgerPath = join(this.#ledgerPath, jobId);
		let entries: Dirent[];
		try {
			entries = await readdir(jobLedgerPath, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return [];
			throw error;
		}
		const events: EvolutionLedgerEvent[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
			const path = join(jobLedgerPath, entry.name, "event.json");
			const contents = await this.#readOptional(path);
			if (contents === null) throw new EvolutionStorageCorruptionError(path, "ledger event is missing");
			events.push(parseLedgerEvent(contents, path));
		}
		return events.sort(
			(left, right) =>
				left.metadata.createdAt.localeCompare(right.metadata.createdAt) ||
				left.eventId.localeCompare(right.eventId),
		);
	}
}
