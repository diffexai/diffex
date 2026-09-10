import type { MaterializedInvocation } from "@diffexai/diffex-harness-trace";
import type {
	CounterReport,
	DeferredSkillCandidateFinding,
	EvidenceCorpusManifest,
	EvidenceCoverageMap,
	EvolutionArtifactReference,
	EvolutionFailureReasonCode,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionJobStage,
	EvolutionLeaseToken,
	EvolutionLedgerEvent,
	EvolutionMemoryItem,
	EvolutionModelIdentity,
	EvolutionProcessedEvidenceCursor,
	EvolutionPromptVersions,
	EvolutionProposal,
	EvolutionRepositorySnapshot,
	EvolutionScope,
	EvolutionSkillContentArtifact,
	EvolutionSkillContentSnapshot,
	EvolutionStageCheckpoint,
	EvolutionTriggerKind,
	HarnessActivationReceipt,
	ImmutableHarnessSnapshot,
	InstructionDocumentSnapshot,
	InstructionSnapshot,
	JsonObject,
	JsonValue,
	Lesson,
	MutationBatch,
	MutationWriteReceipt,
	ProceduralInformationLossFinding,
	ReflectionNode,
	ScoredProposal,
	SkillBehaviorEvaluationOutcome,
	SkillCandidate,
	SkillCandidateExpansionFailed,
	SkillCandidateGroup,
	SkillCandidateGroupCapsule,
	SkillCandidateOutlineSet,
	SkillCandidatePriorityScore,
	SkillCandidateRegistryEvent,
	SkillCandidateRegistrySnapshot,
	SkillCurationStatus,
	SkillDraft,
	SkillDraftValidationReport,
	SkillEvaluationCase,
	SkillEvaluationPoolSkill,
	SkillEvaluationReport,
	SkillEvaluationRuntimeConfiguration,
	SkillLifecycleObservation,
	SkillLifecycleReport,
	SkillMutationBatch,
	SkillRetrievalEvaluationResult,
	SkillSynthesisRequestDiagnostics,
	ValidationReport,
} from "./contracts.ts";

export type EvolutionArtifact =
	| CounterReport
	| EvidenceCoverageMap
	| EvidenceCorpusManifest
	| EvolutionInputSnapshot
	| EvolutionProposal
	| EvolutionSkillContentArtifact
	| HarnessActivationReceipt
	| InstructionSnapshot
	| Lesson
	| MutationBatch
	| ProceduralInformationLossFinding
	| MutationWriteReceipt
	| ReflectionNode
	| ScoredProposal
	| SkillCandidate
	| SkillCandidateOutlineSet
	| SkillCandidateGroupCapsule
	| SkillCandidatePriorityScore
	| SkillDraft
	| SkillDraftValidationReport
	| SkillEvaluationReport
	| SkillLifecycleReport
	| SkillMutationBatch
	| DeferredSkillCandidateFinding
	| ValidationReport;

export interface EvolutionClock {
	now(): string;
}

export interface EvolutionIdGenerator {
	nextId(kind: string): string;
}

export interface EvolutionModelTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonObject;
	execute(input: JsonObject): Promise<JsonObject>;
}

export interface ReflectorProviderCallMetrics {
	readonly durationMs: number;
	readonly outputTokens: number;
	readonly outcome: "completed" | "failed" | "timed-out";
	readonly retry: boolean;
}

export interface ReflectorModelRequest {
	readonly stage: "reflector";
	readonly model: EvolutionModelIdentity;
	readonly promptVersion: string;
	readonly idempotencyKey: string;
	readonly input: JsonObject;
	readonly outputSchema: JsonObject;
	readonly tools: readonly EvolutionModelTool[];
	readonly validateOutput?: (output: JsonObject) => void;
	readonly beforeProviderCall?: () => void | Promise<void>;
	readonly onProviderCallComplete?: (metrics: ReflectorProviderCallMetrics) => void;
	readonly onInternalToolRound?: () => void;
	readonly onForegroundWaitStart?: () => void;
	readonly onForegroundWaitEnd?: (durationMs: number) => void;
	readonly signal?: AbortSignal;
}

export interface CuratorModelRequest {
	readonly stage: "curator";
	readonly model: EvolutionModelIdentity;
	readonly promptVersion: string;
	readonly idempotencyKey: string;
	readonly input: JsonObject;
	readonly outputSchema: JsonObject;
	readonly tools: readonly EvolutionModelTool[];
	readonly validateOutput?: (output: JsonObject) => void;
	readonly signal?: AbortSignal;
}

export interface SkillCuratorModelRequest {
	readonly stage: "skill-curator";
	readonly model: EvolutionModelIdentity;
	readonly promptVersion: string;
	readonly idempotencyKey: string;
	readonly input: JsonObject;
	readonly outputSchema: JsonObject;
	readonly tools: readonly EvolutionModelTool[];
	readonly validateOutput?: (output: JsonObject) => void;
	readonly onModelRound?: () => void;
	readonly signal?: AbortSignal;
}

export interface SkillSynthesizerModelRequest {
	readonly stage: "skill-synthesizer";
	readonly model: EvolutionModelIdentity;
	readonly promptVersion: string;
	readonly idempotencyKey: string;
	readonly input: JsonObject;
	readonly outputSchema: JsonObject;
	readonly tools: readonly EvolutionModelTool[];
	readonly maxOutputTokens: number;
	readonly requestDiagnostics: SkillSynthesisRequestDiagnostics;
	readonly validateOutput?: (output: JsonObject) => void;
	readonly signal?: AbortSignal;
}

export type EvolutionModelRequest =
	| CuratorModelRequest
	| ReflectorModelRequest
	| SkillCuratorModelRequest
	| SkillSynthesizerModelRequest;

export interface EvolutionModelResponse {
	readonly output: JsonObject;
	readonly submissionMethod?: "json-text" | "response-tool";
	readonly model: {
		readonly provider: string;
		readonly model: string;
	};
}

export interface EvolutionModelLimits {
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
}

export interface EvolutionModelExecutor {
	readonly maxProviderCallsPerExecution: number;
	execute(request: EvolutionModelRequest): Promise<EvolutionModelResponse>;
}

export interface SkillSynthesisModelExecutor extends EvolutionModelExecutor {
	getModelLimits(model: EvolutionModelIdentity): EvolutionModelLimits;
}

export interface EvolutionFailureRecord {
	readonly schemaVersion: 1;
	readonly jobId: string;
	readonly trigger: EvolutionTriggerKind;
	readonly stage: EvolutionJobStage;
	readonly outcome: "retryable-failed" | "terminal-failed";
	readonly reasonCode: EvolutionFailureReasonCode;
	readonly failedAt: string;
	readonly attempt: number;
	readonly error: {
		readonly name: string;
		readonly message: string;
		readonly stack: string | null;
		readonly cause: {
			readonly name: string;
			readonly message: string;
			readonly stack: string | null;
		} | null;
		readonly diagnostics: JsonValue | null;
	};
}

export interface EvolutionFailureReporter {
	record(failure: EvolutionFailureRecord): Promise<void>;
}

export interface PreReflectionStageInput {
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly activeMemoryItems: readonly EvolutionMemoryItem[];
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface PreReflectionStage {
	run(input: PreReflectionStageInput): Promise<CounterReport | null>;
}

export interface ReflectorInput {
	readonly jobId: string;
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly counterReport: CounterReport | null;
	readonly instructions: InstructionSnapshot;
	readonly model: EvolutionModelExecutor;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface ReflectionResult {
	readonly nodes: readonly ReflectionNode[];
	readonly lessons: readonly Lesson[];
	readonly coverage: EvidenceCoverageMap;
	readonly finalLessonIds: readonly string[];
}

export interface Reflector {
	reflect(input: ReflectorInput): Promise<ReflectionResult>;
}

export interface CuratorInput {
	readonly jobId: string;
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly instructions: InstructionSnapshot;
	readonly reflection: ReflectionResult;
	readonly model: EvolutionModelExecutor;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface Curator {
	curate(input: CuratorInput): Promise<readonly EvolutionProposal[]>;
}

export interface SkillCuratorInput {
	readonly jobId: string;
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly reflection: ReflectionResult;
	readonly selectedMemoryProposals: readonly ScoredProposal[];
	readonly model: EvolutionModelExecutor;
	readonly idempotencyKey: string;
	readonly signal?: AbortSignal;
}

export interface SkillCurationResult {
	readonly status: SkillCurationStatus;
	readonly outlineSet: SkillCandidateOutlineSet;
	readonly candidates: readonly SkillCandidate[];
	readonly failedExpansions: readonly SkillCandidateExpansionFailed[];
	readonly deferredFindings: readonly DeferredSkillCandidateFinding[];
	readonly proceduralInformationLossFindings: readonly ProceduralInformationLossFinding[];
}

export interface SkillCurator {
	curate(input: SkillCuratorInput): Promise<SkillCurationResult>;
}

export interface ProposalValidationInput {
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly instructions: InstructionSnapshot;
	readonly reflection: ReflectionResult;
	readonly proposals: readonly EvolutionProposal[];
	readonly signal?: AbortSignal;
}

export interface ProposalValidator {
	validate(input: ProposalValidationInput): Promise<ValidationReport>;
}

export interface ProposalScoringInput extends ProposalValidationInput {
	readonly validation: ValidationReport;
}

export interface ProposalScorer {
	score(input: ProposalScoringInput): Promise<readonly ScoredProposal[]>;
}

export interface EvolutionArtifactStore {
	put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference>;
	get(reference: EvolutionArtifactReference): Promise<EvolutionArtifact>;
}

export type SkillCandidateRegistryAppendResult = "committed" | "conflict";

export interface SkillCandidateRegistryStore {
	loadSkillCandidateRegistry(scope: EvolutionScope): Promise<SkillCandidateRegistrySnapshot>;
	appendSkillCandidateRegistryEvents(
		scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
		lease?: EvolutionLeaseToken,
	): Promise<SkillCandidateRegistryAppendResult>;
}

export type SkillLifecycleObservationAppendResult = "already-recorded" | "committed";

export interface SkillLifecycleObservationStore {
	appendSkillLifecycleObservation(
		observation: SkillLifecycleObservation,
	): Promise<SkillLifecycleObservationAppendResult>;
	listSkillLifecycleObservations(scope: EvolutionScope): Promise<readonly SkillLifecycleObservation[]>;
}

export interface SkillCandidateRegistryConsolidationInput {
	readonly sourceEvolutionJobId: string;
	readonly lease?: EvolutionLeaseToken;
	readonly input: EvolutionInputSnapshot;
	readonly candidates: readonly {
		readonly candidate: SkillCandidate;
		readonly reference: EvolutionArtifactReference;
	}[];
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly signal?: AbortSignal;
}

export interface SkillCandidateRegistryConsolidationResult {
	readonly groups: readonly SkillCandidateGroup[];
	readonly changedGroupIds: readonly string[];
}

export interface SkillCandidateSynthesisFailureRecordingInput {
	readonly scope: EvolutionScope;
	readonly lease?: EvolutionLeaseToken;
	readonly failures: readonly {
		readonly groupId: string;
		readonly proposalRevisionIds: readonly string[];
		readonly idempotencyKey: string;
		readonly reasonCode: "skill-synthesis-attempts-exhausted" | "skill-synthesis-non-retryable";
	}[];
	readonly createdAt: string;
}

export interface SkillCandidateDraftRecordingInput {
	readonly scope: EvolutionScope;
	readonly lease?: EvolutionLeaseToken;
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
	readonly createdAt: string;
}

export interface SkillCandidateValidationRecordingInput {
	readonly scope: EvolutionScope;
	readonly lease?: EvolutionLeaseToken;
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
	readonly createdAt: string;
}

export interface SkillCandidateEvaluationStartInput {
	readonly scope: EvolutionScope;
	readonly lease?: EvolutionLeaseToken;
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
	readonly createdAt: string;
}

export interface SkillCandidateEvaluationRecordingInput {
	readonly scope: EvolutionScope;
	readonly lease?: EvolutionLeaseToken;
	readonly groupId: string;
	readonly draft: EvolutionArtifactReference;
	readonly validation: EvolutionArtifactReference;
	readonly evaluation: EvolutionArtifactReference;
	readonly proposalRevisionIds: readonly string[];
	readonly idempotencyKey: string;
	readonly createdAt: string;
}

export interface SkillCandidateRegistry {
	consolidate(input: SkillCandidateRegistryConsolidationInput): Promise<SkillCandidateRegistryConsolidationResult>;
	recordSynthesisFailures(
		input: SkillCandidateSynthesisFailureRecordingInput,
	): Promise<readonly SkillCandidateGroup[]>;
	recordDraft(input: SkillCandidateDraftRecordingInput): Promise<SkillCandidateGroup>;
	recordValidation(input: SkillCandidateValidationRecordingInput): Promise<SkillCandidateGroup>;
	skipEvaluation(input: SkillCandidateEvaluationStartInput): Promise<SkillCandidateGroup>;
	startEvaluation(input: SkillCandidateEvaluationStartInput): Promise<SkillCandidateGroup>;
	recordEvaluation(input: SkillCandidateEvaluationRecordingInput): Promise<SkillCandidateGroup>;
	list(scope: EvolutionScope): Promise<readonly SkillCandidateGroup[]>;
}

export interface SkillSynthesizerInput {
	readonly group: SkillCandidateGroup;
	readonly model: SkillSynthesisModelExecutor;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly signal?: AbortSignal;
}

export interface SkillSynthesizer {
	synthesize(input: SkillSynthesizerInput): Promise<SkillDraft>;
}

export interface SkillDraftValidationEnvironment {
	readonly workspace: {
		readonly repositoryId: string;
		readonly directoryId?: string;
	};
	readonly harnessVersion: string;
	readonly skillVersions: readonly {
		readonly skillId: string;
		readonly version: string;
		readonly contentDigest: string;
	}[];
}

export interface SkillDraftValidationEnvironmentSource {
	capture(
		workspace: SkillCandidateGroup["profile"]["workspace"],
		signal?: AbortSignal,
	): Promise<SkillDraftValidationEnvironment>;
}

export interface SkillDraftValidatorInput {
	readonly group: SkillCandidateGroup;
	readonly draft: SkillDraft;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly signal?: AbortSignal;
}

export interface SkillDraftValidator {
	validate(input: SkillDraftValidatorInput): Promise<SkillDraftValidationReport>;
}

export interface SkillEvaluationEnvironment {
	readonly workspace: {
		readonly repositoryId: string;
		readonly directoryId?: string;
	};
	readonly harnessVersion: string;
	readonly skills: readonly SkillEvaluationPoolSkill[];
}

export interface SkillEvaluationCaseSourceInput {
	readonly group: SkillCandidateGroup;
	readonly draft: SkillDraft;
	readonly validation: SkillDraftValidationReport;
	readonly candidates: readonly SkillCandidate[];
	readonly environment: SkillEvaluationEnvironment;
	readonly candidateSkill: SkillEvaluationPoolSkill;
	readonly signal?: AbortSignal;
}

export interface SkillEvaluationCaseSource {
	build(input: SkillEvaluationCaseSourceInput): Promise<readonly SkillEvaluationCase[]>;
}

export interface SkillEvaluationEnvironmentSource {
	capture(
		workspace: SkillCandidateGroup["profile"]["workspace"],
		signal?: AbortSignal,
	): Promise<SkillEvaluationEnvironment>;
}

export interface SkillEvaluationSelectionInput {
	readonly evaluationIdempotencyKey: string;
	readonly harnessVersion: string;
	readonly testCase: SkillEvaluationCase;
	readonly skills: readonly SkillEvaluationPoolSkill[];
	readonly signal?: AbortSignal;
}

export interface SkillEvaluationExecutionInput extends SkillEvaluationSelectionInput {
	readonly arm: "baseline" | "full-pool";
}

export interface SkillEvaluationExecutor {
	readonly configuration: SkillEvaluationRuntimeConfiguration;
	select(input: SkillEvaluationSelectionInput): Promise<SkillRetrievalEvaluationResult>;
	execute(input: SkillEvaluationExecutionInput): Promise<SkillBehaviorEvaluationOutcome>;
}

export interface SkillEvaluatorInput {
	readonly group: SkillCandidateGroup;
	readonly draft: SkillDraft;
	readonly validation: SkillDraftValidationReport;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	readonly signal?: AbortSignal;
}

export interface SkillEvaluator {
	evaluate(input: SkillEvaluatorInput): Promise<SkillEvaluationReport>;
}

export interface EvolutionJobStore {
	create(job: EvolutionJob, lease: EvolutionLeaseToken): Promise<void>;
	save(job: EvolutionJob, expectedRevision: number, lease: EvolutionLeaseToken): Promise<void>;
	load(jobId: string): Promise<EvolutionJob | null>;
	list(scope?: EvolutionScope): Promise<readonly EvolutionJob[]>;
}

export interface EvolutionCancellationRequest {
	readonly jobId: string;
	readonly requestedAt: string;
}

export interface EvolutionCancellationStore {
	requestCancellation(jobId: string, requestedAt: string): Promise<EvolutionCancellationRequest>;
	loadCancellation(jobId: string): Promise<EvolutionCancellationRequest | null>;
}

export type EvolutionCursorCommitResult = "already-committed" | "committed" | "conflict";

export interface EvolutionCursorStore {
	load(scope: EvolutionScope): Promise<EvolutionProcessedEvidenceCursor>;
	commit(
		scope: EvolutionScope,
		expectedSequence: number,
		nextSequence: number,
		jobId: string,
		updatedAt: string,
		lease: EvolutionLeaseToken,
	): Promise<EvolutionCursorCommitResult>;
}

export interface EvolutionLeaseStore {
	assertHeld(lease: EvolutionLeaseToken): Promise<void>;
	acquire(
		kind: EvolutionLeaseToken["kind"],
		key: string,
		ownerId: string,
		now: string,
		ttlMs: number,
	): Promise<EvolutionLeaseToken | null>;
	renew(lease: EvolutionLeaseToken, now: string, ttlMs: number): Promise<EvolutionLeaseToken | null>;
	release(lease: EvolutionLeaseToken): Promise<void>;
}

export interface EvolutionLedger {
	append(event: EvolutionLedgerEvent): Promise<void>;
	read(jobId: string): Promise<readonly EvolutionLedgerEvent[]>;
}

export type EvolutionProgressEvent =
	| {
			readonly jobId: string;
			readonly emittedAt: string;
			readonly type: "checkpoint" | "completed" | "failed" | "started";
			readonly stage: EvolutionJobStage;
			readonly checkpoint?: EvolutionStageCheckpoint;
	  }
	| {
			readonly type: "lesson-grooming";
			readonly active: boolean;
	  };

export interface EvolutionEventSink {
	emit(event: EvolutionProgressEvent): void | Promise<void>;
}

export interface SuccessfulMaterialization {
	readonly materializationId: string;
	readonly ingestionCursor: number;
	readonly origin: "product-runtime";
	readonly contentDigest: string;
	readonly invocation: MaterializedInvocation;
}

export interface EvolutionEvidenceCatalog {
	highWaterCursor(scope: EvolutionScope): Promise<number>;
	listSuccessful(
		scope: EvolutionScope,
		afterCursor: number,
		throughCursor: number,
	): Promise<readonly SuccessfulMaterialization[]>;
	excludedThroughCursor?(scope: EvolutionScope, afterCursor: number, throughCursor: number): Promise<number>;
}

export type EvolutionSkillSnapshotSource = Omit<EvolutionSkillContentSnapshot, "workspace">;

export interface EvolutionSnapshotContext {
	readonly repository: EvolutionRepositorySnapshot;
	readonly harness: ImmutableHarnessSnapshot;
	readonly instructions: readonly InstructionDocumentSnapshot[];
	readonly skills: readonly EvolutionSkillSnapshotSource[];
	readonly modelConfiguration: EvolutionModelIdentity;
	readonly pipelineVersion: string;
	readonly promptVersions: EvolutionPromptVersions;
}

export interface EvolutionSnapshotSource {
	capture(scope: EvolutionScope, signal?: AbortSignal): Promise<EvolutionSnapshotContext>;
}

export interface EvolutionStageExecutionContext {
	readonly job: EvolutionJob;
	readonly input: EvolutionInputSnapshot;
	readonly priorArtifacts: readonly EvolutionArtifact[];
	readonly idempotencyKey: string;
	readonly scopeLease: EvolutionLeaseToken;
	readonly writerLease: EvolutionLeaseToken | null;
	readonly signal?: AbortSignal;
}

export type EvolutionStageDirective = "complete-activated" | "complete-no-op" | "continue";

export interface EvolutionStageExecutionResult {
	readonly artifacts: readonly EvolutionArtifact[];
	readonly ledgerEvents?: readonly EvolutionLedgerEvent[];
	readonly state: JsonObject;
	readonly directive: EvolutionStageDirective;
	readonly resultingHarnessVersion?: string;
}

export interface EvolutionStageExecutor {
	execute(context: EvolutionStageExecutionContext): Promise<EvolutionStageExecutionResult>;
}

export interface EvolutionJobCreationRequest {
	readonly scope: EvolutionScope;
	readonly trigger: EvolutionTriggerKind;
	readonly signal?: AbortSignal;
}

export interface EvolutionJobRunner {
	runJob(jobId: string, signal?: AbortSignal): Promise<EvolutionJob>;
}

export interface EvolutionWorkSource {
	nextRunnableJob(now: string, signal?: AbortSignal): Promise<string | null>;
	waitForWork(signal: AbortSignal): Promise<void>;
}

export interface InteractivePriorityGate {
	waitUntilBackgroundAllowed(signal: AbortSignal): Promise<void>;
}
