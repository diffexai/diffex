import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import type {
	MaterializationIntegrity,
	MaterializedInvocation,
	MaterializedTerminationStatus,
} from "@earendil-works/diffex-harness-trace";

export const EVOLUTION_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export interface EvolutionScope {
	readonly repositoryId: string;
	readonly scopeId: string;
}

export interface EvolutionModelIdentity {
	readonly provider: string;
	readonly model: string;
	readonly configurationDigest: string;
}

export interface EvolutionArtifactProducer {
	readonly name: string;
	readonly version: string;
	readonly promptVersion: string | null;
	readonly model: EvolutionModelIdentity | null;
}

export interface EvolutionArtifactMetadata {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly artifactId: string;
	readonly producer: EvolutionArtifactProducer;
	readonly sourceIds: readonly string[];
	readonly contentDigest: string;
	readonly scope: EvolutionScope;
	readonly createdAt: string;
}

export interface ImmutableHarnessSnapshot {
	readonly harnessVersion: HarnessVersion;
	readonly baseVersion: HarnessVersion | null;
	readonly memory: string;
	readonly memoryContentDigest: string;
}

export type EvolutionEvidenceOrigin = "product-runtime" | "evolution-pipeline";

export interface EvolutionEvidenceSource {
	readonly sourceId: string;
	readonly origin: EvolutionEvidenceOrigin;
	readonly contentDigest: string;
	readonly invocation: MaterializedInvocation;
}

export interface EvolutionInputSnapshot {
	readonly metadata: EvolutionArtifactMetadata;
	readonly harness: ImmutableHarnessSnapshot;
	readonly evidenceSources: readonly EvolutionEvidenceSource[];
}

export interface EvidenceCorpusDocument {
	readonly documentId: string;
	readonly sourceId: string;
	readonly contentDigest: string;
	readonly materializedInvocationVersion: number;
	readonly traceId: string | null;
	readonly integrity: MaterializationIntegrity;
	readonly terminationStatus: MaterializedTerminationStatus;
	readonly evidenceIds: readonly string[];
}

export interface ExcludedEvidenceSource {
	readonly sourceId: string;
	readonly reason: "evolution-pipeline-origin";
}

export interface EvidenceCorpusManifest {
	readonly metadata: EvolutionArtifactMetadata;
	readonly documents: readonly EvidenceCorpusDocument[];
	readonly excludedSources: readonly ExcludedEvidenceSource[];
}

export interface InstructionDocumentSnapshot {
	readonly path: string;
	readonly precedence: number;
	readonly content: string;
	readonly contentDigest: string;
}

export interface InstructionSnapshot {
	readonly metadata: EvolutionArtifactMetadata;
	readonly documents: readonly InstructionDocumentSnapshot[];
}

export type ReflectionNodeStatus = "pending" | "complete" | "failed";

export interface ReflectionNode {
	readonly metadata: EvolutionArtifactMetadata;
	readonly nodeId: string;
	readonly parentNodeId: string | null;
	readonly childNodeIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly lessonIds: readonly string[];
	readonly status: ReflectionNodeStatus;
}

export type LessonKind = "constraint" | "failure" | "instruction" | "strategy" | "unresolved";

export interface Lesson {
	readonly metadata: EvolutionArtifactMetadata;
	readonly lessonId: string;
	readonly kind: LessonKind;
	readonly summary: string;
	readonly evidenceIds: readonly string[];
	readonly counterevidenceIds: readonly string[];
	readonly scope: EvolutionScope;
	readonly uncertainty: string | null;
}

export interface EvolutionMemoryTarget {
	readonly kind: "evolution-memory";
	readonly expectedHarnessVersion: HarnessVersion;
}

export interface SkillTarget {
	readonly kind: "skill";
	readonly skillName: string;
}

export interface OrchestrationSourceTarget {
	readonly kind: "orchestration-source";
	readonly sourcePath: string;
}

export type EvolutionTarget = EvolutionMemoryTarget | SkillTarget | OrchestrationSourceTarget;

interface EvolutionProposalBase {
	readonly metadata: EvolutionArtifactMetadata;
	readonly proposalId: string;
	readonly summary: string;
	readonly lessonIds: readonly string[];
	readonly evidenceIds: readonly string[];
}

export interface EvolutionMemoryProposal extends EvolutionProposalBase {
	readonly disposition: "actionable";
	readonly target: EvolutionMemoryTarget;
	readonly executablePayload: JsonObject;
}

export interface DeferredEvolutionProposal extends EvolutionProposalBase {
	readonly disposition: "deferred";
	readonly target: SkillTarget | OrchestrationSourceTarget;
	readonly finding: string;
}

export type EvolutionProposal = EvolutionMemoryProposal | DeferredEvolutionProposal;

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
	readonly code: string;
	readonly message: string;
	readonly severity: ValidationSeverity;
	readonly proposalId?: string;
}

export interface ProposalValidationResult {
	readonly proposalId: string;
	readonly disposition: "accepted" | "deferred" | "rejected";
	readonly issues: readonly ValidationIssue[];
}

export interface ValidationReport {
	readonly metadata: EvolutionArtifactMetadata;
	readonly proposalResults: readonly ProposalValidationResult[];
}

export type ScoredProposalDisposition = "deferred" | "rejected" | "selected" | "superseded";

export interface ScoredProposal {
	readonly metadata: EvolutionArtifactMetadata;
	readonly proposal: EvolutionProposal;
	readonly score: number | null;
	readonly disposition: ScoredProposalDisposition;
	readonly reasonCodes: readonly string[];
}

export interface EvolutionMutation {
	readonly mutationId: string;
	readonly proposalId: string;
	readonly target: EvolutionMemoryTarget;
	readonly payload: JsonObject;
}

export interface MutationBatch {
	readonly metadata: EvolutionArtifactMetadata;
	readonly batchId: string;
	readonly targetKind: "evolution-memory";
	readonly mutations: readonly EvolutionMutation[];
}

export interface MutationWriteResult {
	readonly batchId: string;
	readonly status: "applied" | "failed";
	readonly resultingHarnessVersion: HarnessVersion | null;
	readonly message: string | null;
}

export interface CreatedCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "created";
}

export interface CorpusCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "corpus-prepared";
	readonly corpusManifestId: string;
	readonly instructionSnapshotId: string;
}

export interface ReflectedCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "reflected";
	readonly reflectionNodeIds: readonly string[];
	readonly lessonIds: readonly string[];
}

export interface CuratedCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "curated";
	readonly proposalIds: readonly string[];
}

export interface ValidatedCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "validated";
	readonly validationReportId: string;
}

export interface ScoredCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "scored";
	readonly scoredProposalIds: readonly string[];
}

export interface WrittenCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "written";
	readonly mutationBatchId: string | null;
	readonly writeResult: MutationWriteResult | null;
}

export interface CompletedCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "completed";
	readonly resultingHarnessVersion: HarnessVersion | null;
}

export type ActiveEvolutionStage =
	| "created"
	| "corpus-prepared"
	| "reflected"
	| "curated"
	| "validated"
	| "scored"
	| "written";

export interface FailedCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: "failed";
	readonly failedStage: ActiveEvolutionStage;
	readonly message: string;
}

export type EvolutionCheckpoint =
	| CreatedCheckpoint
	| CorpusCheckpoint
	| ReflectedCheckpoint
	| CuratedCheckpoint
	| ValidatedCheckpoint
	| ScoredCheckpoint
	| WrittenCheckpoint
	| CompletedCheckpoint
	| FailedCheckpoint;

export interface EvolutionJob {
	readonly metadata: EvolutionArtifactMetadata;
	readonly jobId: string;
	readonly inputSnapshotId: string;
	readonly status: "completed" | "failed" | "running";
	readonly checkpoint: EvolutionCheckpoint;
	readonly updatedAt: string;
}

export type EvolutionProposalLedgerDisposition =
	| "applied"
	| "deferred"
	| "failed"
	| "rejected"
	| "rolled-back"
	| "superseded";

interface EvolutionLedgerEventBase {
	readonly metadata: EvolutionArtifactMetadata;
	readonly eventId: string;
	readonly jobId: string;
}

export interface JobCreatedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "job-created";
	readonly inputSnapshotId: string;
}

export interface CheckpointSavedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "checkpoint-saved";
	readonly checkpoint: EvolutionCheckpoint;
}

export interface ProposalDispositionLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "proposal-disposition";
	readonly proposalId: string;
	readonly disposition: EvolutionProposalLedgerDisposition;
	readonly reasonCodes: readonly string[];
}

export interface MutationWrittenLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "mutation-written";
	readonly batchId: string;
	readonly writeResult: MutationWriteResult;
}

export interface JobCompletedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "job-completed";
	readonly resultingHarnessVersion: HarnessVersion | null;
}

export interface JobFailedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "job-failed";
	readonly failedStage: FailedCheckpoint["failedStage"];
	readonly message: string;
}

export interface ProposalRolledBackLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "proposal-rolled-back";
	readonly proposalId: string;
	readonly fromHarnessVersion: HarnessVersion;
	readonly toHarnessVersion: HarnessVersion;
}

export type EvolutionLedgerEvent =
	| JobCreatedLedgerEvent
	| CheckpointSavedLedgerEvent
	| ProposalDispositionLedgerEvent
	| MutationWrittenLedgerEvent
	| JobCompletedLedgerEvent
	| JobFailedLedgerEvent
	| ProposalRolledBackLedgerEvent;
