import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifactProducer,
	type EvolutionJob,
	type EvolutionLeaseToken,
	type EvolutionLedgerEvent,
	type EvolutionScope,
	EvolutionStorageCorruptionError,
	FileEvolutionPersistence,
	type InstructionSnapshot,
	planEvolutionRetention,
	SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
	type SkillCandidateRegistryEvent,
} from "../src/index.ts";

const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1.0.0",
	promptVersion: null,
	model: null,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function storeFixture(): Promise<{ readonly root: string; readonly store: FileEvolutionPersistence }> {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-store-"));
	temporaryDirectories.push(root);
	return { root, store: new FileEvolutionPersistence(root) };
}

function instructionSnapshot(): InstructionSnapshot {
	const documents = [
		{
			path: "/repo/AGENTS.md",
			precedence: 1,
			content: "Keep durable state fenced.\n",
			contentDigest: computeEvolutionContentDigest("Keep durable state fenced.\n"),
		},
	];
	return {
		metadata: createEvolutionArtifactMetadata({
			artifactId: "instructions-1",
			producer,
			sourceIds: [],
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
			content: documents,
		}),
		documents,
	};
}

function job(reference: EvolutionJob["inputSnapshot"]): EvolutionJob {
	const createdAt = new Date().toISOString();
	const content: Omit<EvolutionJob, "metadata"> = {
		jobId: "job-1",
		inputSnapshot: reference,
		trigger: "manual",
		evidenceRange: { afterCursor: 0, throughCursor: 3 },
		stage: "queued",
		outcome: "active",
		reasonCode: null,
		failureMessage: null,
		completion: null,
		resolution: null,
		checkpoints: [],
		attempt: 0,
		revision: 0,
		createdAt,
		updatedAt: createdAt,
		terminalAt: null,
		retryNotBefore: null,
	};
	return {
		...content,
		metadata: createEvolutionArtifactMetadata({
			artifactId: content.jobId,
			producer,
			sourceIds: [reference.artifactId],
			scope,
			createdAt,
			content,
		}),
	};
}

function ledgerEvent(eventId: string, inputSnapshotId: string): EvolutionLedgerEvent {
	const content = { inputSnapshotId };
	return {
		metadata: createEvolutionArtifactMetadata({
			artifactId: eventId,
			producer,
			sourceIds: ["job-1"],
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
			content,
		}),
		eventId,
		jobId: "job-1",
		type: "job-created",
		inputSnapshotId,
	};
}

function candidateWorkEvent(eventId: string, registrySequence: number): SkillCandidateRegistryEvent {
	const content = {
		schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
		eventId,
		registrySequence,
		type: "skill-candidate-work-checkpointed" as const,
		workId: "candidate-work-1",
		sourceEvolutionJobId: "job-1",
		stage: "consolidating" as const,
		idempotencyKey: "candidate-work-1:consolidating",
		attempt: 1,
		groupIds: [],
	};
	return {
		metadata: createEvolutionArtifactMetadata({
			artifactId: eventId,
			producer,
			sourceIds: ["job-1"],
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
			content,
		}),
		...content,
	};
}

function candidateEvaluationEvent(eventId: string, registrySequence: number): SkillCandidateRegistryEvent {
	const reference = (artifactId: string) => ({ artifactId, contentDigest: `sha256:${"a".repeat(64)}` });
	const content = {
		schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
		eventId,
		registrySequence,
		type: "skill-candidate-evaluation-recorded" as const,
		groupId: "group-1",
		draft: reference("draft-1"),
		validation: reference("validation-1"),
		evaluation: reference("evaluation-1"),
		proposalRevisionIds: ["proposal-revision-1"],
		idempotencyKey: "evaluation-key-1",
	};
	return {
		metadata: createEvolutionArtifactMetadata({
			artifactId: eventId,
			producer,
			sourceIds: ["group-1"],
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
			content,
		}),
		...content,
	};
}

async function scopeLease(store: FileEvolutionPersistence, ownerId: string): Promise<EvolutionLeaseToken> {
	const lease = await store.acquire(
		"scope",
		computeEvolutionContentDigest(scope),
		ownerId,
		new Date().toISOString(),
		5_000,
	);
	if (lease === null) throw new Error("Expected fixture scope lease");
	return lease;
}

describe("filesystem evolution persistence", () => {
	it("stores immutable artifacts by content digest and detects corruption", async () => {
		const { root, store } = await storeFixture();
		const artifact = instructionSnapshot();

		const first = await store.put(artifact);
		const second = await store.put(artifact);
		expect(second).toEqual(first);
		expect(await store.get(first)).toEqual(artifact);

		const artifactPath = join(root, "artifacts", first.contentDigest.replace("sha256:", "sha256-"), "artifact.json");
		await writeFile(artifactPath, "{}\n", "utf8");
		await expect(store.get(first)).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
	});

	it("rejects unsupported artifact, job, and ledger schema versions", async () => {
		const { store } = await storeFixture();
		const artifact = instructionSnapshot();
		const incompatibleArtifact = {
			...artifact,
			metadata: { ...artifact.metadata, schemaVersion: 2 },
		} as unknown as InstructionSnapshot;
		await expect(store.put(incompatibleArtifact)).rejects.toThrow("metadata is invalid or incompatible");

		const reference = await store.put(artifact);
		const lease = await scopeLease(store, "owner-1");
		const compatibleJob = job(reference);
		const incompatibleJob = {
			...compatibleJob,
			metadata: { ...compatibleJob.metadata, schemaVersion: 2 },
		} as unknown as EvolutionJob;
		await expect(store.create(incompatibleJob, lease)).rejects.toThrow("metadata is invalid or incompatible");

		const event = ledgerEvent("event-1", reference.artifactId);
		const incompatibleEvent = {
			...event,
			metadata: { ...event.metadata, schemaVersion: 2 },
		} as unknown as EvolutionLedgerEvent;
		await expect(store.append(incompatibleEvent)).rejects.toThrow("metadata is invalid or incompatible");
	});

	it("keeps ledger event IDs append-only and idempotent", async () => {
		const { store } = await storeFixture();
		const first = ledgerEvent("event-1", "input-1");
		await store.append(first);
		await expect(store.append(first)).resolves.toBeUndefined();

		await expect(store.append(ledgerEvent("event-1", "input-2"))).rejects.toThrow(
			"ledger event ID was reused with different content",
		);
		expect(await store.read("job-1")).toEqual([first]);
	});

	it("persists append-only candidate registry events with revision conflicts", async () => {
		const { root, store } = await storeFixture();
		const peer = new FileEvolutionPersistence(root);
		const first = candidateWorkEvent("candidate-event-1", 1);

		const evaluation = candidateEvaluationEvent("candidate-event-2", 2);
		expect(await store.appendSkillCandidateRegistryEvents(scope, 0, [first, evaluation])).toBe("committed");
		expect(await peer.loadSkillCandidateRegistry(scope)).toEqual({ revision: 2, events: [first, evaluation] });
		expect(
			await peer.appendSkillCandidateRegistryEvents(scope, 0, [candidateWorkEvent("candidate-event-3", 1)]),
		).toBe("conflict");
		await expect(
			peer.appendSkillCandidateRegistryEvents(scope, 2, [candidateWorkEvent("candidate-event-3", 4)]),
		).rejects.toThrow("contiguous sequence");
	});

	it("detects corrupted candidate registry history", async () => {
		const { root, store } = await storeFixture();
		const first = candidateWorkEvent("candidate-event-1", 1);
		await store.appendSkillCandidateRegistryEvents(scope, 0, [first]);
		const scopeDirectory = computeEvolutionContentDigest(scope).replace("sha256:", "sha256-");
		await writeFile(join(root, "skill-candidates", scopeDirectory, first.eventId, "event.json"), "{}\n", "utf8");

		await expect(store.loadSkillCandidateRegistry(scope)).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
	});

	it("fences stale scope owners from job and cursor mutations", async () => {
		const { store } = await storeFixture();
		const artifactReference = await store.put(instructionSnapshot());
		const firstLease = await scopeLease(store, "owner-1");
		await expect(store.assertHeld(firstLease)).resolves.toBeUndefined();
		await store.create(job(artifactReference), firstLease);

		const takeoverTime = new Date(Date.parse(firstLease.expiresAt) + 1).toISOString();
		const secondLease = await store.acquire(
			"scope",
			computeEvolutionContentDigest(scope),
			"owner-2",
			takeoverTime,
			5_000,
		);
		if (secondLease === null) throw new Error("Expected stale lease takeover");
		expect(secondLease.fence).toBe(firstLease.fence + 1);
		await expect(store.assertHeld(firstLease)).rejects.toThrow("lease was lost");
		await expect(store.commit(scope, 0, 3, "job-1", new Date().toISOString(), firstLease)).rejects.toThrow(
			"lease was lost",
		);
		expect(await store.commit(scope, 0, 3, "job-1", new Date().toISOString(), secondLease)).toBe("committed");
		expect(await store.commit(scope, 0, 3, "job-1", new Date().toISOString(), secondLease)).toBe("already-committed");
	});

	it("admits only one owner across concurrent persistence instances", async () => {
		const { root, store } = await storeFixture();
		const peer = new FileEvolutionPersistence(root);
		const now = new Date().toISOString();
		const key = computeEvolutionContentDigest(scope);

		const leases = await Promise.all([
			store.acquire("scope", key, "owner-1", now, 5_000),
			peer.acquire("scope", key, "owner-2", now, 5_000),
		]);

		expect(leases.filter((lease) => lease !== null)).toHaveLength(1);
		expect(leases.filter((lease) => lease === null)).toHaveLength(1);
	});

	it("shares idempotent durable cancellation requests across persistence instances", async () => {
		const { root, store } = await storeFixture();
		const peer = new FileEvolutionPersistence(root);
		const requestedAt = "2026-08-20T12:00:00.000Z";

		expect(await store.requestCancellation("job-1", requestedAt)).toEqual({ jobId: "job-1", requestedAt });
		expect(await peer.loadCancellation("job-1")).toEqual({ jobId: "job-1", requestedAt });
		expect(await peer.requestCancellation("job-1", "2026-08-20T12:01:00.000Z")).toEqual({
			jobId: "job-1",
			requestedAt,
		});
	});

	it("uses compare-and-swap revisions for durable job manifests", async () => {
		const { store } = await storeFixture();
		const reference = await store.put(instructionSnapshot());
		const lease = await scopeLease(store, "owner-1");
		const initial = job(reference);
		await store.create(initial, lease);
		const { metadata: _metadata, ...initialContent } = initial;
		const advancedContent: Omit<EvolutionJob, "metadata"> = {
			...initialContent,
			stage: "snapshotting",
			revision: 1,
			updatedAt: new Date().toISOString(),
		};
		const advanced: EvolutionJob = {
			...advancedContent,
			metadata: createEvolutionArtifactMetadata({
				artifactId: advancedContent.jobId,
				producer,
				sourceIds: [reference.artifactId],
				scope,
				createdAt: advancedContent.createdAt,
				content: advancedContent,
			}),
		};

		await store.save(advanced, 0, lease);
		await expect(store.save(advanced, 0, lease)).rejects.toThrow("revision conflict");
		expect(await store.load(initial.jobId)).toMatchObject({ stage: "snapshotting", revision: 1 });
	});

	it("retains unresolved failures while expiring completed audit state", () => {
		const reference = { artifactId: "input-1", contentDigest: `sha256:${"a".repeat(64)}` };
		const initial = job(reference);
		const terminalAt = "2026-01-01T00:00:00.000Z";
		const completed: EvolutionJob = {
			...initial,
			jobId: "job-completed",
			stage: "completed",
			outcome: "completed",
			terminalAt,
			completion: { kind: "no-op", resultingHarnessVersion: null, processedEvidenceCursor: 3 },
		};
		const failed: EvolutionJob = {
			...initial,
			jobId: "job-failed",
			outcome: "terminal-failed",
			reasonCode: "artifact-corrupt",
			failureMessage: "corrupt artifact",
			terminalAt,
		};

		expect(planEvolutionRetention([completed, failed], "2026-03-01T00:00:00.000Z")).toEqual({
			removableJobIds: ["job-completed"],
			retainedBlockingJobIds: ["job-failed"],
		});
	});
});
