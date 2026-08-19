import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import type {
	MaterializationIntegrity,
	MaterializedInvocation,
	MaterializedTerminationStatus,
} from "@earendil-works/diffex-harness-trace";

export const EVOLUTION_SCHEMA_VERSION = 1 as const;
export const EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION = 1 as const;
export const COUNTER_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const COUNTER_REPORT_SCHEMA_VERSION = 1 as const;

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

export interface EvolutionMemoryItemLedgerMetadata {
	readonly origin: "evolution" | "manual";
	readonly creationEventId: string | null;
	readonly supersessionEventId: string | null;
}

export interface EvolutionMemoryItem {
	readonly schemaVersion: typeof EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION;
	readonly memoryItemId: string;
	readonly contentDigest: string;
	readonly creationRevision: HarnessVersion;
	readonly supersessionRevision: HarnessVersion | null;
	readonly ledger: EvolutionMemoryItemLedgerMetadata;
}

export type CounterSignal = "helpful" | "harmful" | "neutral" | "unknown";

export type CounterSignalSource = "direct-user" | "environment" | "model-self-assessment" | "replay" | "test" | "tool";

export type CounterAttributionMethod = "co-occurrence" | "deterministic" | "direct" | "inferred" | "self-assessed";

export type CounterObservationStatus = "candidate" | "final";

export interface CounterObservation {
	readonly schemaVersion: typeof COUNTER_OBSERVATION_SCHEMA_VERSION;
	readonly observationId: string;
	readonly memoryItemId: string;
	readonly harnessRevision: HarnessVersion;
	readonly topLevelTaskLineageId: string;
	readonly traceIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly signal: CounterSignal;
	readonly signalSource: CounterSignalSource;
	readonly attributionMethod: CounterAttributionMethod;
	readonly status: CounterObservationStatus;
	readonly policyVersion: string;
	readonly timestamp: string;
	readonly idempotencyKey: string;
}

export interface CounterReportEvidence {
	readonly memoryItemId: string;
	readonly signal: CounterSignal;
	readonly observationIds: readonly string[];
	readonly topLevelTaskLineageIds: readonly string[];
	readonly traceIds: readonly string[];
	readonly evidenceIds: readonly string[];
}

export interface CounterReportTrend {
	readonly memoryItemId: string;
	readonly signal: CounterSignal;
	readonly observationIds: readonly string[];
	readonly topLevelTaskLineageIds: readonly string[];
}

export interface CounterReport {
	readonly artifactKind: "counter-report";
	readonly schemaVersion: typeof COUNTER_REPORT_SCHEMA_VERSION;
	readonly metadata: EvolutionArtifactMetadata;
	readonly policyVersion: string;
	readonly evidence: readonly CounterReportEvidence[];
	readonly trends: readonly CounterReportTrend[];
}

export interface ImmutableHarnessSnapshot {
	readonly harnessVersion: HarnessVersion;
	readonly baseVersion: HarnessVersion | null;
	readonly memory: string;
	readonly memoryContentDigest: string;
	readonly activeMemoryItems: readonly EvolutionMemoryItem[];
}

export type EvolutionEvidenceOrigin = "product-runtime" | "evolution-pipeline";

export interface EvolutionEvidenceSource {
	readonly sourceId: string;
	readonly materializationId: string;
	readonly ingestionCursor: number;
	readonly origin: EvolutionEvidenceOrigin;
	readonly contentDigest: string;
	readonly invocation: MaterializedInvocation;
}

export type EvolutionTriggerKind = "automatic" | "manual";

export interface EvolutionRepositorySnapshot {
	readonly repositoryId: string;
	readonly rootPath: string;
	readonly revision: string;
}

export interface EvolutionTokenMeasurement {
	readonly estimatorVersion: string;
	readonly estimatedTokens: number;
}

export interface EvolutionPromptVersions {
	readonly reflector: string;
	readonly curator: string;
	readonly validator: string;
	readonly writer: string;
}

export interface EvolutionInputSnapshot {
	readonly metadata: EvolutionArtifactMetadata;
	readonly trigger: EvolutionTriggerKind;
	readonly repository: EvolutionRepositorySnapshot;
	readonly harness: ImmutableHarnessSnapshot;
	readonly expectedHarnessBaseVersion: HarnessVersion;
	readonly ingestionHighWaterCursor: number;
	readonly instructions: readonly InstructionDocumentSnapshot[];
	readonly modelConfiguration: EvolutionModelIdentity;
	readonly pipelineVersion: string;
	readonly promptVersions: EvolutionPromptVersions;
	readonly tokenMeasurement: EvolutionTokenMeasurement;
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
	readonly status: "failed" | "written";
	readonly output: JsonObject | null;
	readonly message: string | null;
}

export interface MutationWriteReceipt {
	readonly metadata: EvolutionArtifactMetadata;
	readonly batchId: string;
	readonly idempotencyKey: string;
	readonly result: MutationWriteResult;
}

export interface HarnessActivationResult {
	readonly batchId: string;
	readonly status: "activated" | "failed";
	readonly resultingHarnessVersion: HarnessVersion | null;
	readonly message: string | null;
}

export interface HarnessActivationReceipt {
	readonly metadata: EvolutionArtifactMetadata;
	readonly batchId: string;
	readonly idempotencyKey: string;
	readonly result: HarnessActivationResult;
}

export type EvolutionJobStage =
	| "queued"
	| "snapshotting"
	| "counter-slot"
	| "reflecting"
	| "curating"
	| "validating"
	| "writing"
	| "activating"
	| "completed";

export type ActiveEvolutionStage = Exclude<EvolutionJobStage, "completed">;

export type EvolutionJobOutcome =
	| "active"
	| "completed"
	| "interrupted"
	| "retryable-failed"
	| "terminal-failed"
	| "superseded";

export type EvolutionFailureReasonCode =
	| "artifact-corrupt"
	| "harness-base-conflict"
	| "lease-lost"
	| "model-call-failed"
	| "pipeline-invariant"
	| "shutdown"
	| "snapshot-invalid"
	| "stage-failed"
	| "superseded-by-operator"
	| "validation-rejected"
	| "writer-failed";

export interface EvolutionArtifactReference {
	readonly artifactId: string;
	readonly contentDigest: string;
}

export interface EvolutionStageCheckpoint {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly stage: ActiveEvolutionStage;
	readonly idempotencyKey: string;
	readonly outputArtifacts: readonly EvolutionArtifactReference[];
	readonly state: JsonObject;
	readonly completedAt: string;
}

export type EvolutionCompletionKind = "activated" | "no-op";

export interface EvolutionJobCompletion {
	readonly kind: EvolutionCompletionKind;
	readonly resultingHarnessVersion: HarnessVersion | null;
	readonly processedEvidenceCursor: number;
}

export interface EvolutionJobResolution {
	readonly kind: "administratively-resolved" | "superseded";
	readonly reasonCode: EvolutionFailureReasonCode;
	readonly resolvedAt: string;
}

export interface EvolutionJob {
	readonly metadata: EvolutionArtifactMetadata;
	readonly jobId: string;
	readonly inputSnapshot: EvolutionArtifactReference;
	readonly trigger: EvolutionTriggerKind;
	readonly evidenceRange: {
		readonly afterCursor: number;
		readonly throughCursor: number;
	};
	readonly stage: EvolutionJobStage;
	readonly outcome: EvolutionJobOutcome;
	readonly reasonCode: EvolutionFailureReasonCode | null;
	readonly failureMessage: string | null;
	readonly completion: EvolutionJobCompletion | null;
	readonly resolution: EvolutionJobResolution | null;
	readonly checkpoints: readonly EvolutionStageCheckpoint[];
	readonly attempt: number;
	readonly revision: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly terminalAt: string | null;
	readonly retryNotBefore: string | null;
}

export interface EvolutionProcessedEvidenceCursor {
	readonly schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	readonly scope: EvolutionScope;
	readonly sequence: number;
	readonly committedByJobId: string | null;
	readonly updatedAt: string;
}

export interface EvolutionLeaseToken {
	readonly kind: "scope" | "writer";
	readonly key: string;
	readonly ownerId: string;
	readonly fence: number;
	readonly expiresAt: string;
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
	readonly checkpoint: EvolutionStageCheckpoint;
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
	readonly completionKind: EvolutionCompletionKind;
	readonly resultingHarnessVersion: HarnessVersion | null;
	readonly processedEvidenceCursor: number;
}

export interface JobFailedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "job-failed";
	readonly failedStage: ActiveEvolutionStage;
	readonly outcome: Extract<EvolutionJobOutcome, "interrupted" | "retryable-failed" | "terminal-failed">;
	readonly reasonCode: EvolutionFailureReasonCode;
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
