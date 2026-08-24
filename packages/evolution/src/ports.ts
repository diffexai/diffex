import type { MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type {
	CounterReport,
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
	ReflectionNode,
	ScoredProposal,
	ValidationReport,
} from "./contracts.ts";

export type EvolutionArtifact =
	| CounterReport
	| EvidenceCoverageMap
	| EvidenceCorpusManifest
	| EvolutionInputSnapshot
	| EvolutionProposal
	| HarnessActivationReceipt
	| InstructionSnapshot
	| Lesson
	| MutationBatch
	| MutationWriteReceipt
	| ReflectionNode
	| ScoredProposal
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
	readonly signal?: AbortSignal;
}

export type EvolutionModelRequest = CuratorModelRequest | ReflectorModelRequest;

export interface EvolutionModelResponse {
	readonly output: JsonObject;
	readonly submissionMethod?: "json-text" | "response-tool";
	readonly model: {
		readonly provider: string;
		readonly model: string;
	};
}

export interface EvolutionModelExecutor {
	execute(request: EvolutionModelRequest): Promise<EvolutionModelResponse>;
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

export interface EvolutionJobStore {
	create(job: EvolutionJob, lease: EvolutionLeaseToken): Promise<void>;
	save(job: EvolutionJob, expectedRevision: number, lease: EvolutionLeaseToken): Promise<void>;
	load(jobId: string): Promise<EvolutionJob | null>;
	list(scope?: EvolutionScope): Promise<readonly EvolutionJob[]>;
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

export interface EvolutionProgressEvent {
	readonly jobId: string;
	readonly emittedAt: string;
	readonly type: "checkpoint" | "completed" | "failed" | "started";
	readonly stage: EvolutionJobStage;
	readonly checkpoint?: EvolutionStageCheckpoint;
}

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

export interface EvolutionSnapshotContext {
	readonly repository: EvolutionRepositorySnapshot;
	readonly harness: ImmutableHarnessSnapshot;
	readonly instructions: readonly InstructionDocumentSnapshot[];
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
