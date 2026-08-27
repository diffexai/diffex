import type {
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionScope,
	SkillCandidate,
	SkillCandidateRegistryEvent,
	SkillCandidateWorkCheckpointedEvent,
	SkillCandidateWorkFailedEvent,
	SkillCandidateWorkStage,
} from "./contracts.ts";
import { SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION } from "./contracts.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionClock,
	EvolutionJobStore,
	InteractivePriorityGate,
	SkillCandidateRegistry,
	SkillCandidateRegistryStore,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_FAILURE_BACKOFF_MS = 5_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_APPEND_ATTEMPTS = 5;

export interface PollingSkillCandidateWorkSourceDependencies {
	readonly clock: EvolutionClock;
	readonly jobs: EvolutionJobStore;
	readonly store: SkillCandidateRegistryStore;
}

export interface PollingSkillCandidateWorkSourceOptions {
	readonly pollIntervalMs?: number;
}

export interface SkillCandidateWorkProcessor {
	process(sourceEvolutionJobId: string, signal?: AbortSignal): Promise<void>;
}

export interface SkillCandidateRegistryWorkerDependencies {
	readonly version: string;
	readonly clock: EvolutionClock;
	readonly jobs: EvolutionJobStore;
	readonly artifacts: EvolutionArtifactStore;
	readonly store: SkillCandidateRegistryStore;
	readonly registry: SkillCandidateRegistry;
}

export interface SkillCandidateRegistryWorkerOptions {
	readonly maxAttempts?: number;
	readonly retryBaseDelayMs?: number;
	readonly retryMaxDelayMs?: number;
}

export interface SkillCandidateBackgroundWorkerDependencies {
	readonly clock: EvolutionClock;
	readonly source: PollingSkillCandidateWorkSource;
	readonly processor: SkillCandidateWorkProcessor;
	readonly priority: InteractivePriorityGate;
}

export interface SkillCandidateBackgroundWorkerOptions {
	readonly failureBackoffMs?: number;
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function nonNegativeDuration(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} must be non-negative`);
	return resolved;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Skill candidate background worker stopped");
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function hasSkillCandidates(job: EvolutionJob): boolean {
	const checkpoint = job.checkpoints.find((candidate) => candidate.stage === "skill-curating");
	return (
		checkpoint !== undefined &&
		Array.isArray(checkpoint.state.candidateIds) &&
		checkpoint.state.candidateIds.length > 0
	);
}

function workEvents(
	events: readonly SkillCandidateRegistryEvent[],
	sourceEvolutionJobId: string,
): readonly (SkillCandidateWorkCheckpointedEvent | SkillCandidateWorkFailedEvent)[] {
	return events.filter(
		(event): event is SkillCandidateWorkCheckpointedEvent | SkillCandidateWorkFailedEvent =>
			(event.type === "skill-candidate-work-checkpointed" || event.type === "skill-candidate-work-failed") &&
			event.sourceEvolutionJobId === sourceEvolutionJobId,
	);
}

function isInputSnapshot(artifact: EvolutionArtifact): artifact is EvolutionInputSnapshot {
	return "evidenceSources" in artifact && "repository" in artifact && "harness" in artifact && "trigger" in artifact;
}

function isSkillCandidate(artifact: EvolutionArtifact): artifact is SkillCandidate {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-candidate";
}

function retryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export class PollingSkillCandidateWorkSource {
	readonly #dependencies: PollingSkillCandidateWorkSourceDependencies;
	readonly #pollIntervalMs: number;

	constructor(
		dependencies: PollingSkillCandidateWorkSourceDependencies,
		options: PollingSkillCandidateWorkSourceOptions = {},
	) {
		this.#dependencies = dependencies;
		this.#pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
	}

	async nextRunnableJob(now: string, signal?: AbortSignal): Promise<string | null> {
		signal?.throwIfAborted();
		const nowMs = Date.parse(now);
		if (!Number.isFinite(nowMs)) throw new Error("Skill candidate worker time must be a valid ISO timestamp");
		const jobs = (await this.#dependencies.jobs.list())
			.filter((job) => job.outcome === "completed" && job.stage === "completed" && hasSkillCandidates(job))
			.sort(
				(left, right) =>
					(left.terminalAt ?? left.updatedAt).localeCompare(right.terminalAt ?? right.updatedAt) ||
					left.jobId.localeCompare(right.jobId),
			);
		for (const job of jobs) {
			const snapshot = await this.#dependencies.store.loadSkillCandidateRegistry(job.metadata.scope);
			const events = workEvents(snapshot.events, job.jobId);
			if (
				events.some((event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed")
			) {
				continue;
			}
			const latestFailure = events
				.filter((event): event is SkillCandidateWorkFailedEvent => event.type === "skill-candidate-work-failed")
				.sort((left, right) => right.attempt - left.attempt)[0];
			if (latestFailure?.retryNotBefore === null) continue;
			if (latestFailure !== undefined && Date.parse(latestFailure.retryNotBefore) > nowMs) continue;
			signal?.throwIfAborted();
			return job.jobId;
		}
		return null;
	}

	waitForWork(signal: AbortSignal): Promise<void> {
		return wait(this.#pollIntervalMs, signal);
	}
}

export class SkillCandidateRegistryWorker implements SkillCandidateWorkProcessor {
	readonly #dependencies: SkillCandidateRegistryWorkerDependencies;
	readonly #producer: EvolutionArtifactProducer;
	readonly #maxAttempts: number;
	readonly #retryBaseDelayMs: number;
	readonly #retryMaxDelayMs: number;

	constructor(
		dependencies: SkillCandidateRegistryWorkerDependencies,
		options: SkillCandidateRegistryWorkerOptions = {},
	) {
		this.#dependencies = dependencies;
		this.#producer = {
			name: "diffex-skill-candidate-worker",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
		this.#maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
		this.#retryBaseDelayMs = nonNegativeDuration(
			options.retryBaseDelayMs,
			DEFAULT_RETRY_BASE_DELAY_MS,
			"retryBaseDelayMs",
		);
		this.#retryMaxDelayMs = nonNegativeDuration(
			options.retryMaxDelayMs,
			DEFAULT_RETRY_MAX_DELAY_MS,
			"retryMaxDelayMs",
		);
		if (this.#retryMaxDelayMs < this.#retryBaseDelayMs) {
			throw new Error("retryMaxDelayMs must be at least retryBaseDelayMs");
		}
	}

	#metadata(
		eventId: string,
		sourceIds: readonly string[],
		scope: EvolutionScope,
		createdAt: string,
		content: unknown,
	): EvolutionArtifactMetadata {
		return createEvolutionArtifactMetadata({
			artifactId: eventId,
			producer: this.#producer,
			sourceIds,
			scope,
			createdAt,
			content,
		});
	}

	async #appendCheckpoint(
		job: EvolutionJob,
		stage: SkillCandidateWorkStage,
		attempt: number,
		groupIds: readonly string[],
	): Promise<void> {
		const idempotencyKey = stableId("skill-candidate-work-stage", { sourceEvolutionJobId: job.jobId, stage });
		await this.#appendEvent(job.metadata.scope, (registrySequence, existing) => {
			if (
				existing.some(
					(event) =>
						event.type === "skill-candidate-work-checkpointed" &&
						event.sourceEvolutionJobId === job.jobId &&
						event.stage === stage,
				)
			) {
				return null;
			}
			const workId = stableId("skill-candidate-work", { sourceEvolutionJobId: job.jobId });
			const content = {
				schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
				eventId: stableId("skill-candidate-work-event", { idempotencyKey, registrySequence }),
				registrySequence,
				type: "skill-candidate-work-checkpointed" as const,
				workId,
				sourceEvolutionJobId: job.jobId,
				stage,
				idempotencyKey,
				attempt,
				groupIds: [...groupIds].sort((left, right) => left.localeCompare(right)),
			};
			return {
				metadata: this.#metadata(
					content.eventId,
					[job.jobId, ...content.groupIds],
					job.metadata.scope,
					this.#dependencies.clock.now(),
					content,
				),
				...content,
			};
		});
	}

	async #appendFailure(job: EvolutionJob, attempt: number, error: unknown): Promise<void> {
		const idempotencyKey = stableId("skill-candidate-work-failure", {
			sourceEvolutionJobId: job.jobId,
			attempt,
		});
		await this.#appendEvent(job.metadata.scope, (registrySequence, existing) => {
			if (
				existing.some(
					(event) =>
						event.type === "skill-candidate-work-failed" &&
						event.sourceEvolutionJobId === job.jobId &&
						event.attempt === attempt,
				)
			) {
				return null;
			}
			const now = this.#dependencies.clock.now();
			const content = {
				schemaVersion: SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION,
				eventId: stableId("skill-candidate-work-event", { idempotencyKey, registrySequence }),
				registrySequence,
				type: "skill-candidate-work-failed" as const,
				workId: stableId("skill-candidate-work", { sourceEvolutionJobId: job.jobId }),
				sourceEvolutionJobId: job.jobId,
				idempotencyKey,
				attempt,
				message: error instanceof Error ? error.message : String(error),
				retryNotBefore:
					attempt >= this.#maxAttempts
						? null
						: new Date(
								Date.parse(now) + retryDelay(attempt, this.#retryBaseDelayMs, this.#retryMaxDelayMs),
							).toISOString(),
			};
			return {
				metadata: this.#metadata(content.eventId, [job.jobId], job.metadata.scope, now, content),
				...content,
			};
		});
	}

	async #appendEvent(
		scope: EvolutionScope,
		build: (
			registrySequence: number,
			existing: readonly SkillCandidateRegistryEvent[],
		) => SkillCandidateRegistryEvent | null,
	): Promise<void> {
		for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
			const snapshot = await this.#dependencies.store.loadSkillCandidateRegistry(scope);
			const event = build(snapshot.revision + 1, snapshot.events);
			if (event === null) return;
			const result = await this.#dependencies.store.appendSkillCandidateRegistryEvents(scope, snapshot.revision, [
				event,
			]);
			if (result === "committed") return;
		}
		throw new Error("Skill candidate work history changed too often to append an event");
	}

	async process(sourceEvolutionJobId: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const job = await this.#dependencies.jobs.load(sourceEvolutionJobId);
		if (job === null || job.outcome !== "completed" || job.stage !== "completed") {
			throw new Error(`Evolution job "${sourceEvolutionJobId}" is not completed candidate work`);
		}
		const skillCheckpoint = job.checkpoints.find((checkpoint) => checkpoint.stage === "skill-curating");
		if (skillCheckpoint === undefined || !hasSkillCandidates(job)) {
			throw new Error(`Evolution job "${sourceEvolutionJobId}" has no checkpointed skill candidates`);
		}
		const history = workEvents(
			(await this.#dependencies.store.loadSkillCandidateRegistry(job.metadata.scope)).events,
			job.jobId,
		);
		if (history.some((event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed")) {
			return;
		}
		const attempt = history.filter((event) => event.type === "skill-candidate-work-failed").length + 1;
		if (attempt > this.#maxAttempts) throw new Error(`Skill candidate work for "${job.jobId}" exhausted retries`);

		try {
			await this.#appendCheckpoint(job, "consolidating", attempt, []);
			const inputArtifact = await this.#dependencies.artifacts.get(job.inputSnapshot);
			if (!isInputSnapshot(inputArtifact)) throw new Error("Evolution job input snapshot artifact is invalid");
			const artifacts = await Promise.all(
				skillCheckpoint.outputArtifacts.map(async (reference) => ({
					reference,
					artifact: await this.#dependencies.artifacts.get(reference),
				})),
			);
			const candidates = artifacts.flatMap((item) =>
				isSkillCandidate(item.artifact) ? [{ candidate: item.artifact, reference: item.reference }] : [],
			);
			const expectedCandidateIds = Array.isArray(skillCheckpoint.state.candidateIds)
				? skillCheckpoint.state.candidateIds
				: [];
			if (
				candidates.length !== expectedCandidateIds.length ||
				candidates.some((item) => !expectedCandidateIds.includes(item.candidate.candidateId))
			) {
				throw new Error("Checkpointed skill candidate references do not match the job manifest");
			}
			const result = await this.#dependencies.registry.consolidate({
				sourceEvolutionJobId: job.jobId,
				input: inputArtifact,
				candidates,
				idempotencyKey: stableId("skill-candidate-consolidation", {
					sourceEvolutionJobId: job.jobId,
					checkpointIdempotencyKey: skillCheckpoint.idempotencyKey,
				}),
				createdAt: job.terminalAt ?? job.updatedAt,
				signal,
			});
			const processedGroupIds = [
				...new Set([
					...result.changedGroupIds,
					...result.groups.flatMap((group) =>
						group.proposalRevisions.some((revision) => revision.sourceEvolutionJobId === job.jobId)
							? [group.groupId]
							: [],
					),
				]),
			];
			await this.#appendCheckpoint(job, "scoring", attempt, processedGroupIds);
			await this.#appendCheckpoint(job, "completed", attempt, processedGroupIds);
		} catch (error) {
			if (signal?.aborted) throw error;
			await this.#appendFailure(job, attempt, error);
			throw error;
		}
	}
}

export class SkillCandidateBackgroundWorker {
	readonly #dependencies: SkillCandidateBackgroundWorkerDependencies;
	readonly #failureBackoffMs: number;
	#controller: AbortController | null = null;
	#runPromise: Promise<void> | null = null;

	constructor(
		dependencies: SkillCandidateBackgroundWorkerDependencies,
		options: SkillCandidateBackgroundWorkerOptions = {},
	) {
		this.#dependencies = dependencies;
		this.#failureBackoffMs = nonNegativeDuration(
			options.failureBackoffMs,
			DEFAULT_FAILURE_BACKOFF_MS,
			"failureBackoffMs",
		);
	}

	async runOnce(signal: AbortSignal): Promise<"idle" | "ran"> {
		signal.throwIfAborted();
		const jobId = await this.#dependencies.source.nextRunnableJob(this.#dependencies.clock.now(), signal);
		if (jobId === null) return "idle";
		await this.#dependencies.priority.waitUntilBackgroundAllowed(signal);
		signal.throwIfAborted();
		await this.#dependencies.processor.process(jobId, signal);
		return "ran";
	}

	start(): void {
		if (this.#runPromise !== null) return;
		const controller = new AbortController();
		this.#controller = controller;
		this.#runPromise = this.#run(controller.signal).finally(() => {
			if (this.#controller === controller) this.#controller = null;
			this.#runPromise = null;
		});
		void this.#runPromise.catch(() => {});
	}

	async #run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const result = await this.runOnce(signal);
				if (result === "idle") await this.#dependencies.source.waitForWork(signal);
			} catch {
				if (signal.aborted) return;
				await wait(this.#failureBackoffMs, signal);
			}
		}
	}

	async stop(reason: unknown = new Error("Skill candidate background worker stopped")): Promise<void> {
		const runPromise = this.#runPromise;
		if (runPromise === null) return;
		const controller = this.#controller;
		controller?.abort(reason);
		try {
			await runPromise;
		} catch (error) {
			if (!controller?.signal.aborted) throw error;
		}
	}
}
