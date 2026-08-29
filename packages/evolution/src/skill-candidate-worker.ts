import type {
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionLeaseToken,
	EvolutionScope,
	SkillCandidate,
	SkillCandidateRegistryEvent,
	SkillCandidateWorkCheckpointedEvent,
	SkillCandidateWorkFailedEvent,
	SkillCandidateWorkStage,
	SkillDraftValidationReport,
} from "./contracts.ts";
import { SKILL_CANDIDATE_REGISTRY_SCHEMA_VERSION } from "./contracts.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionClock,
	EvolutionJobStore,
	EvolutionLeaseStore,
	EvolutionModelExecutor,
	InteractivePriorityGate,
	SkillCandidateRegistry,
	SkillCandidateRegistryStore,
	SkillDraftValidator,
	SkillEvaluator,
	SkillSynthesizer,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_FAILURE_BACKOFF_MS = 5_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
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
	process(sourceEvolutionJobId: string, signal?: AbortSignal): Promise<"busy" | "processed">;
}

export interface SkillCandidateRegistryWorkerDependencies {
	readonly version: string;
	readonly clock: EvolutionClock;
	readonly jobs: EvolutionJobStore;
	readonly artifacts: EvolutionArtifactStore;
	readonly store: SkillCandidateRegistryStore;
	readonly leases: EvolutionLeaseStore;
	readonly ownerId: string;
	readonly registry: SkillCandidateRegistry;
	readonly synthesizer: SkillSynthesizer;
	readonly validator: SkillDraftValidator;
	readonly evaluator?: SkillEvaluator;
	readonly model: EvolutionModelExecutor;
}

export interface SkillCandidateRegistryWorkerOptions {
	readonly maxAttempts?: number;
	readonly retryBaseDelayMs?: number;
	readonly retryMaxDelayMs?: number;
	readonly leaseTtlMs?: number;
	readonly heartbeatIntervalMs?: number;
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

function combineSignals(signals: readonly (AbortSignal | undefined)[]): {
	readonly signal: AbortSignal;
	readonly dispose: () => void;
} {
	const controller = new AbortController();
	const listeners = new Map<AbortSignal, () => void>();
	for (const signal of signals) {
		if (signal === undefined) continue;
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		const listener = () => controller.abort(signal.reason);
		listeners.set(signal, listener);
		signal.addEventListener("abort", listener, { once: true });
	}
	return {
		signal: controller.signal,
		dispose() {
			for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
		},
	};
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

function isSkillDraft(
	artifact: EvolutionArtifact,
): artifact is Extract<EvolutionArtifact, { artifactKind: "skill-draft" }> {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-draft";
}

function isSkillValidation(artifact: EvolutionArtifact): artifact is SkillDraftValidationReport {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-draft-validation";
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
	readonly #leaseTtlMs: number;
	readonly #heartbeatIntervalMs: number;

	constructor(
		dependencies: SkillCandidateRegistryWorkerDependencies,
		options: SkillCandidateRegistryWorkerOptions = {},
	) {
		this.#dependencies = dependencies;
		if (dependencies.ownerId.trim() === "") throw new Error("ownerId must be non-empty");
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
		this.#leaseTtlMs = positiveInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, "leaseTtlMs");
		this.#heartbeatIntervalMs = positiveInteger(
			options.heartbeatIntervalMs,
			DEFAULT_HEARTBEAT_INTERVAL_MS,
			"heartbeatIntervalMs",
		);
		if (this.#leaseTtlMs < 2_000) throw new Error("leaseTtlMs must be at least 2000");
		if (this.#heartbeatIntervalMs >= this.#leaseTtlMs) {
			throw new Error("heartbeatIntervalMs must be less than leaseTtlMs");
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
		lease: EvolutionLeaseToken,
	): Promise<void> {
		const idempotencyKey = stableId("skill-candidate-work-stage", { sourceEvolutionJobId: job.jobId, stage });
		await this.#appendEvent(job.metadata.scope, lease, (registrySequence, existing) => {
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

	async #appendFailure(job: EvolutionJob, attempt: number, error: unknown, lease: EvolutionLeaseToken): Promise<void> {
		const idempotencyKey = stableId("skill-candidate-work-failure", {
			sourceEvolutionJobId: job.jobId,
			attempt,
		});
		await this.#appendEvent(job.metadata.scope, lease, (registrySequence, existing) => {
			if (
				existing.some(
					(event) =>
						(event.type === "skill-candidate-work-checkpointed" &&
							event.sourceEvolutionJobId === job.jobId &&
							event.stage === "completed") ||
						(event.type === "skill-candidate-work-failed" &&
							event.sourceEvolutionJobId === job.jobId &&
							event.attempt === attempt),
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
		lease: EvolutionLeaseToken,
		build: (
			registrySequence: number,
			existing: readonly SkillCandidateRegistryEvent[],
		) => SkillCandidateRegistryEvent | null,
	): Promise<void> {
		for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
			const snapshot = await this.#dependencies.store.loadSkillCandidateRegistry(scope);
			const event = build(snapshot.revision + 1, snapshot.events);
			if (event === null) return;
			const result = await this.#dependencies.store.appendSkillCandidateRegistryEvents(
				scope,
				snapshot.revision,
				[event],
				lease,
			);
			if (result === "committed") return;
		}
		throw new Error("Skill candidate work history changed too often to append an event");
	}

	async process(sourceEvolutionJobId: string, signal?: AbortSignal): Promise<"busy" | "processed"> {
		signal?.throwIfAborted();
		const workId = stableId("skill-candidate-work", { sourceEvolutionJobId });
		const initialLease = await this.#dependencies.leases.acquire(
			"candidate-work",
			workId,
			this.#dependencies.ownerId,
			this.#dependencies.clock.now(),
			this.#leaseTtlMs,
		);
		if (initialLease === null) {
			signal?.throwIfAborted();
			return "busy";
		}
		let currentLease = initialLease;
		const heartbeatController = new AbortController();
		const compromisedController = new AbortController();
		const combined = combineSignals([signal, compromisedController.signal]);
		const heartbeat = (async () => {
			try {
				while (!heartbeatController.signal.aborted) {
					await wait(this.#heartbeatIntervalMs, heartbeatController.signal);
					const renewed = await this.#dependencies.leases.renew(
						currentLease,
						this.#dependencies.clock.now(),
						this.#leaseTtlMs,
					);
					if (renewed === null) {
						compromisedController.abort(new Error(`Skill candidate work lease "${workId}" was lost`));
						return;
					}
					currentLease = renewed;
				}
			} catch (error) {
				if (!heartbeatController.signal.aborted) compromisedController.abort(error);
			}
		})();
		try {
			await this.#processClaimed(sourceEvolutionJobId, () => currentLease, combined.signal);
			return "processed";
		} finally {
			heartbeatController.abort();
			combined.dispose();
			await heartbeat.catch(() => {});
			await this.#dependencies.leases.release(currentLease);
		}
	}

	async #processClaimed(
		sourceEvolutionJobId: string,
		claim: () => EvolutionLeaseToken,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
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
			await this.#appendCheckpoint(job, "consolidating", attempt, [], claim());
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
				lease: claim(),
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
			await this.#appendCheckpoint(job, "scoring", attempt, processedGroupIds, claim());
			const synthesisTargets = result.groups.filter((group) => group.state === "evidence-qualified");
			await this.#appendCheckpoint(
				job,
				"synthesizing",
				attempt,
				synthesisTargets.map((group) => group.groupId),
				claim(),
			);
			const draftedGroups = result.groups.filter((group) => group.state === "drafted");
			for (const group of synthesisTargets) {
				signal.throwIfAborted();
				let draftReference = group.draft;
				if (draftReference === null) {
					const draft = await this.#dependencies.synthesizer.synthesize({
						group,
						model: this.#dependencies.model,
						idempotencyKey: group.synthesisIdempotencyKey,
						createdAt: this.#dependencies.clock.now(),
						signal,
					});
					draftReference = await this.#dependencies.artifacts.put(draft);
				}
				draftedGroups.push(
					await this.#dependencies.registry.recordDraft({
						scope: job.metadata.scope,
						lease: claim(),
						groupId: group.groupId,
						draft: draftReference,
						proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
						idempotencyKey: group.synthesisIdempotencyKey,
						createdAt: this.#dependencies.clock.now(),
					}),
				);
			}
			await this.#appendCheckpoint(
				job,
				"validating",
				attempt,
				draftedGroups.map((group) => group.groupId),
				claim(),
			);
			const evaluationGroups = new Map(
				result.groups
					.filter((group) => group.state === "structurally-valid" || group.state === "evaluation-pending")
					.map((group) => [group.groupId, group]),
			);
			for (const group of draftedGroups) {
				signal.throwIfAborted();
				if (group.draft === null) throw new Error(`Drafted candidate group "${group.groupId}" has no draft`);
				const artifact = await this.#dependencies.artifacts.get(group.draft);
				if (!isSkillDraft(artifact)) throw new Error(`Candidate group "${group.groupId}" draft is invalid`);
				let validationReference = group.validation;
				if (validationReference === null) {
					const validation = await this.#dependencies.validator.validate({
						group,
						draft: artifact,
						idempotencyKey: group.validationIdempotencyKey,
						createdAt: this.#dependencies.clock.now(),
						signal,
					});
					validationReference = await this.#dependencies.artifacts.put(validation);
				}
				const validated = await this.#dependencies.registry.recordValidation({
					scope: job.metadata.scope,
					lease: claim(),
					groupId: group.groupId,
					draft: group.draft,
					validation: validationReference,
					proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
					idempotencyKey: group.validationIdempotencyKey,
					createdAt: this.#dependencies.clock.now(),
				});
				if (validated.state === "structurally-valid") evaluationGroups.set(validated.groupId, validated);
			}
			await this.#appendCheckpoint(job, "evaluating", attempt, [...evaluationGroups.keys()], claim());
			const evaluatedGroupIds: string[] = [];
			if (this.#dependencies.evaluator !== undefined) {
				for (const evaluationGroup of evaluationGroups.values()) {
					signal.throwIfAborted();
					if (evaluationGroup.draft === null || evaluationGroup.validation === null) {
						throw new Error(`Candidate group "${evaluationGroup.groupId}" lacks evaluation prerequisites`);
					}
					const draftArtifact = await this.#dependencies.artifacts.get(evaluationGroup.draft);
					const validationArtifact = await this.#dependencies.artifacts.get(evaluationGroup.validation);
					if (!isSkillDraft(draftArtifact) || !isSkillValidation(validationArtifact)) {
						throw new Error(`Candidate group "${evaluationGroup.groupId}" evaluation prerequisites are invalid`);
					}
					const pending = await this.#dependencies.registry.startEvaluation({
						scope: job.metadata.scope,
						lease: claim(),
						groupId: evaluationGroup.groupId,
						draft: evaluationGroup.draft,
						validation: evaluationGroup.validation,
						proposalRevisionIds: evaluationGroup.proposalRevisions.map((revision) => revision.revisionId),
						idempotencyKey: evaluationGroup.evaluationIdempotencyKey,
						createdAt: this.#dependencies.clock.now(),
					});
					let evaluationReference = pending.evaluation;
					if (evaluationReference === null) {
						const evaluation = await this.#dependencies.evaluator.evaluate({
							group: pending,
							draft: draftArtifact,
							validation: validationArtifact,
							idempotencyKey: pending.evaluationIdempotencyKey,
							createdAt: this.#dependencies.clock.now(),
							signal,
						});
						evaluationReference = await this.#dependencies.artifacts.put(evaluation);
					}
					await this.#dependencies.registry.recordEvaluation({
						scope: job.metadata.scope,
						lease: claim(),
						groupId: pending.groupId,
						draft: evaluationGroup.draft,
						validation: evaluationGroup.validation,
						evaluation: evaluationReference,
						proposalRevisionIds: pending.proposalRevisions.map((revision) => revision.revisionId),
						idempotencyKey: pending.evaluationIdempotencyKey,
						createdAt: this.#dependencies.clock.now(),
					});
					evaluatedGroupIds.push(pending.groupId);
				}
			}
			await this.#appendCheckpoint(
				job,
				"completed",
				attempt,
				[...new Set([...processedGroupIds, ...evaluationGroups.keys(), ...evaluatedGroupIds])],
				claim(),
			);
		} catch (error) {
			if (signal.aborted) throw error;
			await this.#appendFailure(job, attempt, error, claim());
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
		const result = await this.#dependencies.processor.process(jobId, signal);
		return result === "busy" ? "idle" : "ran";
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
