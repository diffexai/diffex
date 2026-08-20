import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTOMATIC_EVOLUTION_COOLDOWN_MS,
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	EVOLUTION_TOKEN_ESTIMATOR_VERSION,
	type EvolutionArtifactProducer,
	EvolutionControlPlane,
	type EvolutionEventSink,
	type EvolutionJobStage,
	type EvolutionMemoryProposal,
	EvolutionPipeline,
	type EvolutionProgressEvent,
	type EvolutionScope,
	type EvolutionSnapshotContext,
	type EvolutionStageExecutionContext,
	type EvolutionStageExecutionResult,
	type EvolutionStageExecutor,
	EvolutionTargetAdapterRegistry,
	type EvolutionTargetWriter,
	evaluateAutomaticEvolutionEligibility,
	FileEvolutionPersistence,
	type Lesson,
	type ReflectionNode,
	type ScoredProposal,
	type SuccessfulMaterialization,
	type ValidationReport,
} from "../src/index.ts";

const FIRST_HARNESS_VERSION = `sha256:${"1".repeat(64)}`;
const SECOND_HARNESS_VERSION = `sha256:${"2".repeat(64)}`;
const MODEL_CONFIGURATION_DIGEST = `sha256:${"3".repeat(64)}`;
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class SequenceIds {
	#next = 1;

	nextId(kind: string): string {
		const value = `${kind}-${this.#next}`;
		this.#next += 1;
		return value;
	}
}

class AdvancingClock {
	#now = Date.now();

	now(): string {
		const value = new Date(this.#now).toISOString();
		this.#now += 1;
		return value;
	}

	advance(milliseconds: number): void {
		this.#now += milliseconds;
	}
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

function materialization(sequence: number): SuccessfulMaterialization {
	const materialized = invocation(`trace-${sequence}`);
	return {
		materializationId: `materialization-${sequence}`,
		ingestionCursor: sequence,
		origin: "product-runtime",
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
}

function snapshotContext(): EvolutionSnapshotContext {
	const memory = "# Evolution memory\n";
	const instruction = "Preserve exact provenance.\n";
	return {
		repository: { repositoryId: "diffex", rootPath: "/repo", revision: "abc123" },
		harness: {
			harnessVersion: FIRST_HARNESS_VERSION,
			baseVersion: null,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [],
		},
		instructions: [
			{
				path: "/repo/AGENTS.md",
				precedence: 1,
				content: instruction,
				contentDigest: computeEvolutionContentDigest(instruction),
			},
		],
		modelConfiguration: {
			provider: "faux",
			model: "fixture",
			configurationDigest: MODEL_CONFIGURATION_DIGEST,
		},
		pipelineVersion: "pipeline-v1",
		promptVersions: {
			reflector: "reflector-v1",
			curator: "curator-v1",
			validator: "validator-v1",
			writer: "writer-v1",
		},
	};
}

const EXECUTABLE_STAGES = [
	"snapshotting",
	"counter-slot",
	"reflecting",
	"curating",
	"validating",
	"writing",
	"activating",
] as const satisfies readonly EvolutionJobStage[];

class RecordingExecutor implements EvolutionStageExecutor {
	readonly calls = new Map<EvolutionJobStage, string[]>();
	readonly logicalEffects = new Set<string>();
	readonly #crashStage: EvolutionJobStage | null;
	readonly #noOp: boolean;
	#crashed = false;

	constructor(options: { readonly crashStage?: EvolutionJobStage; readonly noOp?: boolean } = {}) {
		this.#crashStage = options.crashStage ?? null;
		this.#noOp = options.noOp ?? false;
	}

	async execute(context: EvolutionStageExecutionContext): Promise<EvolutionStageExecutionResult> {
		const calls = this.calls.get(context.job.stage) ?? [];
		calls.push(context.idempotencyKey);
		this.calls.set(context.job.stage, calls);
		this.logicalEffects.add(context.idempotencyKey);
		if (context.job.stage === "writing" || context.job.stage === "activating") {
			expect(context.writerLease).not.toBeNull();
		}
		if (context.job.stage === this.#crashStage && !this.#crashed) {
			this.#crashed = true;
			throw new Error(`simulated crash during ${context.job.stage}`);
		}
		if (context.job.stage === "validating" && this.#noOp) {
			return { artifacts: [], state: { acceptedProposalIds: [] }, directive: "complete-no-op" };
		}
		if (context.job.stage === "activating") {
			return {
				artifacts: [],
				state: { activation: "fixture" },
				directive: "complete-activated",
				resultingHarnessVersion: SECOND_HARNESS_VERSION,
			};
		}
		return { artifacts: [], state: { stage: context.job.stage }, directive: "continue" };
	}
}

interface ControlPlaneFixture<TExecutor extends EvolutionStageExecutor = EvolutionStageExecutor> {
	readonly clock: AdvancingClock;
	readonly controlPlane: EvolutionControlPlane;
	readonly events: EvolutionProgressEvent[];
	readonly executor: TExecutor;
	readonly persistence: FileEvolutionPersistence;
}

async function controlPlaneFixture<TExecutor extends EvolutionStageExecutor>(
	executor: TExecutor,
	materializations: readonly SuccessfulMaterialization[] = [
		materialization(1),
		materialization(2),
		materialization(3),
	],
): Promise<ControlPlaneFixture<TExecutor>> {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-control-"));
	temporaryDirectories.push(root);
	const persistence = new FileEvolutionPersistence(root);
	const clock = new AdvancingClock();
	const events: EvolutionProgressEvent[] = [];
	const eventSink: EvolutionEventSink = {
		emit(event) {
			events.push(event);
		},
	};
	const controlPlane = new EvolutionControlPlane(
		{
			version: "1.0.0",
			clock,
			ids: new SequenceIds(),
			artifacts: persistence,
			jobs: persistence,
			cursors: persistence,
			leases: persistence,
			ledger: persistence,
			events: eventSink,
			evidence: {
				async highWaterCursor() {
					return materializations.at(-1)?.ingestionCursor ?? 0;
				},
				async listSuccessful(_scope, afterCursor, throughCursor) {
					return materializations.filter(
						(item) => item.ingestionCursor > afterCursor && item.ingestionCursor <= throughCursor,
					);
				},
			},
			snapshots: {
				async capture() {
					return snapshotContext();
				},
			},
			executor,
		},
		{ leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000, retryBaseDelayMs: 0, retryMaxDelayMs: 0 },
	);
	return { clock, controlPlane, events, executor, persistence };
}

async function createManualJob(fixture: ControlPlaneFixture) {
	const result = await fixture.controlPlane.createJob({ scope, trigger: "manual" });
	expect(result.status).toBe("created");
	if (result.status !== "created") throw new Error("Expected a created fixture job");
	return result.job;
}

describe("durable evolution control plane", () => {
	it.each(EXECUTABLE_STAGES)("resumes %s with stable idempotency and one completion", async (crashStage) => {
		const fixture = await controlPlaneFixture(new RecordingExecutor({ crashStage }));
		const created = await createManualJob(fixture);

		await expect(fixture.controlPlane.runJob(created.jobId)).rejects.toThrow(`simulated crash during ${crashStage}`);
		const failed = await fixture.persistence.load(created.jobId);
		expect(failed).toMatchObject({ outcome: "retryable-failed", stage: crashStage });

		fixture.clock.advance(1);
		const completed = await fixture.controlPlane.runJob(created.jobId);
		expect(completed.outcome).toBe("completed");
		expect(completed.completion).toEqual({
			kind: "activated",
			resultingHarnessVersion: SECOND_HARNESS_VERSION,
			processedEvidenceCursor: 3,
		});
		expect(completed.checkpoints.map((checkpoint) => checkpoint.stage)).toEqual(EXECUTABLE_STAGES);
		expect(new Set(fixture.executor.calls.get(crashStage)).size).toBe(1);
		expect(fixture.executor.calls.get(crashStage)).toHaveLength(2);
		expect(fixture.executor.logicalEffects.size).toBe(EXECUTABLE_STAGES.length);
		expect(await fixture.persistence.load(scope)).toMatchObject({ sequence: 3, committedByJobId: created.jobId });
		expect(
			(await fixture.persistence.read(created.jobId)).filter((event) => event.type === "job-completed"),
		).toHaveLength(1);
	});

	it("advances the cursor for a validated no-op without writing or activating", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor({ noOp: true }));
		const created = await createManualJob(fixture);

		const completed = await fixture.controlPlane.runJob(created.jobId);

		expect(completed.completion).toEqual({
			kind: "no-op",
			resultingHarnessVersion: null,
			processedEvidenceCursor: 3,
		});
		expect(completed.checkpoints.map((checkpoint) => checkpoint.stage)).toEqual(EXECUTABLE_STAGES.slice(0, 5));
		expect(fixture.executor.calls.has("writing")).toBe(false);
		expect(fixture.executor.calls.has("activating")).toBe(false);
	});

	it("blocks overlapping jobs until the frozen range is explicitly superseded", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor());
		const first = await createManualJob(fixture);

		await expect(fixture.controlPlane.createJob({ scope, trigger: "manual" })).resolves.toEqual({
			status: "not-created",
			reason: "blocking-job",
			blockingJobId: first.jobId,
		});
		await fixture.controlPlane.supersedeJob(first.jobId);
		const replacement = await fixture.controlPlane.createJob({ scope, trigger: "manual" });
		expect(replacement.status).toBe("created");
	});

	it("reports no evidence instead of creating an empty manual job", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor(), []);

		await expect(fixture.controlPlane.createJob({ scope, trigger: "manual" })).resolves.toEqual({
			status: "not-created",
			reason: "no-new-evidence",
		});
		expect(await fixture.persistence.list(scope)).toEqual([]);
	});

	it("records the deterministic estimator and rejects a small automatic corpus", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor());
		await expect(fixture.controlPlane.createJob({ scope, trigger: "automatic" })).resolves.toEqual({
			status: "not-created",
			reason: "insufficient-tokens",
		});

		const created = await createManualJob(fixture);
		const snapshot = await fixture.persistence.get(created.inputSnapshot);
		expect(snapshot).toMatchObject({
			tokenMeasurement: {
				estimatorVersion: EVOLUTION_TOKEN_ESTIMATOR_VERSION,
				estimatedTokens: expect.any(Number),
			},
		});
	});
});

describe("checkpointed evolution pipeline", () => {
	it("executes isolated stages through writing and activation", async () => {
		const artifactProducer: EvolutionArtifactProducer = {
			name: "fixture-stage",
			version: "1.0.0",
			promptVersion: "fixture-v1",
			model: {
				provider: "faux",
				model: "fixture",
				configurationDigest: MODEL_CONFIGURATION_DIGEST,
			},
		};
		const metadata = (artifactId: string, sourceIds: readonly string[], content: unknown) =>
			createEvolutionArtifactMetadata({
				artifactId,
				producer: artifactProducer,
				sourceIds,
				scope,
				createdAt: "2026-08-19T12:00:00.000Z",
				content,
			});
		const modelKeys: string[] = [];
		const reflectorCounterReports: unknown[] = [];
		const writeKeys = new Set<string>();
		const activationKeys = new Set<string>();
		const target: EvolutionTargetWriter = {
			kind: "evolution-memory",
			async write(batch, context) {
				writeKeys.add(context.idempotencyKey);
				return {
					batchId: batch.batchId,
					status: "written",
					output: { candidateDigest: computeEvolutionContentDigest(batch) },
					message: null,
				};
			},
			async activate(batch, _writeResult, context) {
				activationKeys.add(context.idempotencyKey);
				return {
					batchId: batch.batchId,
					status: "activated",
					resultingHarnessVersion: SECOND_HARNESS_VERSION,
					message: null,
				};
			},
		};
		const pipeline = new EvolutionPipeline({
			version: "1.0.0",
			model: {
				async execute(request) {
					modelKeys.push(request.idempotencyKey);
					return { output: { accepted: true }, model: { provider: "faux", model: "fixture" } };
				},
			},
			reflector: {
				async reflect(input) {
					reflectorCounterReports.push(input.counterReport);
					await input.model.execute({
						stage: "reflector",
						promptVersion: "reflector-v1",
						idempotencyKey: input.idempotencyKey,
						input: {},
						tools: [],
						signal: input.signal,
					});
					const lesson: Lesson = {
						metadata: metadata("lesson-1", ["materialization-1"], { summary: "Keep narrow changes" }),
						lessonId: "lesson-1",
						kind: "successful-strategy",
						summary: "Keep narrow changes",
						preconditions: [],
						observedOutcome: "The change remains focused",
						evidenceIds: [],
						counterevidenceIds: [],
						scope,
						applicabilityBoundaries: [],
						uncertainty: null,
						actionableTakeaway: "Keep changes narrow",
					};
					const node: ReflectionNode = {
						metadata: metadata("reflection-1", [lesson.lessonId], { lessonIds: [lesson.lessonId] }),
						nodeId: "reflection-1",
						kind: "leaf",
						depth: 0,
						parentNodeId: null,
						childNodeIds: [],
						sliceIds: [],
						evidenceIds: [],
						lessonIds: [lesson.lessonId],
						resultDigest: computeEvolutionContentDigest({ lessonIds: [lesson.lessonId] }),
						status: "complete",
					};
					const coverageContent = {
						manifestDigest: input.corpus.metadata.contentDigest,
						entries: [],
						rootNodeIds: [node.nodeId],
						finalLessonIds: [lesson.lessonId],
					};
					return {
						nodes: [node],
						lessons: [lesson],
						coverage: {
							metadata: metadata("coverage-1", [node.nodeId], coverageContent),
							...coverageContent,
						},
						finalLessonIds: [lesson.lessonId],
					};
				},
			},
			curator: {
				async curate(input) {
					await input.model.execute({
						stage: "curator",
						promptVersion: "curator-v1",
						idempotencyKey: input.idempotencyKey,
						input: {},
						outputSchema: {},
						signal: input.signal,
					});
					const exactDelta = {
						operation: "ADD" as const,
						destination: { section: "Focused guidance", anchor: null },
						content: "Append one focused rule",
						intendedScope: ["repository"],
					};
					const proposal: EvolutionMemoryProposal = {
						metadata: metadata("proposal-1", ["lesson-1"], exactDelta),
						proposalId: "proposal-1",
						summary: "Append one focused rule",
						scope: {
							repository: scope,
							repositoryRevision: "abc123",
							materializationIds: [],
							traceIds: [],
							sessionIds: [],
							taskLineageIds: [],
							runtimeKinds: [],
							runtimeVersions: [],
							sourceRevisions: [],
							harnessVersions: [FIRST_HARNESS_VERSION],
							applicabilityBoundaries: [],
						},
						lessonIds: ["lesson-1"],
						supportingEvidenceIds: [],
						contradictingEvidenceIds: [],
						supportingTraceIds: [],
						contradictingTraceIds: [],
						expectedBenefit: "Keep future changes focused",
						acceptanceCriterion: "The memory contains the focused rule",
						risk: "The rule may be too broad",
						rollbackDescription: "Remove the added memory item",
						curatorConfidence: 0.9,
						uncertainty: null,
						counterexamples: [],
						conflictingProposalIds: [],
						instructionRelationship: {
							classification: "novel",
							relevantEntries: [],
							strengthening: null,
						},
						disposition: "actionable",
						target: { kind: "evolution-memory", expectedHarnessVersion: FIRST_HARNESS_VERSION },
						action: "ADD",
						exactDelta,
						expectedBaseDigest: computeEvolutionContentDigest("# Evolution memory\n"),
					};
					return [proposal];
				},
			},
			validator: {
				async validate(input) {
					const proposalResults = input.proposals.map((proposal) => ({
						proposalId: proposal.proposalId,
						disposition: "accepted" as const,
						issues: [],
					}));
					const report: ValidationReport = {
						metadata: metadata(
							"validation-1",
							input.proposals.map((proposal) => proposal.proposalId),
							{
								proposalResults,
							},
						),
						proposalResults,
					};
					return report;
				},
			},
			scorer: {
				async score(input) {
					return input.proposals.map(
						(proposal): ScoredProposal => ({
							metadata: metadata(`score-${proposal.proposalId}`, [proposal.proposalId], {
								disposition: "selected",
							}),
							proposal,
							score: 100,
							disposition: "selected",
							reasonCodes: ["selected"],
						}),
					);
				},
			},
			targets: new EvolutionTargetAdapterRegistry({ writers: [target] }),
		});
		const fixture = await controlPlaneFixture(pipeline);
		const created = await createManualJob(fixture);

		const completed = await fixture.controlPlane.runJob(created.jobId);

		expect(completed.outcome).toBe("completed");
		const counterCheckpoint = completed.checkpoints.find((checkpoint) => checkpoint.stage === "counter-slot");
		expect(counterCheckpoint).toMatchObject({ outputArtifacts: [], state: {} });
		expect(reflectorCounterReports).toEqual([null]);
		expect(modelKeys).toHaveLength(2);
		expect(new Set(modelKeys).size).toBe(2);
		expect(writeKeys.size).toBe(1);
		expect(activationKeys.size).toBe(1);
		expect(
			(await fixture.persistence.read(created.jobId))
				.filter((event) => event.type === "proposal-disposition")
				.map((event) => [event.proposalId, event.disposition]),
		).toEqual([["proposal-1", "applied"]]);
	});
});

describe("automatic evolution policy", () => {
	it("requires a strict token threshold and at least three invocations", () => {
		expect(
			evaluateAutomaticEvolutionEligibility({
				invocationCount: 3,
				estimatedTokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
				now: "2026-08-19T12:00:00.000Z",
				previousAutomaticTerminalAt: null,
			}),
		).toEqual({ eligible: false, reason: "insufficient-tokens" });
		expect(
			evaluateAutomaticEvolutionEligibility({
				invocationCount: 2,
				estimatedTokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD + 1,
				now: "2026-08-19T12:00:00.000Z",
				previousAutomaticTerminalAt: null,
			}),
		).toEqual({ eligible: false, reason: "insufficient-invocations" });
	});

	it("enforces the cooldown until the full interval has elapsed", () => {
		const previous = "2026-08-19T12:00:00.000Z";
		const beforeCooldown = new Date(Date.parse(previous) + AUTOMATIC_EVOLUTION_COOLDOWN_MS - 1).toISOString();
		const atCooldown = new Date(Date.parse(previous) + AUTOMATIC_EVOLUTION_COOLDOWN_MS).toISOString();
		const input = {
			invocationCount: 3,
			estimatedTokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD + 1,
			previousAutomaticTerminalAt: previous,
		};

		expect(evaluateAutomaticEvolutionEligibility({ ...input, now: beforeCooldown })).toEqual({
			eligible: false,
			reason: "cooldown-active",
		});
		expect(evaluateAutomaticEvolutionEligibility({ ...input, now: atCooldown })).toEqual({ eligible: true });
	});
});
