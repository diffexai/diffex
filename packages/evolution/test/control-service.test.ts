import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HarnessStateStore,
	type HarnessVersion,
	type HarnessVersionList,
	harnessVersionDirectoryName,
} from "@earendil-works/diffex-harness-state";
import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	countEvolutionTokens,
	type EvolutionArtifactReference,
	EvolutionBackgroundWorker,
	EvolutionControlPlane,
	EvolutionControlService,
	type EvolutionControlServiceDependencies,
	EvolutionExecutionError,
	type EvolutionInputSnapshot,
	type EvolutionJob,
	type EvolutionLedgerEvent,
	EvolutionProgressBus,
	type EvolutionScope,
	type EvolutionSnapshotContext,
	type EvolutionStageExecutor,
	FileEvolutionPersistence,
	type HarnessActivationReceipt,
	PollingEvolutionWorkSource,
	type SkillCandidate,
	type SkillCandidateGroup,
	type SkillCandidateRegistryEvent,
	type SkillDraft,
	type SkillDraftValidationReport,
	type SkillEvaluationReport,
	type SuccessfulMaterialization,
} from "../src/index.ts";

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

class FixedClock {
	#timestamp = Date.now();

	now(): string {
		const value = new Date(this.#timestamp).toISOString();
		this.#timestamp += 1;
		return value;
	}
}

function invocation(sequence: number): MaterializedInvocation {
	return {
		version: 1,
		tracePath: `/traces/${sequence}.jsonl`,
		traceId: `trace-${sequence}`,
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
				evidenceId: `trace-${sequence}:assistant`,
				kind: "session_item",
				itemType: "message",
				order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
				traceSources: [],
				payload: {
					type: "message",
					message: { role: "assistant", usage: { input: sequence * 10, output: sequence } },
				},
			},
		],
		diagnostics: [],
	};
}

function materialization(sequence: number): SuccessfulMaterialization {
	const materialized = invocation(sequence);
	return {
		materializationId: `materialization-${sequence}`,
		ingestionCursor: sequence,
		origin: "product-runtime",
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
}

interface ServiceFixture {
	readonly service: EvolutionControlService;
	readonly store: FileEvolutionPersistence;
	readonly progress: EvolutionProgressBus;
	readonly controlPlane: EvolutionControlPlane;
}

async function serviceFixture(
	executor: EvolutionStageExecutor = {
		async execute(context) {
			if (context.job.stage === "skill-curating") {
				return { artifacts: [], state: {}, directive: "complete-no-op" as const };
			}
			return { artifacts: [], state: {}, directive: "continue" as const };
		},
	},
	evidenceOptions: {
		readonly highWaterCursor?: number;
		readonly materializations?: readonly SuccessfulMaterialization[];
	} = {},
): Promise<ServiceFixture> {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-service-"));
	temporaryDirectories.push(root);
	const store = new FileEvolutionPersistence(join(root, "evolution"));
	const harnesses = new HarnessStateStore(join(root, "agent"));
	const harness = await harnesses.initialize();
	const clock = new FixedClock();
	const progress = new EvolutionProgressBus();
	const materializations = evidenceOptions.materializations ?? [
		materialization(1),
		materialization(2),
		materialization(3),
	];
	const snapshots = {
		async capture(): Promise<EvolutionSnapshotContext> {
			const memory = harness.state.memory;
			return {
				repository: { repositoryId: "diffex", rootPath: "/repo", revision: "abc123" },
				harness: {
					harnessVersion: harness.manifest.version,
					baseVersion: harness.manifest.base,
					memory,
					memoryContentDigest: computeEvolutionContentDigest(memory),
					activeMemoryItems: [],
				},
				instructions: [],
				skills: [],
				modelConfiguration: {
					provider: "faux",
					model: "fixture",
					configurationDigest: computeEvolutionContentDigest("fixture"),
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
		},
	};
	const evidence = {
		async highWaterCursor() {
			return evidenceOptions.highWaterCursor ?? 3;
		},
		async listSuccessful(_scope: EvolutionScope, afterCursor: number, throughCursor: number) {
			return materializations.filter(
				(entry) => entry.ingestionCursor > afterCursor && entry.ingestionCursor <= throughCursor,
			);
		},
	};
	const controlPlane = new EvolutionControlPlane(
		{
			version: "1.0.0",
			clock,
			ids: new SequenceIds(),
			artifacts: store,
			jobs: store,
			cancellations: store,
			cursors: store,
			leases: store,
			ledger: store,
			events: progress,
			evidence,
			snapshots,
			executor,
		},
		{ leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 },
	);
	const worker = new EvolutionBackgroundWorker({
		clock,
		source: new PollingEvolutionWorkSource(store, clock, scope, { pollIntervalMs: 60_000 }),
		runner: controlPlane,
		priority: { async waitUntilBackgroundAllowed() {} },
	});
	const service = new EvolutionControlService({
		scope,
		clock,
		controlPlane,
		worker,
		jobs: store,
		cursors: store,
		evidence,
		artifacts: store,
		ledger: store,
		harnesses,
		progress,
		observedHarnessVersion: () => harness.manifest.version,
		currentDirectory: {
			directoryId: "directory-1",
			rootPath: "/repo",
			containsRevision: async () => false,
		},
	});
	return { service, store, progress, controlPlane };
}

describe("evolution control service", () => {
	it("limits directory harnesses by durable identity and legacy repository history", async () => {
		const rootVersion = `sha256:${"a".repeat(64)}`;
		const renamedDirectoryVersion = `sha256:${"b".repeat(64)}`;
		const otherDirectoryVersion = `sha256:${"c".repeat(64)}`;
		const legacyVersion = `sha256:${"d".repeat(64)}`;
		const versions = [
			{ version: rootVersion, base: null },
			{ version: renamedDirectoryVersion, base: rootVersion },
			{ version: otherDirectoryVersion, base: rootVersion },
			{ version: legacyVersion, base: rootVersion },
		];
		const jobs = versions.slice(1).map(({ version }, index) => {
			const jobId = `job-${index + 1}`;
			return {
				jobId,
				inputSnapshot: { artifactId: jobId, contentDigest: `sha256:${"0".repeat(64)}` },
				updatedAt: `2026-08-2${index + 1}T12:00:00.000Z`,
				terminalAt: `2026-08-2${index + 1}T12:00:00.000Z`,
				resultingHarnessVersion: version,
				checkpoints: [],
			} as unknown as EvolutionJob & { readonly resultingHarnessVersion: HarnessVersion };
		});
		const repositories = [
			{ repositoryId: "diffex", directoryId: "current-directory", rootPath: "/renamed/repo", revision: "a1" },
			{ repositoryId: "diffex", directoryId: "other-directory", rootPath: "/repo", revision: "b2" },
			{ repositoryId: "diffex", rootPath: "/old/repo", revision: "c".repeat(40) },
		];
		const snapshots = new Map(
			jobs.map((job, index) => [
				job.jobId,
				{
					ingestionHighWaterCursor: 0,
					evidenceSources: [],
					harness: {},
					repository: repositories[index],
				} as unknown as EvolutionInputSnapshot,
			]),
		);
		const versionList = {
			versions: versions.map(({ version, base }) => ({
				manifest: { version, base },
				state: { memory: "", skills: [] },
			})),
			diagnostics: [],
			currentVersion: rootVersion,
		} as unknown as HarnessVersionList;
		const containsRevision = vi.fn(async (revision: string) => revision === "c".repeat(40));
		const service = new EvolutionControlService({
			scope,
			jobs: { list: async () => jobs },
			harnesses: { listVersions: async () => versionList },
			artifacts: {
				get: async (reference: EvolutionArtifactReference) => {
					const snapshot = snapshots.get(reference.artifactId);
					if (snapshot === undefined) throw new Error("Unknown snapshot");
					return snapshot;
				},
			},
			ledger: {
				read: async (jobId: string) => {
					const job = jobs.find((candidate) => candidate.jobId === jobId);
					if (job === undefined) return [];
					return [
						{
							type: "harness-activated",
							resultingHarnessVersion: job.resultingHarnessVersion,
						} as EvolutionLedgerEvent,
					];
				},
			},
			currentDirectory: {
				directoryId: "current-directory",
				rootPath: "/current/repo",
				containsRevision,
			},
		} as unknown as EvolutionControlServiceDependencies);

		expect((await service.listCurrentDirectoryHarnessVersionInfo()).map((info) => info.version)).toEqual([
			rootVersion,
			renamedDirectoryVersion,
			legacyVersion,
		]);
		expect((await service.listHarnessVersionInfo()).map((info) => info.version)).toEqual([
			rootVersion,
			renamedDirectoryVersion,
			otherDirectoryVersion,
			legacyVersion,
		]);
		expect(containsRevision).toHaveBeenCalledWith("c".repeat(40));
	});

	it("lists validated skill descendants without display metadata and excludes corrupt and foreign bundles", async () => {
		const root = await mkdtemp(join(tmpdir(), "diffex-version-catalog-"));
		temporaryDirectories.push(root);
		const harnesses = new HarnessStateStore(root);
		const initial = await harnesses.initialize();
		const workspace = { repositoryId: scope.repositoryId, directoryId: "directory-1" };
		const skill = (name: string, content = "Run focused checks.") => ({
			path: `skills/${name}/SKILL.md`,
			content: `---\nname: ${name}\ndescription: Verify ${name}.\n---\n${content}\n`,
			workspace,
		});
		const memory = "Lesson 1: Verify the exact revision.\n";
		const first = await harnesses.saveVersion({ memory, skills: [skill("one")] }, initial.manifest.version);
		const second = await harnesses.saveVersion(
			{ memory, skills: [skill("one"), skill("two")] },
			first.manifest.version,
		);
		const third = await harnesses.saveVersion(
			{ memory, skills: [skill("one"), skill("two"), skill("three")] },
			second.manifest.version,
		);
		const updated = await harnesses.saveVersion(
			{ memory, skills: [skill("one", "Updated checks."), skill("two"), skill("three")] },
			third.manifest.version,
		);
		const foreign = await harnesses.saveVersion(
			{ memory, skills: [{ ...skill("foreign"), workspace: { ...workspace, directoryId: "elsewhere" } }] },
			first.manifest.version,
		);
		const stagedMemory = await harnesses.saveVersion(
			{ memory: "Lesson 2: Staged but not activated.\n", skills: [] },
			initial.manifest.version,
		);
		const unknownMemory = await harnesses.saveVersion(
			{ memory: "Unattributed foreign memory.", skills: [] },
			initial.manifest.version,
		);
		const corrupt = await harnesses.saveVersion({ memory, skills: [skill("broken")] }, first.manifest.version);
		await writeFile(
			join(root, "harness-state", "versions", harnessVersionDirectoryName(corrupt.manifest.version), "EVOLVE.md"),
			"corrupt",
		);
		await harnesses.selectVersion(first.manifest.version);
		const manifestPath = join(
			root,
			"harness-state",
			"versions",
			harnessVersionDirectoryName(third.manifest.version),
			"manifest.json",
		);
		const manifestBefore = await readFile(manifestPath, "utf8");
		const input = {
			ingestionHighWaterCursor: 0,
			evidenceSources: [],
			harness: {},
			expectedHarnessBaseVersion: initial.manifest.version,
			repository: { ...workspace, rootPath: "/repo", revision: "abc" },
		} as unknown as EvolutionInputSnapshot;
		const job = {
			jobId: "memory-job",
			inputSnapshot: { artifactId: "input", contentDigest: "digest" },
			terminalAt: "2026-08-20T20:35:00.000Z",
			updatedAt: "2026-08-20T20:35:00.000Z",
			checkpoints: [{ stage: "activating", completedAt: "2026-08-20T20:33:00.000Z" }],
		} as unknown as EvolutionJob;
		const receipt = (version: string, createdAt: string): HarnessActivationReceipt =>
			({
				metadata: { scope, createdAt },
				result: { status: "activated", resultingHarnessVersion: version },
			}) as HarnessActivationReceipt;
		const getInput = vi.fn(async () => input);
		const service = new EvolutionControlService({
			scope,
			harnesses,
			jobs: { list: async () => [job] },
			artifacts: { get: getInput },
			ledger: {
				read: async () => [
					{ type: "harness-activated", resultingHarnessVersion: first.manifest.version },
					{
						type: "mutation-written",
						writeResult: {
							status: "written",
							output: {
								resultingHarnessVersion: stagedMemory.manifest.version,
								expectedBaseVersion: initial.manifest.version,
							},
						},
					},
					{
						type: "mutation-written",
						writeResult: {
							status: "failed",
							output: {
								resultingHarnessVersion: unknownMemory.manifest.version,
								expectedBaseVersion: initial.manifest.version,
							},
						},
					},
				],
			},
			skillActivationReceipts: {
				listActivationReceipts: async () => [
					receipt(third.manifest.version, "2026-08-20T20:38:01.000Z"),
					receipt(updated.manifest.version, "2026-08-20T20:39:00.000Z"),
					receipt(corrupt.manifest.version, "2026-08-20T20:40:00.000Z"),
				],
			},
			currentDirectory: {
				directoryId: workspace.directoryId,
				rootPath: "/repo",
				containsRevision: async () => false,
			},
		} as unknown as EvolutionControlServiceDependencies);
		const listing = await service.listCurrentDirectoryHarnessVersions();
		expect(new Set(listing.versions.map((bundle) => bundle.manifest.version))).toEqual(
			new Set([
				initial.manifest.version,
				first.manifest.version,
				second.manifest.version,
				third.manifest.version,
				updated.manifest.version,
				stagedMemory.manifest.version,
			]),
		);
		expect(
			listing.versions.some((bundle) =>
				[foreign.manifest.version, unknownMemory.manifest.version, corrupt.manifest.version].includes(
					bundle.manifest.version,
				),
			),
		).toBe(false);
		expect(listing.diagnostics).toContainEqual(expect.objectContaining({ version: corrupt.manifest.version }));
		const info = new Map(
			(await service.listCurrentDirectoryHarnessVersionInfo()).map((entry) => [entry.version, entry]),
		);
		expect(info.get(first.manifest.version)).toMatchObject({
			evolvedAt: "2026-08-20T20:33:00.000Z",
			origin: "memory",
		});
		expect(info.get(second.manifest.version)).toMatchObject({ kind: "evolved", evolvedAt: null });
		expect(info.get(stagedMemory.manifest.version)).toEqual({
			version: stagedMemory.manifest.version,
			kind: "evolved",
			evolvedAt: null,
			evolvedIn: null,
		});
		expect(info.get(third.manifest.version)).toMatchObject({
			evolvedAt: "2026-08-20T20:38:01.000Z",
			origin: "skill",
		});
		expect(info.get(updated.manifest.version)).toMatchObject({
			evolvedAt: "2026-08-20T20:39:00.000Z",
			origin: "skill",
		});
		expect((await service.listHarnessVersionInfo()).some((entry) => entry.version === corrupt.manifest.version)).toBe(
			false,
		);
		expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);

		// Merely observing a foreign base in a local job is not workspace ownership.
		getInput.mockResolvedValue({ ...input, expectedHarnessBaseVersion: unknownMemory.manifest.version });
		expect(
			(await service.listCurrentDirectoryHarnessVersions()).versions.some(
				(bundle) => bundle.manifest.version === unknownMemory.manifest.version,
			),
		).toBe(false);

		getInput.mockRejectedValue(new Error("Historical input unavailable"));
		const withoutInput = await service.listCurrentDirectoryHarnessVersions();
		expect(withoutInput.versions.map((bundle) => bundle.manifest.version)).toEqual(
			expect.arrayContaining([third.manifest.version, updated.manifest.version]),
		);
		expect(
			(await service.listCurrentDirectoryHarnessVersionInfo()).find(
				(entry) => entry.version === third.manifest.version,
			),
		).toMatchObject({ origin: "skill" });
	});

	it("uses only eligible materializations for totals and frozen input", async () => {
		const eligible = materialization(2);
		const fixture = await serviceFixture(undefined, {
			highWaterCursor: 3,
			materializations: [eligible],
		});

		const overview = await fixture.service.overview();
		expect(await fixture.service.listHarnessVersionInfo()).toEqual([
			{
				version: overview.currentHarnessVersion,
				kind: "default",
				evolvedAt: null,
				evolvedIn: null,
			},
		]);
		expect(overview).toMatchObject({
			ingestionHighWaterCursor: 3,
			settledInvocationCount: 1,
			unprocessedTokens: countEvolutionTokens([eligible.invocation]).totalTokens,
			automaticEligibility: { eligible: false, reason: "insufficient-invocations" },
		});
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");
		const job = await fixture.store.load(started.job.jobId);
		if (job === null) throw new Error("Expected the created job");
		const snapshot = await fixture.store.get(job.inputSnapshot);
		if (!("evidenceSources" in snapshot)) throw new Error("Expected an input snapshot");
		expect(snapshot.evidenceSources.map((source) => source.materializationId)).toEqual(["materialization-2"]);
		expect(snapshot.tokenMeasurement).toMatchObject(countEvolutionTokens([eligible.invocation]));
		await fixture.service.cancelJob(started.job.jobId);
	});

	it("projects eligibility and attaches a concurrent manual trigger", async () => {
		const fixture = await serviceFixture();
		const events: string[] = [];
		const unsubscribe = fixture.service.subscribe((event) => events.push(`${event.type}:${event.jobId}`));

		const initial = await fixture.service.overview();
		expect(initial).toMatchObject({
			processedEvidenceCursor: 0,
			ingestionHighWaterCursor: 3,
			settledInvocationCount: 3,
			automaticEligibility: { eligible: false, reason: "insufficient-tokens" },
			activeJob: null,
		});

		const results = await Promise.all([fixture.service.startManual(), fixture.service.startManual()]);
		const started = results.find((result) => result.status === "created");
		const attached = results.find((result) => result.status === "attached");
		if (started?.status !== "created") throw new Error("Expected one created job");
		expect(attached).toMatchObject({ status: "attached", job: { jobId: started.job.jobId } });
		expect(events).toHaveLength(1);
		unsubscribe();
		await fixture.service.cancelJob(started.job.jobId);
		expect(events).toHaveLength(1);
	});

	it("removes a cancelled round while preserving its pending tokens and invocations", async () => {
		const fixture = await serviceFixture();
		const before = await fixture.service.overview();
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");

		await fixture.service.cancelJob(started.job.jobId);

		expect(await fixture.store.load(started.job.jobId)).toMatchObject({
			outcome: "interrupted",
			reasonCode: "cancelled-by-operator",
			resolution: {
				kind: "administratively-resolved",
				reasonCode: "cancelled-by-operator",
			},
		});
		expect(await fixture.service.listJobs()).toEqual([]);
		await expect(fixture.service.getJob(started.job.jobId)).rejects.toThrow(`Unknown evolution job`);
		await expect(fixture.service.resumeNewest()).rejects.toThrow("No interrupted or retryable evolution job");
		expect(await fixture.store.read(started.job.jobId)).toContainEqual(
			expect.objectContaining({
				type: "job-failed",
				reasonCode: "cancelled-by-operator",
			}),
		);
		expect(await fixture.service.overview()).toMatchObject({
			activeJob: null,
			newestResumableJob: null,
			processedEvidenceCursor: before.processedEvidenceCursor,
			unprocessedTokens: before.unprocessedTokens,
			settledInvocationCount: before.settledInvocationCount,
		});

		const replacement = await fixture.service.startManual();
		expect(replacement).toMatchObject({ status: "created" });
		if (replacement.status === "created") {
			expect(replacement.job.jobId).not.toBe(started.job.jobId);
			await fixture.service.cancelJob(replacement.job.jobId);
		}
	});

	it("cancels an explicitly resumed job before background execution", async () => {
		const fixture = await serviceFixture();
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");
		await fixture.controlPlane.recoverAbandonedJob(started.job.jobId);

		const resumed = await fixture.service.resumeNewest();
		expect(resumed).toMatchObject({
			jobId: started.job.jobId,
			outcome: "active",
			resumable: false,
			cancellable: true,
		});

		await fixture.service.cancelJob(started.job.jobId);

		expect(await fixture.store.load(started.job.jobId)).toMatchObject({
			outcome: "interrupted",
			reasonCode: "cancelled-by-operator",
			resolution: { reasonCode: "cancelled-by-operator" },
		});
		expect(await fixture.service.overview()).toMatchObject({ activeJob: null, newestResumableJob: null });
	});

	it("directly cancels a retryable job", async () => {
		const fixture = await serviceFixture({
			async execute() {
				throw new Error("temporary evolution failure");
			},
		});
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");
		await expect(fixture.controlPlane.runJob(started.job.jobId)).rejects.toThrow("temporary evolution failure");
		expect(await fixture.service.overview()).toMatchObject({
			newestResumableJob: {
				jobId: started.job.jobId,
				outcome: "retryable-failed",
				resumable: true,
				cancellable: true,
			},
		});

		await fixture.service.cancelJob(started.job.jobId);

		expect(await fixture.store.load(started.job.jobId)).toMatchObject({
			outcome: "interrupted",
			reasonCode: "cancelled-by-operator",
			resolution: { reasonCode: "cancelled-by-operator" },
		});
	});

	it("cancels a resumed job after it is interrupted again", async () => {
		const fixture = await serviceFixture();
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");
		await fixture.controlPlane.recoverAbandonedJob(started.job.jobId);
		await fixture.service.resumeNewest();
		await fixture.controlPlane.recoverAbandonedJob(started.job.jobId);

		expect(await fixture.service.overview()).toMatchObject({
			activeJob: null,
			newestResumableJob: {
				jobId: started.job.jobId,
				outcome: "interrupted",
				resumable: true,
				cancellable: true,
			},
		});

		await fixture.service.cancelJob(started.job.jobId);

		expect(await fixture.service.listJobs()).toEqual([]);
		await expect(fixture.service.resumeNewest()).rejects.toThrow("No interrupted or retryable evolution job");
	});

	it("removes a running round through durable cooperative cancellation", async () => {
		let startedExecution: (() => void) | undefined;
		const executionStarted = new Promise<void>((resolve) => {
			startedExecution = resolve;
		});
		const fixture = await serviceFixture({
			async execute(context) {
				startedExecution?.();
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
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");
		fixture.service.start();
		try {
			await executionStarted;
			await fixture.service.cancelJob(started.job.jobId);

			expect(await fixture.store.load(started.job.jobId)).toMatchObject({
				outcome: "interrupted",
				reasonCode: "cancelled-by-operator",
				resolution: { reasonCode: "cancelled-by-operator" },
			});
			expect(await fixture.service.listJobs()).toEqual([]);
		} finally {
			await fixture.service.stop();
		}
	});

	it("starts fresh work after a terminal failure and reports incomplete reflection coverage", async () => {
		const fixture = await serviceFixture({
			async execute(context) {
				if (context.job.stage === "reflecting") {
					throw new EvolutionExecutionError("Reflector returned an invalid response", {
						reasonCode: "reflection-invalid-response",
						retryable: false,
					});
				}
				return { artifacts: [], state: {}, directive: "continue" };
			},
		});
		const first = await fixture.service.startManual();
		if (first.status !== "created") throw new Error("Expected a created job");

		await expect(fixture.controlPlane.runJob(first.job.jobId)).rejects.toThrow(
			"Reflector returned an invalid response",
		);
		expect(await fixture.service.getJob(first.job.jobId)).toMatchObject({
			outcome: "terminal-failed",
			observability: { sliceCoverage: null },
		});
		const failedOverview = await fixture.service.overview();
		expect(failedOverview).toMatchObject({ activeJob: null, lastEvolutionAt: null });
		expect(failedOverview.cooldownRemainingMs).toBe(0);

		const second = await fixture.service.startManual();
		expect(second).toMatchObject({ status: "created" });
		if (second.status === "created") {
			expect(second.job.jobId).not.toBe(first.job.jobId);
			await fixture.service.cancelJob(second.job.jobId);
		}
	});

	it("separates analysis completion from asynchronous candidate generation outcomes", async () => {
		const timestamp = "2026-08-20T00:00:00.000Z";
		const candidateJob = (
			jobId: string,
			candidateIds: readonly string[] = [`candidate-${jobId}`],
			failedCandidateOutlineIds: readonly string[] = [],
		): EvolutionJob =>
			({
				metadata: { scope },
				jobId,
				trigger: "manual",
				stage: "completed",
				outcome: "completed",
				reasonCode: null,
				failureMessage: null,
				completion: { kind: "no-op", resultingHarnessVersion: null, processedEvidenceCursor: 1 },
				resolution: null,
				checkpoints: [
					{
						stage: "skill-curating",
						state: { candidateIds, failedCandidateOutlineIds },
						outputArtifacts: [],
						completedAt: timestamp,
					},
				],
				attempt: 1,
				revision: 1,
				createdAt: timestamp,
				updatedAt: timestamp,
				terminalAt: timestamp,
				retryNotBefore: null,
			}) as unknown as EvolutionJob;
		const jobs = [
			candidateJob("waiting"),
			candidateJob("retrying"),
			candidateJob("completed"),
			candidateJob("partial"),
			candidateJob("failed"),
			candidateJob("expansion-partial", ["candidate-expansion-partial"], ["outline-failed"]),
			candidateJob("expansion-failed", [], ["outline-first", "outline-second"]),
		];
		const event = (registrySequence: number, value: Readonly<Record<string, unknown>>): SkillCandidateRegistryEvent =>
			({
				metadata: { createdAt: new Date(Date.parse(timestamp) + registrySequence).toISOString() },
				registrySequence,
				...value,
			}) as unknown as SkillCandidateRegistryEvent;
		const events = [
			event(1, {
				type: "skill-candidate-work-failed",
				sourceEvolutionJobId: "retrying",
				attempt: 1,
				stage: "synthesizing",
				message: "temporary synthesis failure",
				retryNotBefore: "2026-08-20T00:01:00.000Z",
				diagnostics: [{ groupId: "group-retrying" }],
			}),
			event(2, {
				type: "skill-candidate-work-checkpointed",
				sourceEvolutionJobId: "completed",
				attempt: 1,
				stage: "completed",
			}),
			event(3, {
				type: "skill-candidate-work-failed",
				sourceEvolutionJobId: "partial",
				attempt: 3,
				stage: "synthesizing",
				message: "one candidate exhausted synthesis",
				retryNotBefore: null,
				diagnostics: [{ groupId: "group-partial-failed" }],
			}),
			event(4, {
				type: "skill-candidate-work-failed",
				sourceEvolutionJobId: "failed",
				attempt: 3,
				stage: "validating",
				message: "candidate validation exhausted retries",
				retryNotBefore: null,
				diagnostics: [{ groupId: "group-failed" }],
			}),
			event(5, {
				type: "skill-candidate-work-checkpointed",
				sourceEvolutionJobId: "expansion-partial",
				attempt: 1,
				stage: "completed",
			}),
		];
		const group = (groupId: string, sourceEvolutionJobId: string, state: SkillCandidateGroup["state"]) =>
			({ groupId, state, proposalRevisions: [{ sourceEvolutionJobId }] }) as unknown as SkillCandidateGroup;
		const groups = [
			group("group-partial-failed", "partial", "synthesis-failed"),
			group("group-partial-accepted", "partial", "accepted"),
			group("group-failed", "failed", "synthesis-failed"),
		];
		const service = new EvolutionControlService({
			scope,
			jobs: { list: async () => jobs },
			skillCandidates: { list: async () => groups },
			skillCandidateRegistryStore: {
				loadSkillCandidateRegistry: async () => ({ revision: events.length, events }),
			},
		} as unknown as EvolutionControlServiceDependencies);

		const summaries = new Map((await service.listJobs()).map((summary) => [summary.jobId, summary]));
		expect(summaries.get("waiting")).toMatchObject({
			analysisStatus: "completed",
			candidateGeneration: { status: "waiting", attempt: 0 },
		});
		expect(summaries.get("retrying")).toMatchObject({
			analysisStatus: "completed",
			candidateGeneration: {
				status: "retrying",
				stage: "synthesizing",
				attempt: 1,
				retryNotBefore: "2026-08-20T00:01:00.000Z",
				failureMessage: "temporary synthesis failure",
			},
		});
		expect(summaries.get("completed")).toMatchObject({
			analysisStatus: "completed",
			candidateGeneration: { status: "completed", stage: "completed", attempt: 1 },
		});
		expect(summaries.get("partial")).toMatchObject({
			candidateGeneration: { status: "partial-failure", stage: "synthesizing", attempt: 3 },
		});
		expect(summaries.get("failed")).toMatchObject({
			candidateGeneration: {
				status: "failed",
				stage: "validating",
				attempt: 3,
				failureMessage: "candidate validation exhausted retries",
			},
		});
		expect(summaries.get("expansion-partial")).toMatchObject({
			candidateGeneration: {
				status: "partial-failure",
				stage: "completed",
				failureMessage: "1 skill candidate expansion failed",
			},
		});
		expect(summaries.get("expansion-failed")).toMatchObject({
			candidateGeneration: {
				status: "failed",
				stage: null,
				failureMessage: "2 skill candidate expansions failed",
			},
		});
	});

	it("exposes candidate evidence from legacy snapshots and gates activation and rollback", async () => {
		const inputReference = { artifactId: "input-1", contentDigest: `sha256:${"1".repeat(64)}` };
		const candidateReference = { artifactId: "candidate-1", contentDigest: `sha256:${"2".repeat(64)}` };
		const draftReference = { artifactId: "draft-1", contentDigest: `sha256:${"3".repeat(64)}` };
		const validationReference = { artifactId: "validation-1", contentDigest: `sha256:${"4".repeat(64)}` };
		const evaluationReference = { artifactId: "evaluation-1", contentDigest: `sha256:${"5".repeat(64)}` };
		const expansionFailure = {
			type: "skill-candidate-expansion-failed",
			outlineId: "outline-failed",
			outlineKey: "failed-verification",
			proposedName: "failed-verification",
			operation: "CREATE",
			diagnostic: {
				reasonCode: "procedure-draft-invalid",
				message: "Skill candidate expansion failed after two independent model executions.",
				attempts: [
					{
						attempt: 1,
						modelRounds: 1,
						reasonCode: "procedure-draft-invalid",
						message: "The procedure draft did not satisfy the required contract.",
						inspectedReferences: { evidenceIds: ["evidence-1"], skillIds: [] },
						invalidFieldPaths: ["completionCondition"],
					},
					{
						attempt: 2,
						modelRounds: 2,
						reasonCode: "procedure-draft-invalid",
						message: "The procedure draft did not satisfy the required contract.",
						inspectedReferences: { evidenceIds: ["evidence-1"], skillIds: [] },
						invalidFieldPaths: ["verificationChecks"],
					},
				],
			},
		} as unknown as EvolutionLedgerEvent;
		const candidate = {
			artifactKind: "skill-candidate",
			metadata: { createdAt: "2026-08-20T00:00:00.000Z" },
			candidateId: "candidate-1",
			operation: "CREATE",
			proposedName: "focused-verification",
			existingSkillIds: [],
			sourceLessonIds: ["lesson-1"],
			supportingEvidenceIds: ["evidence-1"],
			contradictingEvidenceIds: [],
			supportingTraceIds: ["trace-1"],
			contradictingTraceIds: [],
			taskLineageIds: ["task-1"],
		} as unknown as SkillCandidate;
		const draft = {
			artifactKind: "skill-draft",
			draftId: "draft-1",
			groupId: "group-1",
			operation: "CREATE",
			proposedName: "focused-verification",
			content: "---\nname: focused-verification\ndescription: Verify focused changes.\n---\n\nRun checks.\n",
			files: [{ path: "scripts/check.sh", content: "#!/bin/sh\nexec npm run check\n" }],
		} as unknown as SkillDraft;
		const validation = {
			artifactKind: "skill-draft-validation",
			validationId: "validation-1",
			disposition: "accepted",
			issues: [],
		} as unknown as SkillDraftValidationReport;
		const evaluation = {
			artifactKind: "skill-evaluation",
			evaluationId: "evaluation-1",
			disposition: "accepted",
			gates: {
				suite: { passed: true, reasonCodes: [] },
				retrieval: { passed: true, reasonCodes: [] },
				behavior: { passed: true, reasonCodes: [] },
			},
		} as unknown as SkillEvaluationReport;
		const group = {
			groupId: "group-1",
			state: "accepted",
			dispositionHistory: [
				{
					eventId: "transition-1",
					from: "evaluation-pending",
					to: "accepted",
					reasonCodes: ["retrieval-and-behavior-gates-passed"],
					createdAt: "2026-08-20T00:00:02.000Z",
				},
			],
			proposalRevisions: [
				{
					revisionId: "revision-1",
					candidateId: candidate.candidateId,
					sourceEvolutionJobId: "job-1",
				},
			],
			draft: draftReference,
			validation: validationReference,
			evaluation: evaluationReference,
		} as unknown as SkillCandidateGroup;
		const supportingEvidence = {
			evidenceId: "evidence-1",
			kind: "session_item",
			itemType: "message",
			order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
			traceSources: [],
			payload: { message: { content: [{ type: "text", text: "The focused verification passed." }] } },
		} as MaterializedEvidence;
		const input = {
			ingestionHighWaterCursor: 1,
			evidenceSources: [
				{
					sourceId: "source-1",
					materializationId: "materialization-1",
					ingestionCursor: 1,
					origin: "product-runtime",
					contentDigest: computeEvolutionContentDigest("source-1"),
					invocation: { ...invocation(1), evidence: [supportingEvidence] },
				},
			],
			harness: { baseVersion: null },
			expectedHarnessBaseVersion: `sha256:${"a".repeat(64)}`,
			skillCatalog: [],
			tokenMeasurement: { estimatorVersion: "canonical-json-utf8-v1", estimatedTokens: 10 },
		} as unknown as EvolutionInputSnapshot;
		const job = {
			metadata: { scope },
			jobId: "job-1",
			inputSnapshot: inputReference,
			trigger: "manual",
			stage: "completed",
			outcome: "completed",
			reasonCode: null,
			failureMessage: null,
			completion: null,
			resolution: null,
			checkpoints: [
				{
					stage: "skill-curating",
					outputArtifacts: [candidateReference],
					state: { candidateIds: [candidate.candidateId] },
					completedAt: "2026-08-20T00:00:01.000Z",
				},
			],
			attempt: 0,
			revision: 1,
			createdAt: "2026-08-20T00:00:00.000Z",
			updatedAt: "2026-08-20T00:00:01.000Z",
			terminalAt: "2026-08-20T00:00:01.000Z",
		} as unknown as EvolutionJob;
		const artifacts = new Map<string, unknown>([
			[inputReference.artifactId, input],
			[candidateReference.artifactId, candidate],
			[draftReference.artifactId, draft],
			[validationReference.artifactId, validation],
			[evaluationReference.artifactId, evaluation],
		]);
		const targetHarnessVersion = `sha256:${"b".repeat(64)}`;
		const preservingDescendantVersion = `sha256:${"c".repeat(64)}`;
		let selectedHarnessVersion = input.expectedHarnessBaseVersion;
		const activate = vi.fn().mockImplementation(async () => {
			selectedHarnessVersion = targetHarnessVersion;
			return {
				groupId: group.groupId,
				batchId: "batch-1",
				targetHarnessVersion,
				receipt: {},
			};
		});
		const selectVersionIfCurrent = vi.fn(async (version: string, expectedCurrent: string) => {
			expect(selectedHarnessVersion).toBe(expectedCurrent);
			selectedHarnessVersion = version;
			return { status: "selected" as const, version };
		});
		const service = new EvolutionControlService({
			scope,
			jobs: { load: async () => job },
			artifacts: {
				get: async (reference: EvolutionArtifactReference) => artifacts.get(reference.artifactId),
			},
			harnesses: {
				listVersions: async () => ({
					currentVersion: selectedHarnessVersion,
					versions: [
						{
							manifest: { version: input.expectedHarnessBaseVersion, base: null },
							state: { memory: "", skills: [] },
						},
						{
							manifest: { version: targetHarnessVersion, base: input.expectedHarnessBaseVersion },
							state: {
								memory: "",
								skills: [
									{
										path: "skills/focused-verification/SKILL.md",
										workspace: { repositoryId: "diffex" },
										contentHash: computeEvolutionTextDigest(draft.content),
										files: draft.files.map((file) => ({
											path: file.path,
											contentHash: computeEvolutionTextDigest(file.content),
										})),
									},
								],
							},
						},
						{
							manifest: { version: preservingDescendantVersion, base: targetHarnessVersion },
							state: {
								memory: "Preserve the evolved skill while changing memory.",
								skills: [
									{
										path: "skills/focused-verification/SKILL.md",
										workspace: { repositoryId: "diffex" },
										contentHash: computeEvolutionTextDigest(draft.content),
										files: draft.files.map((file) => ({
											path: file.path,
											contentHash: computeEvolutionTextDigest(file.content),
										})),
									},
								],
							},
						},
					],
					diagnostics: [],
				}),
				selectVersionIfCurrent,
			},
			ledger: { read: async () => [expansionFailure] },
			skillCandidates: { list: async () => [group] },
			skillActivation: { activate },
			observedHarnessVersion: () => input.expectedHarnessBaseVersion,
		} as unknown as EvolutionControlServiceDependencies);

		expect(await service.getJob(job.jobId)).toMatchObject({
			observability: { evidenceTokens: 10 },
			skillCandidateExpansionFailures: [
				{
					outlineId: "outline-failed",
					proposedName: "failed-verification",
					operation: "CREATE",
					diagnostic: {
						reasonCode: "procedure-draft-invalid",
						attempts: [
							{ attempt: 1, modelRounds: 1 },
							{ attempt: 2, modelRounds: 2 },
						],
					},
				},
			],
			skillCandidates: [
				{
					candidateId: candidate.candidateId,
					groupId: group.groupId,
					proposedName: candidate.proposedName,
					operation: "CREATE",
					state: "accepted",
					latestTransitionAt: "2026-08-20T00:00:02.000Z",
					latestReasonCodes: ["retrieval-and-behavior-gates-passed"],
				},
			],
		});
		const detail = await service.getSkillCandidate(job.jobId, candidate.candidateId);
		expect(detail).toMatchObject({
			summary: {
				groupId: group.groupId,
				state: "accepted",
				latestTransitionAt: "2026-08-20T00:00:02.000Z",
				latestReasonCodes: ["retrieval-and-behavior-gates-passed"],
			},
			sourceEvolutionJobIds: [job.jobId],
			proposalRevisionIds: ["revision-1"],
			supportingEvidence: [supportingEvidence],
			contradictingEvidence: [],
			draft: { draftId: "draft-1" },
			validation: { disposition: "accepted" },
			evaluation: { disposition: "accepted" },
			targetHarnessVersion: null,
			rollbackAvailable: false,
			activationAvailable: true,
		});

		await expect(service.activateSkillCandidate(job.jobId, candidate.candidateId)).resolves.toMatchObject({
			batchId: "batch-1",
		});
		expect(activate).toHaveBeenCalledWith(scope, group.groupId);
		expect(await service.getSkillCandidate(job.jobId, candidate.candidateId)).toMatchObject({
			targetHarnessVersion,
			rollbackTargetHarnessVersion: input.expectedHarnessBaseVersion,
			rollbackAvailable: true,
			activationAvailable: false,
		});
		selectedHarnessVersion = preservingDescendantVersion;
		expect(await service.getSkillCandidate(job.jobId, candidate.candidateId)).toMatchObject({
			targetHarnessVersion: preservingDescendantVersion,
			rollbackTargetHarnessVersion: input.expectedHarnessBaseVersion,
			rollbackAvailable: true,
		});
		await expect(service.rollbackSkillCandidate(job.jobId, candidate.candidateId)).resolves.toMatchObject({
			fromHarnessVersion: preservingDescendantVersion,
			toHarnessVersion: input.expectedHarnessBaseVersion,
		});
		expect(selectVersionIfCurrent).toHaveBeenCalledWith(
			input.expectedHarnessBaseVersion,
			preservingDescendantVersion,
		);
	});

	it("reports durable latency, budget, coverage, conflict, and recovery observability", async () => {
		const fixture = await serviceFixture();
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");

		await fixture.controlPlane.runJob(started.job.jobId);
		const detail = await fixture.service.getJob(started.job.jobId);
		expect((await fixture.service.overview()).lastEvolutionAt).toBe(detail.terminalAt);

		expect(detail.observability).toEqual({
			queueAgeMs: expect.any(Number),
			stageLatencies: [
				{ stage: "snapshotting", durationMs: expect.any(Number) },
				{ stage: "counter-slot", durationMs: expect.any(Number) },
				{ stage: "reflecting", durationMs: expect.any(Number) },
				{ stage: "curating", durationMs: expect.any(Number) },
				{ stage: "validating", durationMs: expect.any(Number) },
				{ stage: "skill-curating", durationMs: expect.any(Number) },
			],
			evidenceTokens: expect.any(Number),
			providerCostUsd: null,
			reflectorBudget: { modelCalls: 0, reflectionRounds: 0, toolCalls: 0 },
			sliceCoverage: null,
			proposalDispositions: {
				applied: 0,
				deferred: 0,
				failed: 0,
				quarantined: 0,
				rejected: 0,
				"rolled-back": 0,
				superseded: 0,
				unselected: 0,
			},
			activationConflicts: 0,
			rollbackAvailable: false,
			recoveryAttempts: 0,
		});
		expect(detail.observability.queueAgeMs).toBeGreaterThanOrEqual(0);
		expect(detail.observability.stageLatencies.every((entry) => entry.durationMs >= 0)).toBe(true);
	});
});
