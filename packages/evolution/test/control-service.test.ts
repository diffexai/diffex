import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import type { MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	EvolutionBackgroundWorker,
	EvolutionControlPlane,
	EvolutionControlService,
	EvolutionProgressBus,
	type EvolutionScope,
	type EvolutionSnapshotContext,
	FileEvolutionPersistence,
	PollingEvolutionWorkSource,
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
	#timestamp = Date.parse("2026-08-20T12:00:00.000Z");

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
		evidence: [],
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
}

async function serviceFixture(): Promise<ServiceFixture> {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-service-"));
	temporaryDirectories.push(root);
	const store = new FileEvolutionPersistence(join(root, "evolution"));
	const harnesses = new HarnessStateStore(join(root, "agent"));
	const harness = await harnesses.initialize();
	const clock = new FixedClock();
	const progress = new EvolutionProgressBus();
	const materializations = [materialization(1), materialization(2), materialization(3)];
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
				modelConfiguration: {
					provider: "faux",
					model: "fixture",
					configurationDigest: computeEvolutionContentDigest("fixture"),
				},
				pipelineVersion: "pipeline-v1",
				promptVersions: {
					reflector: "reflector-v1",
					curator: "curator-v1",
					validator: "validator-v1",
					writer: "writer-v1",
				},
			};
		},
	};
	const evidence = {
		async highWaterCursor() {
			return 3;
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
			cursors: store,
			leases: store,
			ledger: store,
			events: progress,
			evidence,
			snapshots,
			executor: {
				async execute() {
					throw new Error("The service fixture does not execute pipeline stages");
				},
			},
		},
		{ leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 },
	);
	const worker = new EvolutionBackgroundWorker({
		clock,
		source: new PollingEvolutionWorkSource(store, clock, { pollIntervalMs: 60_000 }),
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
	});
	return { service, store, progress };
}

describe("evolution control service", () => {
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

		const started = await fixture.service.startManual();
		expect(started.status).toBe("created");
		const attached = await fixture.service.startManual();
		expect(attached).toMatchObject({
			status: "attached",
			job: { jobId: started.status === "created" ? started.job.jobId : "" },
		});
		expect(events).toHaveLength(1);
		unsubscribe();
		await fixture.service.cancelActive();
		expect(events).toHaveLength(1);
	});

	it("cancels queued work and explicitly resumes the newest interrupted job", async () => {
		const fixture = await serviceFixture();
		const started = await fixture.service.startManual();
		if (started.status !== "created") throw new Error("Expected a created job");

		const cancelled = await fixture.service.cancelActive();
		expect(cancelled).toMatchObject({
			jobId: started.job.jobId,
			outcome: "interrupted",
			reasonCode: "cancelled-by-operator",
			resumable: true,
		});
		expect((await fixture.service.overview()).newestResumableJob?.jobId).toBe(started.job.jobId);

		const resumed = await fixture.service.resumeNewest();
		expect(resumed).toMatchObject({ jobId: started.job.jobId, outcome: "active", resumable: false });
		expect(await fixture.store.load(started.job.jobId)).toMatchObject({ attempt: 1, retryNotBefore: null });
	});
});
