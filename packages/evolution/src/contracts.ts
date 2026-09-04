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
export const SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const SKILL_EVALUATION_SCHEMA_VERSION = 1 as const;
export const SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const SKILL_LIFECYCLE_REPORT_SCHEMA_VERSION = 1 as const;

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

export interface SkillLifecycleWorkspaceIdentity {
	readonly repositoryId: string;
	readonly directoryId?: string;
}

export interface SkillLifecycleSkillVersion {
	readonly skillId: string;
	readonly version: string;
	readonly contentDigest: string;
	readonly sourceKind: EvolutionSkillSourceKind;
	readonly harnessRevision: HarnessVersion;
	readonly workspace: SkillLifecycleWorkspaceIdentity;
}

export type SkillLifecycleInvocationEvent =
	| "available"
	| "explicitly-referenced"
	| "force-loaded"
	| "listed"
	| "read"
	| "selected";

export type SkillLifecycleIssueKind =
	| "duplicate-guidance"
	| "obsolete-guidance"
	| "procedure-defect"
	| "trigger-mismatch";

export interface SkillLifecycleObservation {
	readonly schemaVersion: typeof SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION;
	readonly observationId: string;
	readonly scope: EvolutionScope;
	readonly skill: SkillLifecycleSkillVersion;
	readonly relatedSkills: readonly SkillLifecycleSkillVersion[];
	readonly invocationEvents: readonly SkillLifecycleInvocationEvent[];
	readonly topLevelTaskLineageId: string;
	readonly traceIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly signal: CounterSignal;
	readonly signalSource: CounterSignalSource;
	readonly attributionMethod: CounterAttributionMethod;
	readonly issueKind: SkillLifecycleIssueKind | null;
	readonly status: CounterObservationStatus;
	readonly policyVersion: string;
	readonly timestamp: string;
	readonly idempotencyKey: string;
}

export interface SkillLifecycleSignalWeights {
	readonly helpful: number;
	readonly harmful: number;
	readonly neutral: number;
	readonly unknown: number;
}

export interface SkillLifecycleOutcomeSummary {
	readonly skill: SkillLifecycleSkillVersion;
	readonly finalObservationIds: readonly string[];
	readonly candidateObservationIds: readonly string[];
	readonly topLevelTaskLineageIds: readonly string[];
	readonly traceIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly weightedSignals: SkillLifecycleSignalWeights;
}

export type SkillLifecycleRecommendationAction =
	| "deactivate-harmful"
	| "merge-duplicates"
	| "narrow-triggers"
	| "retire-obsolete"
	| "revise-procedure";

export interface SkillLifecycleRecommendation {
	readonly recommendationId: string;
	readonly action: SkillLifecycleRecommendationAction;
	readonly candidateOperation: Extract<SkillCandidateOperation, "MERGE" | "RETIRE" | "UPDATE">;
	readonly skillVersions: readonly SkillLifecycleSkillVersion[];
	readonly observationIds: readonly string[];
	readonly topLevelTaskLineageIds: readonly string[];
	readonly traceIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly evidenceWeight: number;
	readonly reasonCodes: readonly string[];
	readonly handoff: {
		readonly kind: "skill-curator-candidate";
		readonly requiredGates: readonly ["deterministic-validation", "retrieval-evaluation", "behavioral-evaluation"];
	};
}

export interface SkillLifecycleReport {
	readonly artifactKind: "skill-lifecycle-report";
	readonly schemaVersion: typeof SKILL_LIFECYCLE_REPORT_SCHEMA_VERSION;
	readonly metadata: EvolutionArtifactMetadata;
	readonly policyVersion: string;
	readonly activeSkillVersions: readonly SkillLifecycleSkillVersion[];
	readonly summaries: readonly SkillLifecycleOutcomeSummary[];
	readonly recommendations: readonly SkillLifecycleRecommendation[];
	readonly staleObservationIds: readonly string[];
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
	readonly directoryId?: string;
	readonly rootPath: string;
	readonly revision: string;
}

export type EvolutionTokenMeasurement =
	| {
			readonly counterVersion: string;
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly totalTokens: number;
	  }
	| {
			/** Present only on snapshots persisted before reported usage accounting. */
			readonly estimatorVersion: string;
			readonly estimatedTokens: number;
	  };

export interface EvolutionPromptVersions {
	readonly reflector: string;
	readonly curator: string;
	readonly skillCurator: string;
	readonly skillSynthesizer: string;
	readonly validator: string;
	readonly writer: string;
}

export type EvolutionSkillSourceKind = "evolved" | "installed";

export type EvolutionSkillScope = "global" | "workspace";

export interface EvolutionSkillWorkspaceIdentity {
	readonly repositoryId: string;
	readonly directoryId?: string;
}

export interface EvolutionSkillContentSnapshot {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceKind: EvolutionSkillSourceKind;
	readonly scope: EvolutionSkillScope;
	readonly source: string;
	readonly version: string;
	readonly contentDigest: string;
	readonly harnessRevision?: string;
	readonly workspace: EvolutionSkillWorkspaceIdentity | null;
	readonly location: string;
	readonly baseDir: string;
	readonly disableModelInvocation: boolean;
	readonly content: string;
}

export interface EvolutionSkillContentArtifact {
	readonly artifactKind: "skill-content";
	readonly metadata: EvolutionArtifactMetadata;
	readonly skill: EvolutionSkillContentSnapshot;
}

export interface EvolutionSkillCatalogEntry {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	readonly sourceKind: EvolutionSkillSourceKind;
	readonly scope: EvolutionSkillScope;
	readonly source: string;
	readonly version: string;
	readonly contentDigest: string;
	readonly harnessRevision?: string;
	readonly workspace: EvolutionSkillWorkspaceIdentity | null;
	readonly disableModelInvocation: boolean;
	readonly contentArtifact: EvolutionArtifactReference;
}

export interface EvolutionInputSnapshot {
	readonly metadata: EvolutionArtifactMetadata;
	readonly trigger: EvolutionTriggerKind;
	readonly repository: EvolutionRepositorySnapshot;
	readonly harness: ImmutableHarnessSnapshot;
	readonly expectedHarnessBaseVersion: HarnessVersion;
	readonly ingestionHighWaterCursor: number;
	readonly instructions: readonly InstructionDocumentSnapshot[];
	readonly skillCatalog: readonly EvolutionSkillCatalogEntry[];
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

export type ReflectionNodeStatus = "pending" | "complete" | "failed" | "timed-out";

export interface ReflectionNodeRuntime {
	readonly providerCalls: number;
	readonly providerLatencyMs: number;
	readonly internalToolRounds: number;
	readonly outputTokens: number;
	readonly retries: number;
	readonly foregroundWaitMs: number;
	readonly nodeDurationMs: number;
}

export interface EvolutionReferenceNormalization {
	readonly field: string;
	readonly providedReference: string;
	readonly normalizedReference: string;
}

export interface ReflectionNodeFailure {
	readonly diagnosticCode: string;
	readonly message: string;
}

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
	readonly failure?: ReflectionNodeFailure;
	readonly runtime?: ReflectionNodeRuntime;
}

export type LessonKind =
	| "counterexample"
	| "direct-instruction"
	| "failed-approach"
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

export type ProceduralInformationLossKind =
	| "action-order"
	| "decision-branch"
	| "failure-signal"
	| "mitigation-or-recovery"
	| "tool-or-environment-dependency"
	| "verification-action";

export interface ProceduralInformationLoss {
	readonly missing: readonly ProceduralInformationLossKind[];
	readonly supportingEvidenceIds: readonly string[];
	readonly explanation: string;
}

export interface ProceduralInformationLossFinding {
	readonly artifactKind: "procedural-information-loss";
	readonly metadata: EvolutionArtifactMetadata;
	readonly findingId: string;
	readonly detectedBy: "skill-curator";
	readonly sourceLessonIds: readonly string[];
	readonly loss: ProceduralInformationLoss;
}

export type SkillCandidateOperation = "CREATE" | "MERGE" | "RETIRE" | "UPDATE";

export type SkillabilityClassification =
	| "conditional-procedure"
	| "ordered-workflow"
	| "reusable-operational-guideline"
	| "setup-tool-sequence"
	| "troubleshooting-recovery"
	| "verification-routine";

export type SkillMemoryRelationshipClassification =
	| "complements"
	| "conflicts"
	| "fallback-until-activation"
	| "independent"
	| "redundant"
	| "supersedes";

export interface SkillCandidateWorkspaceScope {
	readonly repositoryId: string;
	readonly directoryId?: string;
	readonly rootPath: string;
	readonly repositoryRevision: string;
	readonly evolutionScope: EvolutionScope;
}

export interface SkillCandidateSkillability {
	readonly classification: SkillabilityClassification;
}

export interface SkillCandidateMemoryRelationship {
	readonly classification: SkillMemoryRelationshipClassification;
	readonly memoryProposalIds: readonly string[];
}

export interface SkillCandidateOutline {
	readonly outlineId: string;
	readonly outlineKey: string;
	readonly sourceLessonIds: readonly string[];
	readonly operation: SkillCandidateOperation;
	readonly proposedName: string;
	readonly existingSkillIds: readonly string[];
	readonly skillability: SkillCandidateSkillability;
	readonly memoryRelationship: SkillCandidateMemoryRelationship;
}

export interface SkillCandidateOutlineSet {
	readonly artifactKind: "skill-candidate-outline-set";
	readonly metadata: EvolutionArtifactMetadata;
	readonly outlineSetId: string;
	readonly discoveryIdempotencyKey: string;
	readonly inputSnapshotId: string;
	readonly workspace: SkillCandidateWorkspaceScope;
	readonly outlines: readonly SkillCandidateOutline[];
}

export interface SkillCandidateProcedureStep {
	readonly sequence: number;
	readonly action: string;
	readonly condition: string | null;
}

export interface SkillCandidateFailureHandling {
	readonly signal: string;
	readonly mitigation: string;
	readonly recovery: string;
}

export interface SkillCandidateProcedureDraftStep {
	readonly action: string;
	readonly condition: string | null;
}

export interface SkillCandidateProcedureDraft {
	readonly trigger: {
		readonly description: string;
		readonly positiveExamples: readonly string[];
		readonly negativeExamples: readonly string[];
	};
	readonly steps: readonly SkillCandidateProcedureDraftStep[];
	readonly requiredTools: readonly string[];
	readonly environment: readonly string[];
	readonly failureHandling: readonly SkillCandidateFailureHandling[];
	readonly additionalPreconditions: readonly string[];
	readonly additionalApplicabilityBoundaries: readonly string[];
	readonly verificationChecks: readonly string[];
	readonly completionCondition: string;
}

export type SkillCandidateMaterialField =
	| "applicabilityBoundaries"
	| "existingSkillIds"
	| "failureHandling"
	| "memoryRelationship"
	| "operation"
	| "preconditions"
	| "procedure.environment"
	| "procedure.requiredTools"
	| "procedure.steps"
	| "proposedName"
	| "skillability"
	| "trigger.description"
	| "trigger.negativeExamples"
	| "trigger.positiveExamples"
	| "verificationContract.checks"
	| "verificationContract.completionCondition";

export interface SkillCandidateProvenanceBinding {
	readonly sourceLessonId: string;
	readonly supportingEvidenceIds: readonly string[];
	readonly contradictingEvidenceIds: readonly string[];
	readonly materialFields: readonly SkillCandidateMaterialField[];
}

export interface SkillCandidateCapsuleSize {
	/** Canonical size of the complete SkillCandidate payload, excluding artifact metadata. */
	readonly serialization: "canonical-json-utf8-v1";
	readonly serializedBytes: number;
	readonly estimatedTokens: number;
	readonly maxSerializedBytes: number;
	readonly maxEstimatedTokens: number;
}

export interface SkillCandidate {
	readonly artifactKind: "skill-candidate";
	readonly metadata: EvolutionArtifactMetadata;
	readonly candidateId: string;
	readonly operation: SkillCandidateOperation;
	readonly workspace: SkillCandidateWorkspaceScope;
	readonly proposedName: string;
	readonly existingSkillIds: readonly string[];
	readonly sourceLessonIds: readonly string[];
	readonly provenanceBindings: readonly SkillCandidateProvenanceBinding[];
	readonly supportingEvidenceIds: readonly string[];
	readonly contradictingEvidenceIds: readonly string[];
	readonly supportingTraceIds: readonly string[];
	readonly contradictingTraceIds: readonly string[];
	readonly taskLineageIds: readonly string[];
	readonly skillability: SkillCandidateSkillability;
	readonly trigger: {
		readonly description: string;
		readonly positiveExamples: readonly string[];
		readonly negativeExamples: readonly string[];
	};
	readonly preconditions: readonly string[];
	readonly procedure: {
		readonly steps: readonly SkillCandidateProcedureStep[];
		readonly requiredTools: readonly string[];
		readonly environment: readonly string[];
	};
	readonly failureHandling: readonly SkillCandidateFailureHandling[];
	readonly applicabilityBoundaries: readonly string[];
	readonly verificationContract: {
		readonly checks: readonly string[];
		readonly completionCondition: string;
	};
	readonly memoryRelationship: SkillCandidateMemoryRelationship;
	readonly capsuleSize: SkillCandidateCapsuleSize;
}

export type SkillCandidateExpansionFailureReasonCode =
	| "candidate-assembly-invalid"
	| "model-call-failed"
	| "procedure-draft-invalid";

export interface SkillCandidateExpansionAttemptDiagnostic {
	readonly attempt: 1 | 2;
	readonly modelRounds: number;
	readonly reasonCode: SkillCandidateExpansionFailureReasonCode;
	/** Sanitized summary safe for persistence and operator display; never raw model output. */
	readonly message: string;
	readonly inspectedReferences: {
		readonly evidenceIds: readonly string[];
		readonly skillIds: readonly string[];
	};
	readonly invalidFieldPaths: readonly string[];
}

export interface SkillCandidateExpansionFailureDiagnostic {
	readonly reasonCode: SkillCandidateExpansionFailureReasonCode;
	/** Sanitized terminal summary safe for persistence and operator display. */
	readonly message: string;
	readonly attempts: readonly [SkillCandidateExpansionAttemptDiagnostic, SkillCandidateExpansionAttemptDiagnostic];
}

export interface SkillCandidateExpansionSucceeded {
	readonly status: "succeeded";
	readonly outlineId: string;
	readonly outlineKey: string;
	readonly attemptCount: 1 | 2;
	readonly candidate: SkillCandidate;
}

export interface SkillCandidateExpansionFailed {
	readonly status: "failed";
	readonly outlineId: string;
	readonly outlineKey: string;
	readonly diagnostic: SkillCandidateExpansionFailureDiagnostic;
}

export type SkillCandidateExpansionOutcome = SkillCandidateExpansionSucceeded | SkillCandidateExpansionFailed;

export type SkillCurationStatus = "completed" | "completed-with-some-failures";

export interface DeferredSkillCandidateFinding {
	readonly artifactKind: "skill-candidate-finding";
	readonly metadata: EvolutionArtifactMetadata;
	readonly findingId: string;
	readonly disposition: "deferred";
	readonly workspace: SkillCandidateWorkspaceScope;
	readonly sourceLessonIds: readonly string[];
	readonly existingSkillIds: readonly string[];
	readonly skillability: SkillCandidate["skillability"];
	readonly memoryRelationship: SkillCandidateMemoryRelationship;
	readonly reason: string;
}

export type SkillCandidateState =
	| "proposed"
	| "evidence-qualified"
	| "synthesis-failed"
	| "drafted"
	| "structurally-valid"
	| "evaluation-pending"
	| "accepted"
	| "quarantined"
	| "rejected"
	| "retired";

export interface SkillCandidateRegistryWorkspace {
	readonly repositoryId: string;
	readonly directoryId?: string;
	readonly evolutionScope: EvolutionScope;
}

export interface SkillCandidateGroupingProfile {
	readonly workspace: SkillCandidateRegistryWorkspace;
	readonly existingSkillIds: readonly string[];
	readonly skillability: SkillabilityClassification;
	readonly triggerTerms: readonly string[];
	readonly proceduralIntentTerms: readonly string[];
	readonly applicabilityTerms: readonly string[];
}

export interface SkillCandidateEvidenceContribution {
	readonly supportingEvidenceIds: readonly string[];
	readonly contradictingEvidenceIds: readonly string[];
	readonly supportingTraceIds: readonly string[];
	readonly contradictingTraceIds: readonly string[];
	readonly supportingTaskLineageIds: readonly string[];
	readonly contradictingTaskLineageIds: readonly string[];
}

export interface SkillCandidateProposalRevision {
	readonly revisionId: string;
	readonly candidateId: string;
	readonly candidate: EvolutionArtifactReference;
	readonly sourceEvolutionJobId: string;
	readonly createdAt: string;
	readonly evidence: SkillCandidateEvidenceContribution;
}

export interface SkillCandidateGroupContract {
	readonly operation: SkillCandidateOperation;
	readonly proposedName: string;
	readonly workspace: SkillCandidateWorkspaceScope;
	readonly existingSkillIds: readonly string[];
	readonly skillability: SkillCandidate["skillability"];
	readonly trigger: SkillCandidate["trigger"];
	readonly preconditions: readonly string[];
	readonly procedure: SkillCandidate["procedure"];
	readonly failureHandling: readonly SkillCandidateFailureHandling[];
	readonly applicabilityBoundaries: readonly string[];
	readonly verificationContract: SkillCandidate["verificationContract"];
	readonly memoryRelationship: SkillCandidateMemoryRelationship;
}

export type SkillCandidateGroupAdditionField =
	| "applicabilityBoundaries"
	| "failureHandling"
	| "preconditions"
	| "procedure.environment"
	| "procedure.requiredTools"
	| "procedure.steps"
	| "trigger.negativeExamples"
	| "trigger.positiveExamples"
	| "verificationContract.checks";

export type SkillCandidateGroupAdditionValue = string | SkillCandidateFailureHandling | SkillCandidateProcedureStep;

export interface SkillCandidateGroupRevisionSpan {
	readonly startIndex: number;
	readonly endIndex: number;
}

export interface SkillCandidateGroupHistoricalAddition {
	readonly field: SkillCandidateGroupAdditionField;
	readonly value: SkillCandidateGroupAdditionValue;
	readonly valueDigest: string;
	readonly supportCount: number;
	readonly revisionSpans: readonly SkillCandidateGroupRevisionSpan[];
}

export interface SkillCandidateGroupValueSupport {
	readonly field: SkillCandidateMaterialField;
	readonly valueDigest: string;
	readonly supportCount: number;
	readonly revisionSpans: readonly SkillCandidateGroupRevisionSpan[];
}

export interface SkillCandidateGroupConflictAlternative {
	readonly value: string | SkillCandidate["skillability"] | SkillCandidateMemoryRelationship;
	readonly valueDigest: string;
	readonly supportCount: number;
	readonly revisionSpans: readonly SkillCandidateGroupRevisionSpan[];
}

export interface SkillCandidateGroupConflict {
	readonly field:
		| "memoryRelationship"
		| "operation"
		| "proposedName"
		| "skillability"
		| "trigger.description"
		| "verificationContract.completionCondition";
	readonly baseValueDigest: string;
	readonly alternatives: readonly SkillCandidateGroupConflictAlternative[];
	readonly omittedAlternativeCount: number;
	readonly omittedAlternativesDigest: string | null;
}

export interface SkillCandidateGroupCapsule {
	readonly artifactKind: "skill-candidate-group-capsule";
	readonly metadata: EvolutionArtifactMetadata;
	readonly capsuleId: string;
	readonly groupId: string;
	readonly baseProposalRevisionId: string;
	readonly proposalRevisionIds: readonly string[];
	readonly sourceDigests: readonly string[];
	readonly contract: SkillCandidateGroupContract;
	readonly historicalAdditions: readonly SkillCandidateGroupHistoricalAddition[];
	readonly support: readonly SkillCandidateGroupValueSupport[];
	readonly conflicts: readonly SkillCandidateGroupConflict[];
	readonly evidence: SkillCandidateEvidenceContribution;
}

export interface SkillCandidatePriorityScoreComponents {
	readonly independentSupport: number;
	readonly evidenceBreadth: number;
	readonly proceduralCompleteness: number;
	readonly verificationCompleteness: number;
	readonly scopeSpecificity: number;
	readonly counterevidencePenalty: number;
}

export interface SkillCandidatePriorityScore {
	readonly artifactKind: "skill-candidate-priority-score";
	readonly metadata: EvolutionArtifactMetadata;
	readonly scoreId: string;
	readonly groupId: string;
	readonly scorerVersion: string;
	readonly evidencePriorityScore: number;
	readonly scoreComponents: SkillCandidatePriorityScoreComponents;
	readonly proposalRevisionIds: readonly string[];
	readonly supportingTaskLineageIds: readonly string[];
	readonly contradictingTaskLineageIds: readonly string[];
}

export interface SkillPackageFile {
	readonly path: string;
	readonly content: string;
}

export interface SkillSynthesisRequestDiagnostics {
	readonly serialization: "canonical-json-utf8-v1";
	readonly serializedBytes: number;
	readonly estimatedTokens: number;
	readonly inputSerializedBytes: number;
	readonly inputEstimatedTokens: number;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly schemaEstimatedTokens: number;
	readonly protocolOverheadTokens: number;
	readonly safetyMarginTokens: number;
	readonly inputBudgetTokens: number;
	readonly schemaDigest: string;
	readonly capsuleDigest: string;
	readonly requestDigest: string;
}

export interface SkillDraft {
	readonly artifactKind: "skill-draft";
	readonly metadata: EvolutionArtifactMetadata;
	readonly draftId: string;
	readonly groupId: string;
	readonly synthesisIdempotencyKey: string;
	readonly proposalRevisionIds: readonly string[];
	readonly sourceCandidateIds: readonly string[];
	readonly sourceEvidenceIds: readonly string[];
	readonly sourceTraceIds: readonly string[];
	readonly sourceSkillVersions: readonly {
		readonly skillId: string;
		readonly version: string;
		readonly contentDigest: string;
	}[];
	readonly repositoryInstructionDigests: readonly string[];
	readonly synthesisRequest: SkillSynthesisRequestDiagnostics;
	readonly operation: SkillCandidateOperation;
	readonly proposedName: string;
	readonly existingSkillIds: readonly string[];
	readonly workspace: SkillCandidateWorkspaceScope;
	readonly content: string;
	readonly files: readonly SkillPackageFile[];
}

export interface SkillDraftValidationIssue {
	readonly code: string;
	readonly message: string;
}

export interface SkillDraftValidationReport {
	readonly artifactKind: "skill-draft-validation";
	readonly metadata: EvolutionArtifactMetadata;
	readonly validationId: string;
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly validatorVersion: string;
	readonly assurance: "structure-provenance-scope-and-security-only";
	readonly disposition: "accepted" | "rejected";
	readonly issues: readonly SkillDraftValidationIssue[];
	readonly validatedHarnessVersion: HarnessVersion;
	readonly validatedSkillVersions: readonly string[];
	readonly canonicalInventory: readonly string[];
	readonly memoryRelationshipDigest: string;
}

export type SkillEvaluationCaseKind = "hard-negative" | "intended" | "unrelated";

export type SkillEvaluationCaseOrigin = "held-out" | "source-replay";

export type SkillEvaluationVerifierKind = "environment" | "test" | "tool";

export interface SkillEvaluationVerifier {
	readonly kind: SkillEvaluationVerifierKind;
	readonly name: string;
	readonly version: string;
	readonly configurationDigest: string;
}

export interface SkillEvaluationCase {
	readonly caseId: string;
	readonly taskFamily: string;
	readonly kind: SkillEvaluationCaseKind;
	readonly origin: SkillEvaluationCaseOrigin;
	readonly taskLineageId: string;
	readonly sourceTraceId: string | null;
	readonly prompt: string;
	readonly expectedSkillIds: readonly string[];
	readonly confusableSkillIds: readonly string[];
	readonly verifier: SkillEvaluationVerifier;
}

export interface SkillEvaluationComponentConfiguration {
	readonly name: string;
	readonly version: string;
	readonly configurationDigest: string;
}

export interface SkillEvaluationRuntimeConfiguration {
	readonly model: EvolutionModelIdentity;
	readonly runtime: SkillEvaluationComponentConfiguration;
	readonly retriever: SkillEvaluationComponentConfiguration;
	readonly executor: SkillEvaluationComponentConfiguration;
}

export interface SkillEvaluationPoolSkill {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	readonly source: "candidate" | "catalog";
	readonly version: string;
	readonly contentDigest: string;
	readonly content: string;
	readonly files?: readonly SkillPackageFile[];
}

export interface SkillRetrievalEvaluationResult {
	readonly caseId: string;
	readonly selectedSkillIds: readonly string[];
	readonly scores: readonly {
		readonly skillId: string;
		readonly score: number;
	}[];
}

export interface SkillBehaviorEvaluationOutcome {
	readonly passed: boolean;
	readonly score: number;
	readonly appliedSkillIds: readonly string[];
	readonly verifier: SkillEvaluationVerifier;
	readonly details: JsonObject;
}

export interface SkillBehaviorEvaluationResult {
	readonly caseId: string;
	readonly baseline: SkillBehaviorEvaluationOutcome;
	readonly fullPool: SkillBehaviorEvaluationOutcome;
}

export interface SkillEvaluationGate {
	readonly passed: boolean;
	readonly reasonCodes: readonly string[];
}

export interface SkillEvaluationMetrics {
	readonly exactRetrievalAccuracy: number;
	readonly sourceReplayReproducibility: number;
	readonly heldOutIntendedBaselineScore: number;
	readonly heldOutIntendedFullPoolScore: number;
	readonly heldOutIntendedImprovement: number;
	readonly negativeRegressionCount: number;
	readonly misapplicationCount: number;
}

export interface SkillEvaluationReport {
	readonly artifactKind: "skill-evaluation";
	readonly schemaVersion: typeof SKILL_EVALUATION_SCHEMA_VERSION;
	readonly metadata: EvolutionArtifactMetadata;
	readonly evaluationId: string;
	readonly groupId: string;
	readonly evaluationIdempotencyKey: string;
	readonly proposalRevisionIds: readonly string[];
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly evaluatorVersion: string;
	readonly assurance: "retrieval-and-deterministic-behavior-gates";
	readonly disposition: "accepted" | "quarantined";
	readonly harnessVersion: HarnessVersion;
	readonly candidateSkill: SkillEvaluationPoolSkill;
	readonly neighboringSkills: readonly SkillEvaluationPoolSkill[];
	readonly configuration: SkillEvaluationRuntimeConfiguration;
	readonly cases: readonly SkillEvaluationCase[];
	readonly retrievalResults: readonly SkillRetrievalEvaluationResult[];
	readonly behaviorResults: readonly SkillBehaviorEvaluationResult[];
	readonly metrics: SkillEvaluationMetrics;
	readonly gates: {
		readonly suite: SkillEvaluationGate;
		readonly retrieval: SkillEvaluationGate;
		readonly behavior: SkillEvaluationGate;
	};
}

export interface SkillCandidateDispositionRecord {
	readonly eventId: string;
	readonly from: SkillCandidateState | null;
	readonly to: SkillCandidateState;
	readonly reasonCodes: readonly string[];
	readonly createdAt: string;
}

export interface SkillCandidateGroup {
	readonly groupId: string;
	readonly profile: SkillCandidateGroupingProfile;
	readonly proposalRevisions: readonly SkillCandidateProposalRevision[];
	/** Null only for groups persisted before canonical capsules were introduced. */
	readonly canonicalCapsule: EvolutionArtifactReference | null;
	readonly state: SkillCandidateState;
	readonly dispositionHistory: readonly SkillCandidateDispositionRecord[];
	readonly evidence: SkillCandidateEvidenceContribution;
	readonly priorityScore: EvolutionArtifactReference | null;
	readonly draft: EvolutionArtifactReference | null;
	readonly validation: EvolutionArtifactReference | null;
	readonly evaluation: EvolutionArtifactReference | null;
	readonly synthesisIdempotencyKey: string;
	readonly validationIdempotencyKey: string;
	readonly evaluationIdempotencyKey: string;
}

interface SkillCandidateRegistryEventBase {
	readonly schemaVersion: typeof SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION;
	readonly metadata: EvolutionArtifactMetadata;
	readonly eventId: string;
	readonly registrySequence: number;
}

export interface SkillCandidateProposalRecordedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-proposal-recorded";
	readonly groupId: string;
	readonly profile: SkillCandidateGroupingProfile;
	readonly proposalRevision: SkillCandidateProposalRevision;
}

export interface SkillCandidateGroupCapsuleRecordedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-group-capsule-recorded";
	readonly groupId: string;
	readonly capsule: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
}

export interface SkillCandidatePriorityScoredEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-priority-scored";
	readonly groupId: string;
	readonly score: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
}

export interface SkillCandidateDraftRecordedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-draft-recorded";
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
}

export interface SkillCandidateValidationRecordedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-validation-recorded";
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
}

export interface SkillCandidateEvaluationRecordedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-evaluation-recorded";
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly evaluation: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
}

export interface SkillCandidateStateTransitionedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-state-transitioned";
	readonly groupId: string;
	readonly from: SkillCandidateState | null;
	readonly to: SkillCandidateState;
	readonly reasonCodes: readonly string[];
}

export type SkillCandidateWorkStage =
	| "consolidating"
	| "scoring"
	| "synthesizing"
	| "validating"
	| "evaluating"
	| "completed";

export interface SkillCandidateWorkCheckpointedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-work-checkpointed";
	readonly workId: string;
	readonly sourceEvolutionJobId: string;
	readonly stage: SkillCandidateWorkStage;
	readonly idempotencyKey: string;
	readonly attempt: number;
	readonly groupIds: readonly string[];
}

export interface SkillCandidateWorkErrorCause {
	readonly name: string;
	readonly message: string;
}

export interface SkillCandidateWorkErrorDiagnostic {
	readonly name: string;
	readonly message: string;
	readonly reasonCode: EvolutionFailureReasonCode | null;
	readonly retryable: boolean | null;
	readonly diagnostics: JsonValue | null;
	readonly cause: SkillCandidateWorkErrorCause | null;
}

export interface SkillCandidateGroupFailureDiagnostic {
	readonly groupId: string | null;
	/** Present for synthesis failures so retry budgets follow the immutable synthesis identity across jobs. */
	readonly synthesisIdempotencyKey?: string;
	readonly error: SkillCandidateWorkErrorDiagnostic;
}

export interface SkillCandidateWorkFailedEvent extends SkillCandidateRegistryEventBase {
	readonly type: "skill-candidate-work-failed";
	readonly workId: string;
	readonly sourceEvolutionJobId: string;
	readonly idempotencyKey: string;
	readonly attempt: number;
	readonly message: string;
	readonly retryNotBefore: string | null;
	/** Absent only on records written before structured candidate-work failure diagnostics were introduced. */
	readonly stage?: SkillCandidateWorkStage;
	/** Absent only on records written before structured candidate-work failure diagnostics were introduced. */
	readonly diagnostics?: readonly SkillCandidateGroupFailureDiagnostic[];
}

export type SkillCandidateRegistryEvent =
	| SkillCandidateProposalRecordedEvent
	| SkillCandidateGroupCapsuleRecordedEvent
	| SkillCandidatePriorityScoredEvent
	| SkillCandidateDraftRecordedEvent
	| SkillCandidateValidationRecordedEvent
	| SkillCandidateEvaluationRecordedEvent
	| SkillCandidateStateTransitionedEvent
	| SkillCandidateWorkCheckpointedEvent
	| SkillCandidateWorkFailedEvent;

export interface SkillCandidateRegistrySnapshot {
	readonly revision: number;
	readonly events: readonly SkillCandidateRegistryEvent[];
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
	readonly repositoryRevision: string;
	readonly materializationIds: readonly string[];
	readonly traceIds: readonly string[];
	readonly sessionIds: readonly string[];
	readonly taskLineageIds: readonly string[];
	readonly runtimeKinds: readonly string[];
	readonly runtimeVersions: readonly string[];
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
	/** A section must name one existing heading. Both fields null append after the final memory item. */
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
	readonly addition: Pick<EvolutionMemoryAddDelta, "content" | "intendedScope">;
}

export type EvolutionMemoryDelta = EvolutionMemoryAddDelta | EvolutionMemoryRemoveDelta | EvolutionMemoryReplaceDelta;

interface EvolutionProposalBase {
	readonly metadata: EvolutionArtifactMetadata;
	readonly proposalId: string;
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
	readonly disposition: "accepted" | "deferred" | "quarantined" | "rejected";
	readonly reasonCodes: readonly string[];
	readonly issues: readonly ValidationIssue[];
}

export interface ValidationReport {
	readonly metadata: EvolutionArtifactMetadata;
	readonly validatorVersion: string;
	readonly assurance: "provenance-recurrence-and-structure-only";
	readonly proposalResults: readonly ProposalValidationResult[];
}

export interface EvidenceRankingScoreComponents {
	readonly recurrence: number;
	readonly provenanceIntegrity: number;
	readonly sourceSignalStrength: number;
	readonly scopeCoverage: number;
	readonly curatorConfidence: number;
	readonly proposalCompleteness: number;
	readonly contradictionPenalty: number;
}

export type ScoredProposalDisposition =
	| "deferred"
	| "quarantined"
	| "rejected"
	| "selected"
	| "superseded"
	| "unselected";

export interface ScoredProposal {
	readonly metadata: EvolutionArtifactMetadata;
	readonly proposal: EvolutionProposal;
	readonly scorerVersion: string;
	readonly evidenceRankingScore: number | null;
	readonly scoreComponents: EvidenceRankingScoreComponents | null;
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
	readonly expectedBaseVersion: HarnessVersion;
	readonly expectedBaseDigest: string;
	readonly baseMemoryItems: readonly EvolutionMemoryItem[];
	readonly activationEventId: string;
	readonly mutations: readonly EvolutionMutation[];
}

export interface SkillMutationExistingArtifact {
	readonly skillId: string;
	readonly path: string;
	readonly contentDigest: string;
}

export interface SkillMutationArtifact {
	readonly path: string;
	readonly content: string;
	readonly files: readonly SkillPackageFile[];
	readonly contentDigest: string;
	readonly packageVersion: string;
}

export type SkillActivationMemoryRelationshipClassification = Exclude<
	SkillMemoryRelationshipClassification,
	"conflicts" | "redundant"
>;

export interface SkillMutationMemoryDisposition {
	readonly relationshipDigest: string;
	readonly classifications: readonly SkillActivationMemoryRelationshipClassification[];
	readonly memoryProposalIds: readonly string[];
	readonly activationAction: "preserve";
	readonly futureMemoryChange: "explicit-proposal-required" | "none";
}

export interface SkillMutation {
	readonly mutationId: string;
	readonly groupId: string;
	readonly operation: SkillCandidateOperation;
	readonly proposedName: string;
	readonly workspace: EvolutionSkillWorkspaceIdentity;
	readonly proposalRevisionIds: readonly string[];
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly evaluation: EvolutionArtifactReference | null;
	readonly memoryDisposition: SkillMutationMemoryDisposition;
	readonly existingSkills: readonly SkillMutationExistingArtifact[];
	readonly skill: SkillMutationArtifact | null;
}

export interface SkillMutationBatch {
	readonly metadata: EvolutionArtifactMetadata;
	readonly batchId: string;
	readonly targetKind: "skill";
	readonly expectedBaseVersion: HarnessVersion;
	readonly workspace: EvolutionSkillWorkspaceIdentity;
	readonly mutations: readonly SkillMutation[];
}

export type SkillMutationExactDiff = JsonObject & {
	readonly removed: readonly JsonObject[];
	readonly added: readonly JsonObject[];
};

export type SkillMutationWriteOutput = JsonObject & {
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly batchHash: string;
	readonly expectedBaseVersion: HarnessVersion;
	readonly resultingHarnessVersion: HarnessVersion;
	readonly operationIds: readonly string[];
	readonly diff: SkillMutationExactDiff;
};

export type EvolutionMemoryExactDiff = JsonObject & {
	readonly start: number;
	readonly removed: string;
	readonly added: string;
};

export type EvolutionMemoryWriteOutput = JsonObject & {
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly batchHash: string;
	readonly expectedBaseVersion: HarnessVersion;
	readonly expectedBaseDigest: string;
	readonly resultingHarnessVersion: HarnessVersion;
	readonly resultingMemoryDigest: string;
	readonly operationIds: readonly string[];
	readonly diff: EvolutionMemoryExactDiff;
};

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
	| "skill-curating"
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
	| "cancelled-by-operator"
	| "harness-base-conflict"
	| "lease-lost"
	| "model-call-failed"
	| "pipeline-invariant"
	| "curation-invalid-response"
	| "skill-curation-invalid-response"
	| "skill-synthesis-invalid-response"
	| "skill-synthesis-request-too-large"
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
	readonly startedAt?: string;
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
	readonly kind: "candidate-work" | "scope" | "writer";
	readonly key: string;
	readonly ownerId: string;
	readonly fence: number;
	readonly expiresAt: string;
}

export type EvolutionProposalLedgerDisposition =
	| "applied"
	| "deferred"
	| "failed"
	| "quarantined"
	| "rejected"
	| "rolled-back"
	| "superseded"
	| "unselected";

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

export interface HarnessActivatedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "harness-activated";
	readonly batchId: string;
	readonly proposalIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly operationIds: readonly string[];
	readonly exactDiff: EvolutionMemoryExactDiff;
	readonly parentHarnessVersion: HarnessVersion;
	readonly resultingHarnessVersion: HarnessVersion;
	readonly activationResult: HarnessActivationResult;
	readonly rollbackParentHarnessVersion: HarnessVersion;
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
	readonly requestedDocumentRef: string | null;
	readonly requestedSliceRef: string | null;
	readonly resolvedDocumentIds: readonly string[];
	readonly resolvedEvidenceIds: readonly string[];
	readonly resolvedLessonIds: readonly string[];
	readonly resolvedSliceIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
	readonly budgetCharge: ReflectorBudgetCharge;
}

export interface CuratorToolCallLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "curator-tool-call";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly requestDigest: string;
	readonly requestedReferences: readonly string[];
	readonly resolvedInstructionPaths: readonly string[];
	readonly resolvedLessonIds: readonly string[];
	readonly resolvedMemoryItemIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
}

export interface SkillCuratorToolCallLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "skill-curator-tool-call";
	readonly toolCallId: string;
	readonly toolName: "inspect_skills" | "inspect_source_evidence";
	readonly requestDigest: string;
	readonly requestedReferences: readonly string[];
	readonly resolvedEvidenceIds: readonly string[];
	readonly resolvedSkillIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
}

export interface SkillCandidateOutlinesCheckpointedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "skill-candidate-outlines-checkpointed";
	readonly idempotencyKey: string;
	readonly outlineSet: EvolutionArtifactReference;
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

export interface ReflectionLeafRetryPendingLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "reflection-leaf-retry-pending";
	readonly nodeId: string;
	readonly manifestDigest: string;
	readonly failure: ReflectionNodeFailure;
	readonly runtime: ReflectionNodeRuntime;
}

export interface ReflectionNodeCheckpointedLedgerEvent extends EvolutionLedgerEventBase {
	readonly type: "reflection-node-checkpointed";
	readonly nodeId: string;
	readonly manifestDigest: string;
	readonly node: EvolutionArtifactReference;
	readonly lessons: readonly EvolutionArtifactReference[];
	readonly referenceNormalizations: readonly EvolutionReferenceNormalization[];
}

export type EvolutionLedgerEvent =
	| JobCreatedLedgerEvent
	| CheckpointSavedLedgerEvent
	| ProposalDispositionLedgerEvent
	| MutationWrittenLedgerEvent
	| HarnessActivatedLedgerEvent
	| JobCompletedLedgerEvent
	| JobFailedLedgerEvent
	| ProposalRolledBackLedgerEvent
	| ReflectionLeafRetryPendingLedgerEvent
	| ReflectionNodeCheckpointedLedgerEvent
	| CuratorToolCallLedgerEvent
	| SkillCuratorToolCallLedgerEvent
	| SkillCandidateOutlinesCheckpointedLedgerEvent
	| ReflectorModelCallLedgerEvent
	| ReflectorToolCallLedgerEvent;
