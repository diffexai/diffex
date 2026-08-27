import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionInputSnapshot,
	type EvolutionJob,
	type EvolutionJobStore,
	type EvolutionScope,
	PollingSkillCandidateWorkSource,
	type SkillCandidate,
	type SkillCandidateGroup,
	type SkillCandidateRegistry,
	type SkillCandidateRegistryAppendResult,
	type SkillCandidateRegistryConsolidationInput,
	type SkillCandidateRegistryEvent,
	type SkillCandidateRegistrySnapshot,
	type SkillCandidateRegistryStore,
	SkillCandidateRegistryWorker,
} from "../src/index.ts";

const now = "2026-08-25T12:00:00.000Z";
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1",
	promptVersion: null,
	model: null,
};

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt: now, content });
}

function inputSnapshot(): EvolutionInputSnapshot {
	const memory = "# Evolution memory\n";
	return {
		metadata: metadata("input-1", [], { trigger: "manual" }),
		trigger: "manual",
		repository: {
			repositoryId: "diffex",
			directoryId: "directory-1",
			rootPath: "/repo",
			revision: "revision-1",
		},
		harness: {
			harnessVersion: `sha256:${"2".repeat(64)}`,
			baseVersion: `sha256:${"1".repeat(64)}`,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [],
		},
		expectedHarnessBaseVersion: `sha256:${"2".repeat(64)}`,
		ingestionHighWaterCursor: 0,
		instructions: [],
		skillCatalog: [],
		modelConfiguration: {
			provider: "faux",
			model: "fixture",
			configurationDigest: `sha256:${"4".repeat(64)}`,
		},
		pipelineVersion: "pipeline-v1",
		promptVersions: {
			reflector: "reflector-v1",
			curator: "curator-v1",
			skillCurator: "skill-curator-v1",
			validator: "validator-v1",
			writer: "writer-v1",
		},
		tokenMeasurement: { estimatorVersion: "fixture", estimatedTokens: 100 },
		evidenceSources: [],
	};
}

function candidate(): SkillCandidate {
	return {
		artifactKind: "skill-candidate",
		candidateId: "candidate-1",
		metadata: metadata("candidate-1", [], { artifactKind: "skill-candidate", candidateId: "candidate-1" }),
	} as unknown as SkillCandidate;
}

function reference(artifact: EvolutionArtifact): EvolutionArtifactReference {
	return {
		artifactId: artifact.metadata.artifactId,
		contentDigest: computeEvolutionContentDigest(artifact),
	};
}

function completedJob(
	inputReference: EvolutionArtifactReference,
	candidateReference: EvolutionArtifactReference,
): EvolutionJob {
	const checkpoint = {
		schemaVersion: 1 as const,
		stage: "skill-curating" as const,
		idempotencyKey: "job-1:skill-curating",
		outputArtifacts: [candidateReference],
		state: {
			candidateIds: ["candidate-1"],
			deferredFindingIds: [],
			selectedMemoryProposalIds: [],
		},
		completedAt: now,
	};
	const content: Omit<EvolutionJob, "metadata"> = {
		jobId: "job-1",
		inputSnapshot: inputReference,
		trigger: "manual",
		evidenceRange: { afterCursor: 0, throughCursor: 1 },
		stage: "completed",
		outcome: "completed",
		reasonCode: null,
		failureMessage: null,
		completion: { kind: "no-op", resultingHarnessVersion: null, processedEvidenceCursor: 1 },
		resolution: null,
		checkpoints: [checkpoint],
		attempt: 1,
		revision: 3,
		createdAt: now,
		updatedAt: now,
		terminalAt: now,
		retryNotBefore: null,
	};
	return {
		metadata: metadata(content.jobId, [inputReference.artifactId], content),
		...content,
	};
}

class MemoryJobStore implements EvolutionJobStore {
	readonly jobs: EvolutionJob[];

	constructor(jobs: readonly EvolutionJob[]) {
		this.jobs = [...jobs];
	}

	async create(): Promise<void> {}
	async save(): Promise<void> {}

	async load(jobId: string): Promise<EvolutionJob | null> {
		return this.jobs.find((job) => job.jobId === jobId) ?? null;
	}

	async list(): Promise<readonly EvolutionJob[]> {
		return this.jobs;
	}
}

class MemoryArtifactStore implements EvolutionArtifactStore {
	readonly artifacts: ReadonlyMap<string, EvolutionArtifact>;

	constructor(artifacts: readonly EvolutionArtifact[]) {
		this.artifacts = new Map(artifacts.map((artifact) => [reference(artifact).contentDigest, artifact]));
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		return reference(artifact);
	}

	async get(artifactReference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.artifacts.get(artifactReference.contentDigest);
		if (artifact === undefined) throw new Error("Unknown artifact");
		return artifact;
	}
}

class MemoryRegistryStore implements SkillCandidateRegistryStore {
	readonly events: SkillCandidateRegistryEvent[] = [];

	async loadSkillCandidateRegistry(): Promise<SkillCandidateRegistrySnapshot> {
		return { revision: this.events.length, events: [...this.events] };
	}

	async appendSkillCandidateRegistryEvents(
		_scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
	): Promise<SkillCandidateRegistryAppendResult> {
		if (this.events.length !== expectedRevision) return "conflict";
		this.events.push(...events);
		return "committed";
	}
}

class FixtureRegistry implements SkillCandidateRegistry {
	readonly requests: SkillCandidateRegistryConsolidationInput[] = [];
	failuresRemaining = 0;

	async consolidate(
		input: SkillCandidateRegistryConsolidationInput,
	): Promise<{ readonly groups: readonly SkillCandidateGroup[]; readonly changedGroupIds: readonly string[] }> {
		this.requests.push(input);
		if (this.failuresRemaining > 0) {
			this.failuresRemaining -= 1;
			throw new Error("registry unavailable");
		}
		return { groups: [], changedGroupIds: ["group-1"] };
	}

	async list(): Promise<readonly SkillCandidateGroup[]> {
		return [];
	}
}

function fixture() {
	const input = inputSnapshot();
	const skillCandidate = candidate();
	const inputReference = reference(input);
	const candidateReference = reference(skillCandidate);
	const job = completedJob(inputReference, candidateReference);
	const jobs = new MemoryJobStore([job]);
	const store = new MemoryRegistryStore();
	const registry = new FixtureRegistry();
	let clockTime = now;
	const clock = { now: () => clockTime };
	return {
		job,
		jobs,
		store,
		registry,
		clock,
		setClock(value: string) {
			clockTime = value;
		},
		worker: new SkillCandidateRegistryWorker({
			version: "1",
			clock,
			jobs,
			artifacts: new MemoryArtifactStore([input, skillCandidate]),
			store,
			registry,
		}),
	};
}

describe("skill candidate registry worker", () => {
	it("discovers only completed evolution jobs with unfinished candidate work", async () => {
		const data = fixture();
		const source = new PollingSkillCandidateWorkSource({ clock: data.clock, jobs: data.jobs, store: data.store });

		expect(await source.nextRunnableJob(now)).toBe(data.job.jobId);
		await data.worker.process(data.job.jobId);
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("loads checkpointed immutable candidates and records resumable work checkpoints", async () => {
		const data = fixture();

		await data.worker.process(data.job.jobId);
		await data.worker.process(data.job.jobId);

		expect(data.registry.requests).toHaveLength(1);
		expect(data.registry.requests[0]).toMatchObject({
			sourceEvolutionJobId: "job-1",
			candidates: [{ candidate: { candidateId: "candidate-1" } }],
		});
		expect(
			data.store.events.flatMap((event) =>
				event.type === "skill-candidate-work-checkpointed" ? [event.stage] : [],
			),
		).toEqual(["consolidating", "scoring", "completed"]);
		expect(
			data.store.events
				.filter((event) => event.type === "skill-candidate-work-checkpointed")
				.map((event) => event.idempotencyKey),
		).toEqual([
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
		]);
	});

	it("persists bounded retry timing without marking failed work complete", async () => {
		const data = fixture();
		data.registry.failuresRemaining = 1;
		const source = new PollingSkillCandidateWorkSource({ clock: data.clock, jobs: data.jobs, store: data.store });

		await expect(data.worker.process(data.job.jobId)).rejects.toThrow("registry unavailable");
		const failure = data.store.events.find((event) => event.type === "skill-candidate-work-failed");
		expect(failure).toMatchObject({
			sourceEvolutionJobId: "job-1",
			attempt: 1,
			retryNotBefore: "2026-08-25T12:00:05.000Z",
		});
		expect(await source.nextRunnableJob(now)).toBeNull();

		data.setClock("2026-08-25T12:00:05.000Z");
		expect(await source.nextRunnableJob(data.clock.now())).toBe("job-1");
		await data.worker.process(data.job.jobId);
		expect(
			data.store.events.some((event) => event.type === "skill-candidate-work-failed" && event.attempt === 2),
		).toBe(false);
		expect(
			data.store.events.some(
				(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
			),
		).toBe(true);
	});
});
