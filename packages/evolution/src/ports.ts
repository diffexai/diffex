import type {
	EvidenceCorpusManifest,
	EvolutionCheckpoint,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionLedgerEvent,
	EvolutionProposal,
	InstructionSnapshot,
	JsonObject,
	Lesson,
	MutationBatch,
	ReflectionNode,
	ScoredProposal,
	ValidationReport,
} from "./contracts.ts";

export type EvolutionArtifact =
	| EvidenceCorpusManifest
	| EvolutionInputSnapshot
	| EvolutionProposal
	| InstructionSnapshot
	| Lesson
	| MutationBatch
	| ReflectionNode
	| ScoredProposal
	| ValidationReport;

export interface EvolutionClock {
	now(): string;
}

export interface EvolutionIdGenerator {
	nextId(kind: string): string;
}

export interface EvolutionModelRequest {
	readonly stage: "curator" | "reflector";
	readonly promptVersion: string;
	readonly input: JsonObject;
}

export interface EvolutionModelResponse {
	readonly output: JsonObject;
	readonly model: {
		readonly provider: string;
		readonly model: string;
	};
}

export interface EvolutionModelExecutor {
	execute(request: EvolutionModelRequest): Promise<EvolutionModelResponse>;
}

export interface InstructionLoader {
	load(input: EvolutionInputSnapshot): Promise<InstructionSnapshot>;
}

export interface ReflectorInput {
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly instructions: InstructionSnapshot;
	readonly model: EvolutionModelExecutor;
}

export interface ReflectionResult {
	readonly nodes: readonly ReflectionNode[];
	readonly lessons: readonly Lesson[];
}

export interface Reflector {
	reflect(input: ReflectorInput): Promise<ReflectionResult>;
}

export interface CuratorInput {
	readonly input: EvolutionInputSnapshot;
	readonly corpus: EvidenceCorpusManifest;
	readonly instructions: InstructionSnapshot;
	readonly reflection: ReflectionResult;
	readonly model: EvolutionModelExecutor;
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
	put(artifact: EvolutionArtifact): Promise<void>;
}

export interface EvolutionJobStore {
	create(job: EvolutionJob): Promise<void>;
	save(job: EvolutionJob): Promise<void>;
	load(jobId: string): Promise<EvolutionJob | null>;
}

export interface EvolutionLedger {
	append(event: EvolutionLedgerEvent): Promise<void>;
	read(jobId: string): Promise<readonly EvolutionLedgerEvent[]>;
}

export interface EvolutionProgressEvent {
	readonly jobId: string;
	readonly emittedAt: string;
	readonly type: "checkpoint" | "failed" | "started";
	readonly checkpoint: EvolutionCheckpoint;
}

export interface EvolutionEventSink {
	emit(event: EvolutionProgressEvent): void | Promise<void>;
}
