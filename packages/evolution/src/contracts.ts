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
	readonly materializationId: string;
	readonly contentDigest: string;
	readonly materializedInvocationVersion: number;
	readonly traceId: string | null;
	readonly integrity: MaterializationIntegrity;
	readonly terminationStatus: MaterializedTerminationStatus;
	readonly evidenceIds: readonly string[];
	readonly semanticUnits: readonly EvidenceSemanticUnit[];
	readonly diagnostics: readonly EvidenceCorpusDiagnostic[];
	readonly orderingAmbiguity: readonly string[];
}

export type EvidenceSemanticUnitKind =
	| "message"
	| "span"
	| "terminal-outcome"
	| "tool-exchange"
	| "trace-record"
	| "turn";

export interface EvidenceSourceCursor {
	readonly traceSequence: number;
	readonly timestamp: string | null;
	readonly sessionPosition: number | null;
	readonly parentSpanId: number | null;
	readonly causalIdentifiers: readonly MaterializedCausalLink[];
	readonly session: {
		readonly bindingId: string;
		readonly entryId: string | null;
		readonly entryOrdinal: number | null;
		readonly sessionSequence: number | null;
	} | null;
}

export interface MaterializedCausalLink {
	readonly name: string;
	readonly value: string;
}

export interface EvidenceSemanticUnit {
	readonly unitId: string;
	readonly ordinal: number;
	readonly kind: EvidenceSemanticUnitKind;
	readonly evidenceIds: readonly string[];
	readonly contentDigest: string;
	readonly sourceCursor: EvidenceSourceCursor;
}

export interface EvidenceCorpusDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly recoverable: boolean;
	readonly traceSequence: number | null;
	readonly bindingId: string | null;
	readonly sourceCode: string | null;
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

export interface EvidenceSliceCursor {
	readonly documentId: string;
	readonly startUnitId: string;
	readonly endUnitId: string;
	readonly startOrdinal: number;
	readonly endOrdinal: number;
	readonly digest: string;
}

export type EvidenceSliceOpenReason =
	| "error-without-workaround"
	| "new-turn-near-end"
	| "tool-call-without-result"
	| "tool-result-without-call";

export interface EvidenceSliceEdge {
	readonly status: "closed" | "open";
	readonly reasons: readonly EvidenceSliceOpenReason[];
	readonly evidenceIds: readonly string[];
}

export interface EvidenceSliceContinuation {
	readonly previousSliceId: string | null;
	readonly nextSliceId: string | null;
}

export interface EvidenceSlice {
	readonly sliceId: string;
	readonly manifestDigest: string;
	readonly cursor: EvidenceSliceCursor;
	readonly unitIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly contentDigest: string;
	readonly leftEdge: EvidenceSliceEdge;
	readonly rightEdge: EvidenceSliceEdge;
	readonly continuation: EvidenceSliceContinuation;
}

export type EvidenceCoverageDisposition = "analyzed" | "corrupt" | "skipped" | "unreadable";

export interface EvidenceCoverageEntry {
	readonly documentId: string;
	readonly evidenceId: string;
	readonly disposition: EvidenceCoverageDisposition;
	readonly sliceIds: readonly string[];
	readonly overlaps: readonly string[];
	readonly continuationSliceIds: readonly string[];
	readonly diagnosticCodes: readonly string[];
}

export interface EvidenceCoverageMap {
	readonly metadata: EvolutionArtifactMetadata;
	readonly manifestDigest: string;
	readonly entries: readonly EvidenceCoverageEntry[];
	readonly rootNodeIds: readonly string[];
	readonly finalLessonIds: readonly string[];
}

export type ReflectionNodeStatus = "pending" | "complete" | "failed";

export interface ReflectionNode {
	readonly metadata: EvolutionArtifactMetadata;
	readonly nodeId: string;
	readonly kind: "leaf" | "synthesis";
	readonly depth: number;
	readonly parentNodeId: string | null;
	readonly childNodeIds: readonly string[];
	readonly sliceIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly lessonIds: readonly string[];
	readonly resultDigest: string;
	readonly status: ReflectionNodeStatus;
}

export type LessonKind =
	| "counterexample"
	| "direct-instruction"
	| "failure-workaround"
	| "harmful-memory"
	| "incorrect-source-of-truth"
	| "missing-capability"
	| "missing-verification"
	| "orchestration-inefficiency"
	| "repository-constraint"
	| "successful-strategy"
	| "tool-behavior"
	| "unresolved-work";

export interface Lesson {
	readonly metadata: EvolutionArtifactMetadata;
	readonly lessonId: string;
	readonly kind: LessonKind;
	readonly summary: string;
	readonly preconditions: readonly string[];
	readonly observedOutcome: string;
	readonly evidenceIds: readonly string[];
	readonly counterevidenceIds: readonly string[];
	readonly scope: EvolutionScope;
	readonly applicabilityBoundaries: readonly string[];
	readonly uncertainty: string | null;
	readonly actionableTakeaway: string;
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

export type EvolutionProposalAction = "ADD" | "DEFER" | "REMOVE" | "REPLACE";

export interface EvolutionProposalScope {
	readonly repository: EvolutionScope;
	readonly materializationIds: readonly string[];
	readonly traceIds: readonly string[];
	readonly sessionIds: readonly string[];
	readonly taskLineageIds: readonly string[];
	readonly runtimeKinds: readonly string[];
	readonly sourceRevisions: readonly string[];
	readonly harnessVersions: readonly HarnessVersion[];
	readonly applicabilityBoundaries: readonly string[];
}

export interface ApplicableInstructionReference {
	readonly kind: "applicable-instruction";
	readonly path: string;
	readonly precedence: number;
	readonly contentDigest: string;
	readonly locator: string;
}

export interface EvolutionMemoryReference {
	readonly kind: "evolution-memory";
	readonly memoryItemId: string | null;
	readonly contentDigest: string;
	readonly locator: string;
}

export type ExistingInstructionReference = ApplicableInstructionReference | EvolutionMemoryReference;

export type InstructionRelationshipClassification = "conflicts" | "duplicate" | "novel" | "strengthens";

export type InstructionStrengtheningKind = "applicability-boundary" | "condition" | "enforcement" | "precision";

export interface InstructionStrengthening {
	readonly kind: InstructionStrengtheningKind;
	readonly description: string;
}

export interface EvolutionProposalInstructionRelationship {
	readonly classification: Extract<InstructionRelationshipClassification, "novel" | "strengthens">;
	readonly relevantEntries: readonly ExistingInstructionReference[];
	readonly strengthening: InstructionStrengthening | null;
}

export interface EvolutionMemoryAddDelta {
	readonly operation: "ADD";
	readonly destination: {
		readonly section: string | null;
		readonly anchor: string | null;
	};
	readonly content: string;
	readonly intendedScope: readonly string[];
}

export interface EvolutionMemoryRemoveDelta {
	readonly operation: "REMOVE";
	readonly memoryItemId: string;
	readonly expectedContentDigest: string;
	readonly reason: string;
}

export interface EvolutionMemoryReplaceDelta {
	readonly operation: "REPLACE";
	readonly removal: Omit<EvolutionMemoryRemoveDelta, "operation">;
	readonly addition: Omit<EvolutionMemoryAddDelta, "operation">;
}

export type EvolutionMemoryDelta =
	| EvolutionMemoryAddDelta
	| EvolutionMemoryRemoveDelta
	| EvolutionMemoryReplaceDelta;

interface EvolutionProposalBase {
	readonly metadata: EvolutionArtifactMetadata;
	readonly proposalId: string;
	readonly summary: string;
	readonly scope: EvolutionProposalScope;
	readonly lessonIds: readonly string[];
	readonly supportingEvidenceIds: readonly string[];
	readonly contradictingEvidenceIds: readonly string[];
	readonly supportingTraceIds: readonly string[];
	readonly contradictingTraceIds: readonly string[];
	readonly expectedBenefit: string;
	readonly acceptanceCriterion: string;
	readonly risk: string;
	readonly rollbackDescription: string;
	readonly curatorConfidence: number;
	readonly uncertainty: string | null;
	readonly counterexamples: readonly string[];
	readonly conflictingProposalIds: readonly string[];
	readonly instructionRelationship: EvolutionProposalInstructionRelationship;
}

export interface EvolutionMemoryProposal extends EvolutionProposalBase {
	readonly disposition: "actionable";
	readonly target: EvolutionMemoryTarget;
	readonly action: Exclude<EvolutionProposalAction, "DEFER">;
	readonly exactDelta: EvolutionMemoryDelta;
	readonly expectedBaseDigest: string;
}

export interface DeferredEvolutionProposal extends EvolutionProposalBase {
	readonly disposition: "deferred";
	readonly target: SkillTarget | OrchestrationSourceTarget;
	readonly action: "DEFER";
	readonly exactDelta: null;
	readonly expectedBaseDigest: null;
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
	readonly payload: EvolutionMemoryDelta;
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
	| "curation-invalid-response"
	| "reflection-budget-exhausted"
	| "reflection-invalid-response"
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

export interface ReflectorBudgetCharge {
	readonly modelCalls: number;
	readonly reflectionRounds: number;
	readonly toolCalls: number;
}

export interface ReflectorToolCallLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "reflector-tool-call";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly manifestDigest: string;
	readonly requestDigest: string;
	readonly requestedSliceId: string | null;
	readonly resolvedEvidenceIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
	readonly budgetCharge: ReflectorBudgetCharge;
}

export interface ReflectorModelCallLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "reflector-model-call";
	readonly modelCallId: string;
	readonly nodeId: string;
	readonly attempt: number;
	readonly reflectionRound: number;
	readonly manifestDigest: string;
	readonly idempotencyKey: string;
	readonly budgetCharge: ReflectorBudgetCharge;
}

export interface ReflectionNodeCheckpointedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "reflection-node-checkpointed";
	readonly nodeId: string;
	readonly manifestDigest: string;
	readonly node: EvolutionArtifactReference;
	readonly lessons: readonly EvolutionArtifactReference[];
}

export type EvolutionLedgerEvent =
	| JobCreatedLedgerEvent
	| CheckpointSavedLedgerEvent
	| ProposalDispositionLedgerEvent
	| MutationWrittenLedgerEvent
	| JobCompletedLedgerEvent
	| JobFailedLedgerEvent
	| ProposalRolledBackLedgerEvent
	| ReflectionNodeCheckpointedLedgerEvent
	| ReflectorModelCallLedgerEvent
	| ReflectorToolCallLedgerEvent;
