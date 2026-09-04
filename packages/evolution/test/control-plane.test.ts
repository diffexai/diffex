import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTOMATIC_EVOLUTION_COOLDOWN_MS,
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	countEvolutionTokens,
	createEvolutionArtifactMetadata,
	EVOLUTION_TOKEN_COUNTER_VERSION,
	type EvolutionArtifactProducer,
	EvolutionControlPlane,
	type EvolutionEventSink,
	EvolutionExecutionError,
	type EvolutionFailureRecord,
	type EvolutionJobStage,
	type EvolutionMemoryProposal,
	EvolutionPipeline,
	type EvolutionProgressEvent,
	type EvolutionScope,
	type EvolutionSkillSnapshotSource,
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
	type SkillCandidate,
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

function invocation(traceId: string, inputTokens = 100, outputTokens = 25): MaterializedInvocation {
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
		evidence: [
			{
				evidenceId: `${traceId}:assistant`,
				kind: "session_item",
				itemType: "message",
				order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
				traceSources: [],
				payload: {
					type: "message",
					message: { role: "assistant", usage: { input: inputTokens, output: outputTokens } },
				},
			},
		],
		diagnostics: [],
	};
}

function materialization(sequence: number, inputTokens = 100, outputTokens = 25): SuccessfulMaterialization {
	const materialized = invocation(`trace-${sequence}`, inputTokens, outputTokens);
	return {
		materializationId: `materialization-${sequence}`,
		ingestionCursor: sequence,
		origin: "product-runtime",
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
}

function automaticMaterializations(): readonly SuccessfulMaterialization[] {
	const inputTokens = Math.floor(AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD / 3) + 1;
	return [1, 2, 3].map((sequence) => {
		const materialized = invocation(`trace-${sequence}`, inputTokens, 1);
		return {
			materializationId: `materialization-${sequence}`,
			ingestionCursor: sequence,
			origin: "product-runtime",
			contentDigest: computeEvolutionContentDigest(materialized),
			invocation: materialized,
		};
	});
}

function snapshotContext(skills: readonly EvolutionSkillSnapshotSource[] = []): EvolutionSnapshotContext {
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
		skills,
		modelConfiguration: {
			provider: "faux",
			model: "fixture",
			configurationDigest: MODEL_CONFIGURATION_DIGEST,
		},
		pipelineVersion: "pipeline-v1",
		promptVersions: {
			reflector: "reflector-v1",
			curator: "curator-v1",
			skillCurator: "skill-curator-v1",
			skillSynthesizer: "skill-synthesizer-v1",
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
	"skill-curating",
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
		if (context.job.stage === "skill-curating" && this.#noOp) {
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
	readonly root: string;
	readonly clock: AdvancingClock;
	readonly controlPlane: EvolutionControlPlane;
	readonly events: EvolutionProgressEvent[];
	readonly executor: TExecutor;
	readonly failureRecords: EvolutionFailureRecord[];
	readonly persistence: FileEvolutionPersistence;
}

async function controlPlaneFixture<TExecutor extends EvolutionStageExecutor>(
	executor: TExecutor,
	materializations: readonly SuccessfulMaterialization[] = [
		materialization(1),
		materialization(2),
		materialization(3),
	],
	highWaterCursor?: number,
	capturedSnapshot: EvolutionSnapshotContext = snapshotContext(),
): Promise<ControlPlaneFixture<TExecutor>> {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-control-"));
	temporaryDirectories.push(root);
	const persistence = new FileEvolutionPersistence(root);
	const clock = new AdvancingClock();
	const events: EvolutionProgressEvent[] = [];
	const failureRecords: EvolutionFailureRecord[] = [];
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
			cancellations: persistence,
			cursors: persistence,
			leases: persistence,
			ledger: persistence,
			failures: {
				async record(failure) {
					failureRecords.push(failure);
				},
			},
			events: eventSink,
			evidence: {
				async highWaterCursor() {
					return highWaterCursor ?? materializations.at(-1)?.ingestionCursor ?? 0;
				},
				async listSuccessful(_scope, afterCursor, throughCursor) {
					return materializations.filter(
						(item) => item.ingestionCursor > afterCursor && item.ingestionCursor <= throughCursor,
					);
				},
			},
			snapshots: {
				async capture() {
					return capturedSnapshot;
				},
			},
			executor,
		},
		{ leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000, retryBaseDelayMs: 0, retryMaxDelayMs: 0 },
	);
	return { root, clock, controlPlane, events, executor, failureRecords, persistence };
}

async function createManualJob(fixture: ControlPlaneFixture) {
	const result = await fixture.controlPlane.createJob({ scope, trigger: "manual" });
	expect(result.status).toBe("created");
	if (result.status !== "created") throw new Error("Expected a created fixture job");
	return result.job;
}

describe("durable evolution control plane", () => {
	it("durably consumes an excluded-only evidence range", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor(), []);
		const controlPlane = new EvolutionControlPlane(
			{
				version: "1.0.0",
				clock: fixture.clock,
				ids: new SequenceIds(),
				artifacts: fixture.persistence,
				jobs: fixture.persistence,
				cancellations: fixture.persistence,
				cursors: fixture.persistence,
				leases: fixture.persistence,
				ledger: fixture.persistence,
				events: { emit() {} },
				evidence: {
					async highWaterCursor() {
						return 3;
					},
					async listSuccessful() {
						return [];
					},
					async excludedThroughCursor() {
						return 3;
					},
				},
				snapshots: {
					async capture() {
						return snapshotContext();
					},
				},
				executor: new RecordingExecutor(),
			},
			{ leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 },
		);

		await expect(controlPlane.createJob({ scope, trigger: "manual" })).resolves.toEqual({
			status: "not-created",
			reason: "no-new-evidence",
		});
		expect(await fixture.persistence.load(scope)).toMatchObject({ sequence: 3 });
	});

	it("commits a mixed range through excluded evidence after eligible work completes", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor({ noOp: true }), [materialization(2)], 3);
		const created = await createManualJob(fixture);

		const completed = await fixture.controlPlane.runJob(created.jobId);

		expect(completed).toMatchObject({
			outcome: "completed",
			completion: { kind: "no-op", processedEvidenceCursor: 3 },
		});
		expect(await fixture.persistence.load(scope)).toMatchObject({ sequence: 3, committedByJobId: created.jobId });
	});

	it.each(EXECUTABLE_STAGES)("resumes %s with stable idempotency and one completion", async (crashStage) => {
		const fixture = await controlPlaneFixture(new RecordingExecutor({ crashStage }));
		const created = await createManualJob(fixture);

		await expect(fixture.controlPlane.runJob(created.jobId)).rejects.toThrow(`simulated crash during ${crashStage}`);
		const failed = await fixture.persistence.load(created.jobId);
		expect(failed).toMatchObject({ outcome: "retryable-failed", stage: crashStage });
		expect(fixture.failureRecords).toMatchObject([
			{ jobId: created.jobId, stage: crashStage, outcome: "retryable-failed", reasonCode: "stage-failed" },
		]);

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

	it("reports terminal failures with structured diagnostics", async () => {
		const fixture = await controlPlaneFixture({
			async execute() {
				throw new EvolutionExecutionError("invalid reflector output", {
					reasonCode: "reflection-invalid-response",
					retryable: false,
					diagnostics: { rejectedResponses: [{ validationError: "lessons must be an array" }] },
				});
			},
		});
		const created = await createManualJob(fixture);

		await expect(fixture.controlPlane.runJob(created.jobId)).rejects.toThrow("invalid reflector output");

		expect(fixture.failureRecords).toMatchObject([
			{
				jobId: created.jobId,
				stage: "snapshotting",
				outcome: "terminal-failed",
				reasonCode: "reflection-invalid-response",
				error: {
					message: "invalid reflector output",
					diagnostics: { rejectedResponses: [{ validationError: "lessons must be an array" }] },
				},
			},
		]);
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
		expect(completed.checkpoints.map((checkpoint) => checkpoint.stage)).toEqual(EXECUTABLE_STAGES.slice(0, 6));
		expect(fixture.executor.calls.has("writing")).toBe(false);
		expect(fixture.executor.calls.has("activating")).toBe(false);
	});

	it("leaves evidence arriving after the frozen cursor for the next job", async () => {
		const materializations = [materialization(1), materialization(2), materialization(3)];
		const fixture = await controlPlaneFixture(new RecordingExecutor({ noOp: true }), materializations);
		const created = await createManualJob(fixture);

		materializations.push(materialization(4));
		const completed = await fixture.controlPlane.runJob(created.jobId);

		expect(completed.evidenceRange).toEqual({ afterCursor: 0, throughCursor: 3 });
		expect(completed.completion?.processedEvidenceCursor).toBe(3);
		const next = await fixture.controlPlane.createJob({ scope, trigger: "manual" });
		expect(next).toMatchObject({
			status: "created",
			job: { evidenceRange: { afterCursor: 3, throughCursor: 4 } },
		});
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

	it("marks an abandoned active job as explicitly resumable", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor());
		const created = await createManualJob(fixture);

		const recovered = await fixture.controlPlane.recoverAbandonedJob(created.jobId);

		expect(recovered).toMatchObject({
			outcome: "interrupted",
			reasonCode: "lease-lost",
			failureMessage: "Evolution job was interrupted after its lease expired",
		});
		expect((await fixture.persistence.load(created.jobId))?.outcome).toBe("interrupted");
	});

	it("reports no evidence instead of creating an empty manual job", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor(), []);

		await expect(fixture.controlPlane.createJob({ scope, trigger: "manual" })).resolves.toEqual({
			status: "not-created",
			reason: "no-new-evidence",
		});
		expect(await fixture.persistence.list(scope)).toEqual([]);
	});

	it("records reported token usage and rejects a small automatic corpus", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor());
		await expect(fixture.controlPlane.createJob({ scope, trigger: "automatic" })).resolves.toEqual({
			status: "not-created",
			reason: "insufficient-tokens",
		});

		const created = await createManualJob(fixture);
		const snapshot = await fixture.persistence.get(created.inputSnapshot);
		expect(snapshot).toMatchObject({
			tokenMeasurement: {
				counterVersion: EVOLUTION_TOKEN_COUNTER_VERSION,
				inputTokens: 300,
				outputTokens: 75,
				totalTokens: 375,
			},
		});
	});

	it("processes an automatic backlog in threshold-sized cursor ranges", async () => {
		const materializations = Array.from({ length: 20 }, (_, index) => materialization(index + 1, 49_999, 1));
		const fixture = await controlPlaneFixture(new RecordingExecutor({ noOp: true }), materializations);

		const first = await fixture.controlPlane.createJob({ scope, trigger: "automatic" });
		expect(first).toMatchObject({
			status: "created",
			job: { evidenceRange: { afterCursor: 0, throughCursor: 8 } },
		});
		if (first.status !== "created") throw new Error("Expected the first automatic evolution job");
		const firstSnapshot = await fixture.persistence.get(first.job.inputSnapshot);
		if (!("evidenceSources" in firstSnapshot)) throw new Error("Expected the first automatic input snapshot");
		expect(firstSnapshot).toMatchObject({
			ingestionHighWaterCursor: 8,
			tokenMeasurement: { totalTokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD },
		});
		expect(firstSnapshot.evidenceSources.map((source) => source.ingestionCursor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		await fixture.controlPlane.runJob(first.job.jobId);

		fixture.clock.advance(AUTOMATIC_EVOLUTION_COOLDOWN_MS);
		const second = await fixture.controlPlane.createJob({ scope, trigger: "automatic" });
		expect(second).toMatchObject({
			status: "created",
			job: { evidenceRange: { afterCursor: 8, throughCursor: 16 } },
		});
		if (second.status !== "created") throw new Error("Expected the second automatic evolution job");
		const secondSnapshot = await fixture.persistence.get(second.job.inputSnapshot);
		if (!("evidenceSources" in secondSnapshot)) throw new Error("Expected the second automatic input snapshot");
		expect(secondSnapshot).toMatchObject({
			ingestionHighWaterCursor: 16,
			tokenMeasurement: { totalTokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD },
		});
		expect(secondSnapshot.evidenceSources.map((source) => source.ingestionCursor)).toEqual([
			9, 10, 11, 12, 13, 14, 15, 16,
		]);
		await fixture.controlPlane.runJob(second.job.jobId);

		fixture.clock.advance(AUTOMATIC_EVOLUTION_COOLDOWN_MS);
		await expect(fixture.controlPlane.createJob({ scope, trigger: "automatic" })).resolves.toEqual({
			status: "not-created",
			reason: "insufficient-tokens",
		});
		expect(await fixture.persistence.load(scope)).toMatchObject({ sequence: 16 });

		materializations.push(...Array.from({ length: 4 }, (_, index) => materialization(index + 21, 49_999, 1)));
		const third = await fixture.controlPlane.createJob({ scope, trigger: "automatic" });
		expect(third).toMatchObject({
			status: "created",
			job: { evidenceRange: { afterCursor: 16, throughCursor: 24 } },
		});
		if (third.status !== "created") throw new Error("Expected the third automatic evolution job");
		const thirdSnapshot = await fixture.persistence.get(third.job.inputSnapshot);
		if (!("evidenceSources" in thirdSnapshot)) throw new Error("Expected the third automatic input snapshot");
		expect(thirdSnapshot).toMatchObject({
			ingestionHighWaterCursor: 24,
			tokenMeasurement: { totalTokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD },
		});
		expect(thirdSnapshot.evidenceSources.map((source) => source.ingestionCursor)).toEqual([
			17, 18, 19, 20, 21, 22, 23, 24,
		]);
		await fixture.controlPlane.runJob(third.job.jobId);
		expect(await fixture.persistence.load(scope)).toMatchObject({ sequence: 24 });
	});

	it("does not cross the automatic token cap at an invocation boundary", async () => {
		const materializations = [
			materialization(1, 129_999, 1),
			materialization(2, 129_999, 1),
			materialization(3, 129_999, 1),
			materialization(4, 99_999, 1),
		];
		const fixture = await controlPlaneFixture(new RecordingExecutor(), materializations);

		const created = await fixture.controlPlane.createJob({ scope, trigger: "automatic" });

		expect(created).toMatchObject({
			status: "created",
			job: { evidenceRange: { afterCursor: 0, throughCursor: 3 } },
		});
		if (created.status !== "created") throw new Error("Expected an automatic evolution job");
		expect(await fixture.persistence.get(created.job.inputSnapshot)).toMatchObject({
			ingestionHighWaterCursor: 3,
			tokenMeasurement: { totalTokens: 390_000 },
		});
	});

	it("keeps manual evolution snapshots uncapped", async () => {
		const materializations = Array.from({ length: 20 }, (_, index) => materialization(index + 1, 49_999, 1));
		const fixture = await controlPlaneFixture(new RecordingExecutor(), materializations);

		const created = await createManualJob(fixture);

		expect(created.evidenceRange).toEqual({ afterCursor: 0, throughCursor: 20 });
		expect(await fixture.persistence.get(created.inputSnapshot)).toMatchObject({
			ingestionHighWaterCursor: 20,
			tokenMeasurement: { totalTokens: 1_000_000 },
		});
	});

	it("freezes skill metadata and full content as immutable referenced artifacts", async () => {
		const content = "---\nname: review\ndescription: Review changes\n---\n\nReview carefully.";
		const skill: EvolutionSkillSnapshotSource = {
			skillId: `skill:${"a".repeat(64)}`,
			name: "review",
			description: "Review changes",
			sourceKind: "installed",
			scope: "workspace",
			source: "local",
			version: computeEvolutionTextDigest(content),
			contentDigest: computeEvolutionTextDigest(content),
			location: "/repo/.diffex/skills/review/SKILL.md",
			baseDir: "/repo/.diffex/skills/review",
			disableModelInvocation: false,
			content,
		};
		const fixture = await controlPlaneFixture(
			new RecordingExecutor(),
			[materialization(1)],
			undefined,
			snapshotContext([skill]),
		);

		const created = await createManualJob(fixture);
		const input = await fixture.persistence.get(created.inputSnapshot);
		if (!("skillCatalog" in input)) throw new Error("Expected an evolution input snapshot");
		expect(input.skillCatalog).toHaveLength(1);
		expect(input.skillCatalog[0]).toMatchObject({
			skillId: skill.skillId,
			sourceKind: "installed",
			scope: "workspace",
			workspace: { repositoryId: "diffex" },
			contentDigest: skill.contentDigest,
		});
		const contentArtifact = await fixture.persistence.get(input.skillCatalog[0]!.contentArtifact);
		if (!("artifactKind" in contentArtifact) || contentArtifact.artifactKind !== "skill-content") {
			throw new Error("Expected a frozen skill content artifact");
		}
		expect(contentArtifact.skill).toMatchObject({
			skillId: skill.skillId,
			content,
			location: skill.location,
			workspace: { repositoryId: "diffex" },
		});
	});

	it("rejects skill content that does not match its frozen digest", async () => {
		const skill: EvolutionSkillSnapshotSource = {
			skillId: `skill:${"b".repeat(64)}`,
			name: "review",
			description: "Review changes",
			sourceKind: "installed",
			scope: "global",
			source: "local",
			version: `sha256:${"c".repeat(64)}`,
			contentDigest: `sha256:${"d".repeat(64)}`,
			location: "/skills/review/SKILL.md",
			baseDir: "/skills/review",
			disableModelInvocation: false,
			content: "Review carefully.",
		};
		const fixture = await controlPlaneFixture(
			new RecordingExecutor(),
			[materialization(1)],
			undefined,
			snapshotContext([skill]),
		);

		await expect(fixture.controlPlane.createJob({ scope, trigger: "manual" })).rejects.toThrow(
			'Frozen skill catalog entry is invalid for "review"',
		);
	});

	it("cooperatively cancels work owned through another persistence instance", async () => {
		let executionStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve;
		});
		const fixture = await controlPlaneFixture({
			async execute(context) {
				executionStarted?.();
				await new Promise<void>((_resolve, reject) => {
					const signal = context.signal;
					if (signal?.aborted) {
						reject(signal.reason);
						return;
					}
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				throw new Error("Unreachable evolution execution");
			},
		});
		const created = await createManualJob(fixture);
		const run = fixture.controlPlane.runJob(created.jobId);
		const runRejected = expect(run).rejects.toThrow("cancelled by the operator");
		await started;

		const peerPersistence = new FileEvolutionPersistence(fixture.root);
		let nextPeerId = 1;
		const peer = new EvolutionControlPlane(
			{
				version: "1.0.0",
				clock: fixture.clock,
				ids: { nextId: (kind) => `peer-${kind}-${nextPeerId++}` },
				artifacts: peerPersistence,
				jobs: peerPersistence,
				cancellations: peerPersistence,
				cursors: peerPersistence,
				leases: peerPersistence,
				ledger: peerPersistence,
				events: { emit() {} },
				evidence: {
					async highWaterCursor() {
						return 0;
					},
					async listSuccessful() {
						return [];
					},
				},
				snapshots: {
					async capture() {
						return snapshotContext();
					},
				},
				executor: new RecordingExecutor(),
			},
			{ leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000, cancellationPollIntervalMs: 5 },
		);

		await peer.cancelJob(created.jobId);
		await runRejected;
		expect(await peerPersistence.loadCancellation(created.jobId)).toMatchObject({ jobId: created.jobId });
		expect(await fixture.persistence.load(created.jobId)).toMatchObject({
			outcome: "interrupted",
			reasonCode: "cancelled-by-operator",
			resolution: { reasonCode: "cancelled-by-operator" },
		});
		expect(fixture.failureRecords).toEqual([]);
	});

	it("does not start an automatic cooldown when its round is cancelled", async () => {
		const fixture = await controlPlaneFixture(new RecordingExecutor(), automaticMaterializations());
		const first = await fixture.controlPlane.createJob({ scope, trigger: "automatic" });
		expect(first.status).toBe("created");
		if (first.status !== "created") throw new Error("Expected an automatic evolution job");

		await fixture.controlPlane.cancelJob(first.job.jobId);

		await expect(fixture.controlPlane.createJob({ scope, trigger: "automatic" })).resolves.toMatchObject({
			status: "created",
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
		const skillCuratorSelections: string[][] = [];
		const writeKeys = new Set<string>();
		const activationKeys = new Set<string>();
		const target: EvolutionTargetWriter = {
			kind: "evolution-memory",
			async write(batch, context) {
				writeKeys.add(context.idempotencyKey);
				return {
					batchId: batch.batchId,
					status: "written",
					output: {
						candidateId: `candidate-${batch.batchId}`,
						candidateDigest: computeEvolutionContentDigest(batch),
						batchHash: computeEvolutionContentDigest(batch),
						expectedBaseVersion: batch.expectedBaseVersion,
						expectedBaseDigest: batch.expectedBaseDigest,
						resultingHarnessVersion: SECOND_HARNESS_VERSION,
						resultingMemoryDigest: computeEvolutionContentDigest("candidate"),
						operationIds: batch.mutations.map((mutation) => mutation.mutationId),
						diff: { start: 0, removed: "", added: "candidate" },
					},
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
				maxProviderCallsPerExecution: 20,
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
						model: input.input.modelConfiguration,
						promptVersion: "reflector-v1",
						idempotencyKey: input.idempotencyKey,
						input: {},
						outputSchema: {},
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
						model: input.input.modelConfiguration,
						promptVersion: "curator-v1",
						idempotencyKey: input.idempotencyKey,
						input: {},
						outputSchema: {},
						tools: [],
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
			skillCurator: {
				async curate(input) {
					skillCuratorSelections.push(input.selectedMemoryProposals.map((scored) => scored.proposal.proposalId));
					await input.model.execute({
						stage: "skill-curator",
						model: input.input.modelConfiguration,
						promptVersion: "skill-curator-v1",
						idempotencyKey: input.idempotencyKey,
						input: {},
						outputSchema: {},
						tools: [],
						signal: input.signal,
					});
					const candidateContent = {
						artifactKind: "skill-candidate" as const,
						candidateId: "skill-candidate-1",
						operation: "CREATE" as const,
						workspace: {
							repositoryId: "diffex",
							rootPath: "/repo",
							repositoryRevision: "abc123",
							evolutionScope: scope,
						},
						proposedName: "focused-verification",
						existingSkillIds: [],
						sourceLessonIds: ["lesson-1"],
						provenanceBindings: [
							{
								sourceLessonId: "lesson-1",
								supportingEvidenceIds: [],
								contradictingEvidenceIds: [],
								materialFields: [
									"operation",
									"proposedName",
									"existingSkillIds",
									"skillability",
									"trigger.description",
									"trigger.positiveExamples",
									"trigger.negativeExamples",
									"preconditions",
									"procedure.steps",
									"procedure.requiredTools",
									"procedure.environment",
									"failureHandling",
									"applicabilityBoundaries",
									"verificationContract.checks",
									"verificationContract.completionCondition",
									"memoryRelationship",
								] as const,
							},
						],
						supportingEvidenceIds: [],
						contradictingEvidenceIds: [],
						supportingTraceIds: [],
						contradictingTraceIds: [],
						taskLineageIds: [],
						skillability: {
							classification: "verification-routine" as const,
						},
						trigger: {
							description: "A focused repository change requires verification.",
							positiveExamples: ["A focused code change needs a targeted check."],
							negativeExamples: ["No repository files changed."],
						},
						preconditions: ["A focused verification command is available."],
						procedure: {
							steps: [{ sequence: 1, action: "Run the focused check.", condition: null }],
							requiredTools: ["shell"],
							environment: ["Repository checkout"],
						},
						failureHandling: [
							{
								signal: "The focused check fails.",
								mitigation: "Inspect its deterministic diagnostic.",
								recovery: "Correct the issue and rerun the same check.",
							},
						],
						applicabilityBoundaries: ["Focused repository changes"],
						verificationContract: {
							checks: ["The focused check exits successfully."],
							completionCondition: "The focused check passes.",
						},
						memoryRelationship: {
							classification: "complements" as const,
							memoryProposalIds: ["proposal-1"],
						},
						capsuleSize: {
							serialization: "canonical-json-utf8-v1" as const,
							serializedBytes: 1_024,
							estimatedTokens: 256,
							maxSerializedBytes: 65_536,
							maxEstimatedTokens: 16_384,
						},
					};
					const candidate: SkillCandidate = {
						metadata: metadata("skill-candidate-1", ["lesson-1", "proposal-1"], candidateContent),
						...candidateContent,
					};
					const outlineSetContent = {
						artifactKind: "skill-candidate-outline-set" as const,
						outlineSetId: "outline-set-1",
						sourceEvolutionJobId: input.jobId,
						discoveryIdempotencyKey: input.idempotencyKey,
						inputSnapshotId: input.input.metadata.artifactId,
						inputSnapshotContentDigest: input.input.metadata.contentDigest,
						workspace: candidate.workspace,
						outlines: [
							{
								outlineId: "outline-1",
								outlineKey: "focused-verification",
								sourceLessonIds: candidate.sourceLessonIds,
								operation: candidate.operation,
								proposedName: candidate.proposedName,
								existingSkillIds: candidate.existingSkillIds,
								skillability: candidate.skillability,
								memoryRelationship: candidate.memoryRelationship,
							},
						],
					};
					return {
						status: "completed",
						outlineSet: {
							metadata: metadata("outline-set-1", ["lesson-1", "proposal-1"], outlineSetContent),
							...outlineSetContent,
						},
						candidates: [candidate],
						failedExpansions: [],
						deferredFindings: [],
						proceduralInformationLossFindings: [],
					};
				},
			},
			validator: {
				async validate(input) {
					const proposalResults = input.proposals.map((proposal) => ({
						proposalId: proposal.proposalId,
						disposition: "accepted" as const,
						reasonCodes: [],
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
						validatorVersion: "fixture-validator-v1",
						assurance: "provenance-recurrence-and-structure-only",
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
							scorerVersion: "fixture-scorer-v1",
							evidenceRankingScore: 100,
							scoreComponents: {
								recurrence: 30,
								provenanceIntegrity: 20,
								sourceSignalStrength: 15,
								scopeCoverage: 15,
								curatorConfidence: 10,
								proposalCompleteness: 10,
								contradictionPenalty: 0,
							},
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
		expect(modelKeys).toHaveLength(3);
		expect(new Set(modelKeys).size).toBe(3);
		expect(skillCuratorSelections).toEqual([["proposal-1"]]);
		const skillCheckpoint = completed.checkpoints.find((checkpoint) => checkpoint.stage === "skill-curating");
		expect(skillCheckpoint).toMatchObject({
			state: {
				outlineSetId: "outline-set-1",
				outlineIds: ["outline-1"],
				candidateIds: ["skill-candidate-1"],
				deferredFindingIds: [],
				proceduralInformationLossFindingIds: [],
				selectedMemoryProposalIds: ["proposal-1"],
			},
		});
		if (skillCheckpoint === undefined) throw new Error("Expected a skill curation checkpoint");
		expect(await fixture.persistence.get(skillCheckpoint.outputArtifacts[0]!)).toMatchObject({
			artifactKind: "skill-candidate-outline-set",
			outlineSetId: "outline-set-1",
		});
		expect(await fixture.persistence.get(skillCheckpoint.outputArtifacts[1]!)).toMatchObject({
			artifactKind: "skill-candidate",
			candidateId: "skill-candidate-1",
			operation: "CREATE",
		});
		expect(writeKeys.size).toBe(1);
		expect(activationKeys.size).toBe(1);
		const ledger = await fixture.persistence.read(created.jobId);
		expect(
			ledger
				.filter((event) => event.type === "proposal-disposition")
				.map((event) => [event.proposalId, event.disposition]),
		).toEqual([["proposal-1", "applied"]]);
		expect(ledger.filter((event) => event.type === "mutation-written")).toHaveLength(1);
		expect(ledger.find((event) => event.type === "harness-activated")).toMatchObject({
			batchId: expect.stringMatching(/^mutation-batch-/),
			proposalIds: ["proposal-1"],
			evidenceIds: [],
			operationIds: [expect.stringMatching(/^mutation-/)],
			exactDiff: { start: 0, removed: "", added: "candidate" },
			parentHarnessVersion: FIRST_HARNESS_VERSION,
			resultingHarnessVersion: SECOND_HARNESS_VERSION,
			rollbackParentHarnessVersion: FIRST_HARNESS_VERSION,
		});
	});
});

describe("automatic evolution policy", () => {
	it("counts reported assistant usage from supported session formats", () => {
		const codingAgentInvocation = invocation("coding", 120, 30);
		const harnessInvocation: MaterializedInvocation = {
			...invocation("harness", 0, 0),
			evidence: [
				{
					evidenceId: "harness:usage",
					kind: "session_item",
					itemType: "record.usage",
					order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
					traceSources: [],
					payload: { kind: "record", type: "usage", cause: "assistant", usage: { input: 80, output: 20 } },
				},
				{
					evidenceId: "harness:compaction",
					kind: "session_item",
					itemType: "record.usage",
					order: { traceSequence: 2, timestamp: null, causalIdentifiers: [], ambiguity: [] },
					traceSources: [],
					payload: { kind: "record", type: "usage", cause: "compaction", usage: { input: 1_000, output: 500 } },
				},
			],
		};

		expect(countEvolutionTokens([])).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
		expect(countEvolutionTokens([codingAgentInvocation, harnessInvocation])).toEqual({
			inputTokens: 200,
			outputTokens: 50,
			totalTokens: 250,
		});
	});

	it("requires the token threshold and at least three invocations", () => {
		expect(
			evaluateAutomaticEvolutionEligibility({
				invocationCount: 3,
				tokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
				now: "2026-08-19T12:00:00.000Z",
				previousAutomaticTerminalAt: null,
			}),
		).toEqual({ eligible: true });
		expect(
			evaluateAutomaticEvolutionEligibility({
				invocationCount: 2,
				tokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD + 1,
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
			tokens: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD + 1,
			previousAutomaticTerminalAt: previous,
		};

		expect(evaluateAutomaticEvolutionEligibility({ ...input, now: beforeCooldown })).toEqual({
			eligible: false,
			reason: "cooldown-active",
		});
		expect(evaluateAutomaticEvolutionEligibility({ ...input, now: atCooldown })).toEqual({ eligible: true });
	});
});
