import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifact,
	type EvolutionArtifactMetadata,
	type EvolutionArtifactProducer,
	type EvolutionEventSink,
	type EvolutionInputSnapshot,
	type EvolutionJob,
	type EvolutionLedgerEvent,
	type EvolutionMemoryProposal,
	type EvolutionModelRequest,
	EvolutionPipeline,
	type EvolutionProgressEvent,
	type EvolutionProposal,
	type EvolutionScope,
	EvolutionTargetAdapterRegistry,
	type EvolutionTargetWriter,
	type InstructionSnapshot,
	type Lesson,
	type MutationBatch,
	type MutationWriteResult,
	type ReflectionNode,
	type ScoredProposal,
	type ValidationReport,
} from "../src/index.ts";

const FIRST_HARNESS_VERSION = `sha256:${"1".repeat(64)}`;
const SECOND_HARNESS_VERSION = `sha256:${"2".repeat(64)}`;
const CREATED_AT = "2026-08-19T12:00:00.000Z";
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const pipelineProducer: EvolutionArtifactProducer = {
	name: "diffex-evolution",
	version: "1.0.0",
	promptVersion: null,
	model: null,
};
const reflectorProducer: EvolutionArtifactProducer = {
	name: "reflector",
	version: "1.0.0",
	promptVersion: "reflector-v1",
	model: { provider: "faux", model: "fixture", configurationDigest: `sha256:${"3".repeat(64)}` },
};
const curatorProducer: EvolutionArtifactProducer = {
	name: "curator",
	version: "1.0.0",
	promptVersion: "curator-v1",
	model: { provider: "faux", model: "fixture", configurationDigest: `sha256:${"3".repeat(64)}` },
};

function metadata(
	artifactId: string,
	producer: EvolutionArtifactProducer,
	sourceIds: readonly string[],
	content: unknown,
): EvolutionArtifactMetadata {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt: CREATED_AT, content });
}

function invocation(traceId: string): MaterializedInvocation {
	return {
		version: 1,
		tracePath: `/traces/${traceId}.jsonl`,
		traceId,
		producer: null,
		integrity: "complete",
		terminationStatus: "completed",
		health: null,
		ordering: {
			criteria: ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"],
			ambiguity: [],
		},
		evidence: [],
		diagnostics: [],
	};
}

function inputSnapshot(): EvolutionInputSnapshot {
	const productInvocation = invocation("product-trace");
	const evolutionInvocation = invocation("evolution-trace");
	const content = {
		harnessVersion: FIRST_HARNESS_VERSION,
		evidenceSourceIds: ["source-product", "source-evolution"],
	};
	return {
		metadata: metadata("input-1", pipelineProducer, ["source-product", "source-evolution"], content),
		harness: {
			harnessVersion: FIRST_HARNESS_VERSION,
			baseVersion: null,
			memory: "# Evolution memory\n",
			memoryContentDigest: computeEvolutionContentDigest("# Evolution memory\n"),
		},
		evidenceSources: [
			{
				sourceId: "source-product",
				origin: "product-runtime",
				contentDigest: computeEvolutionContentDigest(productInvocation),
				invocation: productInvocation,
			},
			{
				sourceId: "source-evolution",
				origin: "evolution-pipeline",
				contentDigest: computeEvolutionContentDigest(evolutionInvocation),
				invocation: evolutionInvocation,
			},
		],
	};
}

class SequenceIds {
	#next = 1;

	nextId(kind: string): string {
		const value = `${kind}-${this.#next}`;
		this.#next += 1;
		return value;
	}
}

class FixedClock {
	now(): string {
		return CREATED_AT;
	}
}

interface RecordingState {
	readonly modelStages: EvolutionModelRequest["stage"][];
	readonly artifacts: EvolutionArtifact[];
	readonly createdJobs: EvolutionJob[];
	readonly savedJobs: EvolutionJob[];
	readonly ledger: EvolutionLedgerEvent[];
	readonly progress: EvolutionProgressEvent[];
	readonly writtenBatches: MutationBatch[];
}

function instructionSnapshot(input: EvolutionInputSnapshot): InstructionSnapshot {
	const documents = [
		{
			path: "/repo/AGENTS.md",
			precedence: 1,
			content: "Preserve source provenance.",
			contentDigest: computeEvolutionContentDigest("Preserve source provenance."),
		},
	];
	return {
		metadata: metadata("instructions-1", pipelineProducer, [input.metadata.artifactId], documents),
		documents,
	};
}

function reflectionArtifacts(): { readonly node: ReflectionNode; readonly lesson: Lesson } {
	const lesson: Lesson = {
		metadata: metadata("lesson-1", reflectorProducer, ["source-product"], { summary: "Keep narrow deltas" }),
		lessonId: "lesson-1",
		kind: "strategy",
		summary: "Keep narrow deltas",
		evidenceIds: [],
		counterevidenceIds: [],
		scope,
		uncertainty: null,
	};
	const node: ReflectionNode = {
		metadata: metadata("reflection-1", reflectorProducer, ["source-product"], { lessonIds: [lesson.lessonId] }),
		nodeId: "reflection-1",
		parentNodeId: null,
		childNodeIds: [],
		evidenceIds: [],
		lessonIds: [lesson.lessonId],
		status: "complete",
	};
	return { node, lesson };
}

function proposals(): readonly EvolutionProposal[] {
	const actionable = (proposalId: string, payload: string): EvolutionMemoryProposal => ({
		metadata: metadata(proposalId, curatorProducer, ["lesson-1"], { payload }),
		proposalId,
		summary: payload,
		lessonIds: ["lesson-1"],
		evidenceIds: [],
		disposition: "actionable",
		target: { kind: "evolution-memory", expectedHarnessVersion: FIRST_HARNESS_VERSION },
		executablePayload: { content: payload },
	});
	return [
		actionable("proposal-applied", "Append one focused memory entry"),
		{
			metadata: metadata("proposal-deferred", curatorProducer, ["lesson-1"], { finding: "Improve a skill" }),
			proposalId: "proposal-deferred",
			summary: "Improve a skill",
			lessonIds: ["lesson-1"],
			evidenceIds: [],
			disposition: "deferred",
			target: { kind: "skill", skillName: "review" },
			finding: "A future skill adapter could apply this finding",
		},
		actionable("proposal-rejected", "Unverified memory entry"),
	];
}

function validationReport(inputProposals: readonly EvolutionProposal[]): ValidationReport {
	const proposalResults = inputProposals.map((proposal) => ({
		proposalId: proposal.proposalId,
		disposition:
			proposal.proposalId === "proposal-applied"
				? ("accepted" as const)
				: proposal.disposition === "deferred"
					? ("deferred" as const)
					: ("rejected" as const),
		issues: [],
	}));
	return {
		metadata: metadata(
			"validation-1",
			pipelineProducer,
			inputProposals.map((proposal) => proposal.proposalId),
			{
				proposalResults,
			},
		),
		proposalResults,
	};
}

function scoredProposals(inputProposals: readonly EvolutionProposal[]): readonly ScoredProposal[] {
	return inputProposals.map((proposal) => {
		const disposition =
			proposal.proposalId === "proposal-applied"
				? ("selected" as const)
				: proposal.disposition === "deferred"
					? ("deferred" as const)
					: ("rejected" as const);
		return {
			metadata: metadata(`score-${proposal.proposalId}`, pipelineProducer, [proposal.proposalId], { disposition }),
			proposal,
			score: disposition === "selected" ? 80 : null,
			disposition,
			reasonCodes: [disposition],
		};
	});
}

function recordingPipeline(writeStatus: MutationWriteResult["status"] = "applied"): {
	readonly pipeline: EvolutionPipeline;
	readonly state: RecordingState;
} {
	const state: RecordingState = {
		modelStages: [],
		artifacts: [],
		createdJobs: [],
		savedJobs: [],
		ledger: [],
		progress: [],
		writtenBatches: [],
	};
	const writer: EvolutionTargetWriter = {
		kind: "evolution-memory",
		async write(batch) {
			state.writtenBatches.push(batch);
			return {
				batchId: batch.batchId,
				status: writeStatus,
				resultingHarnessVersion: writeStatus === "applied" ? SECOND_HARNESS_VERSION : null,
				message: writeStatus === "failed" ? "fixture writer failure" : null,
			};
		},
	};
	const events: EvolutionEventSink = {
		emit(event) {
			state.progress.push(event);
		},
	};
	const pipeline = new EvolutionPipeline({
		version: "1.0.0",
		clock: new FixedClock(),
		ids: new SequenceIds(),
		model: {
			async execute(request) {
				state.modelStages.push(request.stage);
				return { output: { accepted: true }, model: { provider: "faux", model: "fixture" } };
			},
		},
		instructions: {
			async load(input) {
				return instructionSnapshot(input);
			},
		},
		reflector: {
			async reflect(input) {
				await input.model.execute({ stage: "reflector", promptVersion: "reflector-v1", input: {} });
				const { node, lesson } = reflectionArtifacts();
				return { nodes: [node], lessons: [lesson] };
			},
		},
		curator: {
			async curate(input) {
				await input.model.execute({ stage: "curator", promptVersion: "curator-v1", input: {} });
				return proposals();
			},
		},
		validator: {
			async validate(input) {
				return validationReport(input.proposals);
			},
		},
		scorer: {
			async score(input) {
				return scoredProposals(input.proposals);
			},
		},
		artifacts: {
			async put(artifact) {
				state.artifacts.push(artifact);
			},
		},
		jobs: {
			async create(job) {
				state.createdJobs.push(job);
			},
			async save(job) {
				state.savedJobs.push(job);
			},
			async load(jobId) {
				return [...state.createdJobs, ...state.savedJobs].filter((job) => job.jobId === jobId).at(-1) ?? null;
			},
		},
		ledger: {
			async append(event) {
				state.ledger.push(event);
			},
			async read(jobId) {
				return state.ledger.filter((event) => event.jobId === jobId);
			},
		},
		events,
		targets: new EvolutionTargetAdapterRegistry({ writers: [writer] }),
	});
	return { pipeline, state };
}

describe("evolution pipeline", () => {
	it("orchestrates isolated stages and writes only enabled memory proposals", async () => {
		const { pipeline, state } = recordingPipeline();
		const result = await pipeline.run(inputSnapshot());

		expect(state.modelStages).toEqual(["reflector", "curator"]);
		expect(state.savedJobs.map((job) => job.checkpoint.stage)).toEqual([
			"corpus-prepared",
			"reflected",
			"curated",
			"validated",
			"scored",
			"written",
			"completed",
		]);
		expect(result.corpus.documents.map((document) => document.sourceId)).toEqual(["source-product"]);
		expect(result.corpus.excludedSources).toEqual([
			{ sourceId: "source-evolution", reason: "evolution-pipeline-origin" },
		]);
		expect(state.writtenBatches).toHaveLength(1);
		expect(state.writtenBatches[0]?.mutations.map((mutation) => mutation.proposalId)).toEqual(["proposal-applied"]);
		expect(result.job.status).toBe("completed");
		expect(result.job.checkpoint).toEqual({
			schemaVersion: 1,
			stage: "completed",
			resultingHarnessVersion: SECOND_HARNESS_VERSION,
		});

		const dispositions = state.ledger
			.filter((event) => event.type === "proposal-disposition")
			.map((event) => [event.proposalId, event.disposition]);
		expect(dispositions).toEqual([
			["proposal-deferred", "deferred"],
			["proposal-rejected", "rejected"],
			["proposal-applied", "applied"],
		]);
		expect(state.artifacts.map((artifact) => artifact.metadata.artifactId)).toContain("input-1");
		expect(state.artifacts.map((artifact) => artifact.metadata.artifactId)).toContain("lesson-1");
		expect(state.artifacts.map((artifact) => artifact.metadata.artifactId)).toContain("proposal-applied");
	});

	it("records writer failure without converting deferred findings into mutations", async () => {
		const { pipeline, state } = recordingPipeline("failed");

		await expect(pipeline.run(inputSnapshot())).rejects.toThrow("fixture writer failure");
		expect(state.savedJobs.at(-1)?.checkpoint).toMatchObject({ stage: "failed", failedStage: "written" });
		expect(state.writtenBatches[0]?.mutations.map((mutation) => mutation.proposalId)).toEqual(["proposal-applied"]);
		expect(
			state.ledger
				.filter((event) => event.type === "proposal-disposition")
				.find((event) => event.proposalId === "proposal-applied"),
		).toMatchObject({ disposition: "failed", reasonCodes: ["writer-failed"] });
		expect(state.ledger.at(-1)).toMatchObject({ type: "job-failed", failedStage: "written" });
	});

	it("produces identical artifacts for identical inputs and injected determinism", async () => {
		const first = await recordingPipeline().pipeline.run(inputSnapshot());
		const second = await recordingPipeline().pipeline.run(inputSnapshot());

		expect(first.corpus).toEqual(second.corpus);
		expect(first.mutationBatch).toEqual(second.mutationBatch);
		expect(first.job).toEqual(second.job);
	});

	it("keeps non-memory writers disabled by default and rejects duplicates", () => {
		const memoryWriter: EvolutionTargetWriter = {
			kind: "evolution-memory",
			async write(batch) {
				return { batchId: batch.batchId, status: "applied", resultingHarnessVersion: null, message: null };
			},
		};
		const registry = new EvolutionTargetAdapterRegistry({ writers: [memoryWriter] });

		expect(registry.isEnabled("evolution-memory")).toBe(true);
		expect(registry.isEnabled("skill")).toBe(false);
		expect(() => registry.register(memoryWriter)).toThrow("already registered");
		expect(() =>
			registry.register({
				kind: "skill",
				async write(batch) {
					return { batchId: batch.batchId, status: "applied", resultingHarnessVersion: null, message: null };
				},
			}),
		).toThrow('Evolution target "skill" is not enabled');
	});

	it("does not import product-specific runtime packages", async () => {
		const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "../src");
		const sourceFiles = ["contracts.ts", "index.ts", "pipeline.ts", "ports.ts", "provenance.ts", "targets.ts"];
		const source = (await Promise.all(sourceFiles.map((file) => readFile(join(sourceDirectory, file), "utf8")))).join(
			"\n",
		);

		expect(source).not.toMatch(/from ["'][^"']*(?:coding-agent|diffex-tui|agent-core|session|extension)[^"']*["']/);
	});
});
