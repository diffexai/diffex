import type {
	ActiveEvolutionStage,
	CheckpointSavedLedgerEvent,
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionFailureReasonCode,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionJobCompletion,
	EvolutionJobOutcome,
	EvolutionJobResolution,
	EvolutionJobStage,
	EvolutionLeaseToken,
	EvolutionScope,
	EvolutionSkillCatalogEntry,
	EvolutionSkillContentArtifact,
	EvolutionSkillContentSnapshot,
	EvolutionStageCheckpoint,
	JobCompletedLedgerEvent,
	JobCreatedLedgerEvent,
	JobFailedLedgerEvent,
	JsonObject,
} from "./contracts.ts";
import { EVOLUTION_SCHEMA_VERSION } from "./contracts.ts";
import { EvolutionExecutionError } from "./errors.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionCancellationStore,
	EvolutionClock,
	EvolutionCursorStore,
	EvolutionEventSink,
	EvolutionEvidenceCatalog,
	EvolutionFailureReporter,
	EvolutionIdGenerator,
	EvolutionJobCreationRequest,
	EvolutionJobRunner,
	EvolutionJobStore,
	EvolutionLeaseStore,
	EvolutionLedger,
	EvolutionSnapshotSource,
	EvolutionStageDirective,
	EvolutionStageExecutor,
} from "./ports.ts";
import {
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	createEvolutionArtifactMetadata,
} from "./provenance.ts";
import {
	type AutomaticEvolutionEligibilityReason,
	EVOLUTION_TOKEN_ESTIMATOR_VERSION,
	estimateEvolutionTokens,
	evaluateAutomaticEvolutionEligibility,
} from "./token-estimator.ts";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 100;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 5 * 60_000;

const NEXT_STAGE: Readonly<Record<ActiveEvolutionStage, EvolutionJobStage>> = {
	queued: "snapshotting",
	snapshotting: "counter-slot",
	"counter-slot": "reflecting",
	reflecting: "curating",
	curating: "validating",
	validating: "skill-curating",
	"skill-curating": "writing",
	writing: "activating",
	activating: "completed",
};

export type EvolutionJobCreationBlockReason =
	| AutomaticEvolutionEligibilityReason
	| "blocking-job"
	| "no-new-evidence"
	| "scope-busy";

export type EvolutionJobCreationResult =
	| { readonly status: "created"; readonly job: EvolutionJob }
	| {
			readonly status: "not-created";
			readonly reason: EvolutionJobCreationBlockReason;
			readonly blockingJobId?: string;
	  };

export interface EvolutionControlPlaneDependencies {
	readonly version: string;
	readonly clock: EvolutionClock;
	readonly ids: EvolutionIdGenerator;
	readonly artifacts: EvolutionArtifactStore;
	readonly jobs: EvolutionJobStore;
	readonly cancellations: EvolutionCancellationStore;
	readonly cursors: EvolutionCursorStore;
	readonly leases: EvolutionLeaseStore;
	readonly ledger: EvolutionLedger;
	readonly events: EvolutionEventSink;
	readonly evidence: EvolutionEvidenceCatalog;
	readonly failures?: EvolutionFailureReporter;
	readonly snapshots: EvolutionSnapshotSource;
	readonly executor: EvolutionStageExecutor;
}

export interface EvolutionControlPlaneOptions {
	readonly leaseTtlMs?: number;
	readonly heartbeatIntervalMs?: number;
	readonly cancellationPollIntervalMs?: number;
	readonly retryBaseDelayMs?: number;
	readonly retryMaxDelayMs?: number;
}

interface StageCompletionState extends JsonObject {
	readonly controlDirective: EvolutionStageDirective;
	readonly resultingHarnessVersion: string | null;
}

class EvolutionCompletionPendingError extends Error {
	constructor(jobId: string, options: ErrorOptions) {
		super(
			`Evolution job "${jobId}" reached a durable completion condition but its manifest is not finalized`,
			options,
		);
		this.name = "EvolutionCompletionPendingError";
	}
}

class EvolutionOperatorCancellationError extends Error {
	constructor(jobId: string) {
		super(`Evolution job "${jobId}" was cancelled by the operator`);
		this.name = "EvolutionOperatorCancellationError";
	}
}

function isInputSnapshot(artifact: EvolutionArtifact): artifact is EvolutionInputSnapshot {
	return "ingestionHighWaterCursor" in artifact && "evidenceSources" in artifact && "harness" in artifact;
}

function isCancelledJob(job: EvolutionJob): boolean {
	return job.resolution?.reasonCode === "cancelled-by-operator";
}

function isOpenBlockingJob(job: EvolutionJob): boolean {
	return (
		job.resolution === null &&
		(job.outcome === "active" || job.outcome === "interrupted" || job.outcome === "retryable-failed")
	);
}

function rangesOverlap(left: EvolutionJob["evidenceRange"], right: EvolutionJob["evidenceRange"]): boolean {
	return left.afterCursor < right.throughCursor && right.afterCursor < left.throughCursor;
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function abortError(signal: AbortSignal | undefined): unknown {
	return signal?.reason ?? new Error("Evolution operation was interrupted");
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): {
	readonly signal: AbortSignal;
	readonly dispose: () => void;
} {
	const controller = new AbortController();
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	const listeners = new Map<AbortSignal, () => void>();
	for (const signal of active) {
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

export class EvolutionControlPlane implements EvolutionJobRunner {
	readonly #dependencies: EvolutionControlPlaneDependencies;
	readonly #producer: EvolutionArtifactProducer;
	readonly #leaseTtlMs: number;
	readonly #heartbeatIntervalMs: number;
	readonly #cancellationPollIntervalMs: number;
	readonly #retryBaseDelayMs: number;
	readonly #retryMaxDelayMs: number;

	constructor(dependencies: EvolutionControlPlaneDependencies, options: EvolutionControlPlaneOptions = {}) {
		this.#dependencies = dependencies;
		this.#producer = {
			name: "diffex-evolution-control-plane",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
		this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
		this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.#cancellationPollIntervalMs = options.cancellationPollIntervalMs ?? DEFAULT_CANCELLATION_POLL_INTERVAL_MS;
		this.#retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
		this.#retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
		if (this.#leaseTtlMs < 2_000) throw new Error("leaseTtlMs must be at least 2000");
		if (this.#heartbeatIntervalMs < 1 || this.#heartbeatIntervalMs >= this.#leaseTtlMs) {
			throw new Error("heartbeatIntervalMs must be positive and less than leaseTtlMs");
		}
		if (!Number.isFinite(this.#cancellationPollIntervalMs) || this.#cancellationPollIntervalMs < 1) {
			throw new Error("cancellationPollIntervalMs must be positive");
		}
		if (this.#retryBaseDelayMs < 0 || this.#retryMaxDelayMs < this.#retryBaseDelayMs) {
			throw new Error("Evolution retry delays are invalid");
		}
	}

	#metadata(
		artifactId: string,
		sourceIds: readonly string[],
		scope: EvolutionScope,
		createdAt: string,
		content: unknown,
	): EvolutionArtifactMetadata {
		return createEvolutionArtifactMetadata({
			artifactId,
			producer: this.#producer,
			sourceIds,
			scope,
			createdAt,
			content,
		});
	}

	#scopeKey(scope: EvolutionScope): string {
		return computeEvolutionContentDigest(scope);
	}

	async #withHeartbeat<T>(
		initialLease: EvolutionLeaseToken,
		signal: AbortSignal | undefined,
		operation: (lease: () => EvolutionLeaseToken, signal: AbortSignal) => Promise<T>,
		cancellationJobId?: string,
	): Promise<T> {
		let currentLease = initialLease;
		const monitorController = new AbortController();
		const compromisedController = new AbortController();
		const combined = combineSignals([signal, compromisedController.signal]);
		const heartbeat = (async () => {
			try {
				while (!monitorController.signal.aborted) {
					await abortableDelay(this.#heartbeatIntervalMs, monitorController.signal);
					const renewed = await this.#dependencies.leases.renew(
						currentLease,
						this.#dependencies.clock.now(),
						this.#leaseTtlMs,
					);
					if (renewed === null) {
						compromisedController.abort(
							new EvolutionExecutionError(`Evolution ${currentLease.kind} lease was lost`, {
								reasonCode: "lease-lost",
								retryable: true,
							}),
						);
						return;
					}
					currentLease = renewed;
				}
			} catch (error) {
				if (!monitorController.signal.aborted) compromisedController.abort(error);
			}
		})();
		const cancellationMonitor = (async () => {
			if (cancellationJobId === undefined) return;
			try {
				while (!monitorController.signal.aborted) {
					if ((await this.#dependencies.cancellations.loadCancellation(cancellationJobId)) !== null) {
						compromisedController.abort(new EvolutionOperatorCancellationError(cancellationJobId));
						return;
					}
					await abortableDelay(this.#cancellationPollIntervalMs, monitorController.signal);
				}
			} catch (error) {
				if (!monitorController.signal.aborted) compromisedController.abort(error);
			}
		})();
		try {
			return await operation(() => currentLease, combined.signal);
		} finally {
			monitorController.abort();
			combined.dispose();
			await Promise.all([heartbeat.catch(() => {}), cancellationMonitor.catch(() => {})]);
			await this.#dependencies.leases.release(currentLease);
		}
	}

	async #acquireScopeLease(scope: EvolutionScope, ownerId: string): Promise<EvolutionLeaseToken | null> {
		return this.#dependencies.leases.acquire(
			"scope",
			this.#scopeKey(scope),
			ownerId,
			this.#dependencies.clock.now(),
			this.#leaseTtlMs,
		);
	}

	#jobContent(job: Omit<EvolutionJob, "metadata">): Omit<EvolutionJob, "metadata"> {
		return job;
	}

	#withJobRevision(
		job: EvolutionJob,
		changes: Partial<Omit<EvolutionJob, "metadata" | "jobId" | "createdAt">>,
	): EvolutionJob {
		const updatedAt = this.#dependencies.clock.now();
		const { metadata: _metadata, ...current } = job;
		const nextWithoutMetadata: Omit<EvolutionJob, "metadata"> = {
			...current,
			...changes,
			jobId: job.jobId,
			createdAt: job.createdAt,
			updatedAt,
			revision: job.revision + 1,
		};
		return {
			...nextWithoutMetadata,
			metadata: this.#metadata(
				job.jobId,
				[job.inputSnapshot.artifactId],
				job.metadata.scope,
				job.createdAt,
				this.#jobContent(nextWithoutMetadata),
			),
		};
	}

	#ledgerMetadata(job: EvolutionJob, eventId: string, content: unknown): EvolutionArtifactMetadata {
		return this.#metadata(eventId, [job.jobId], job.metadata.scope, job.createdAt, content);
	}

	#jobCreatedEvent(job: EvolutionJob): JobCreatedLedgerEvent {
		const eventId = stableId("ledger-event", { jobId: job.jobId, type: "job-created" });
		const content = { inputSnapshotId: job.inputSnapshot.artifactId };
		return {
			metadata: this.#ledgerMetadata(job, eventId, content),
			eventId,
			jobId: job.jobId,
			type: "job-created",
			inputSnapshotId: job.inputSnapshot.artifactId,
		};
	}

	#checkpointEvent(job: EvolutionJob, checkpoint: EvolutionStageCheckpoint): CheckpointSavedLedgerEvent {
		const eventId = stableId("ledger-event", {
			jobId: job.jobId,
			type: "checkpoint-saved",
			stage: checkpoint.stage,
			idempotencyKey: checkpoint.idempotencyKey,
		});
		return {
			metadata: this.#ledgerMetadata(job, eventId, checkpoint),
			eventId,
			jobId: job.jobId,
			type: "checkpoint-saved",
			checkpoint,
		};
	}

	#completedEvent(job: EvolutionJob): JobCompletedLedgerEvent {
		if (job.completion === null) throw new Error(`Completed evolution job "${job.jobId}" has no completion`);
		const content = job.completion;
		const eventId = stableId("ledger-event", { jobId: job.jobId, type: "job-completed", content });
		return {
			metadata: this.#ledgerMetadata(job, eventId, content),
			eventId,
			jobId: job.jobId,
			type: "job-completed",
			completionKind: job.completion.kind,
			resultingHarnessVersion: job.completion.resultingHarnessVersion,
			processedEvidenceCursor: job.completion.processedEvidenceCursor,
		};
	}

	#failedEvent(job: EvolutionJob): JobFailedLedgerEvent {
		if (
			job.stage === "completed" ||
			job.reasonCode === null ||
			job.failureMessage === null ||
			(job.outcome !== "interrupted" && job.outcome !== "retryable-failed" && job.outcome !== "terminal-failed")
		) {
			throw new Error(`Evolution job "${job.jobId}" is not failed`);
		}
		const content = {
			failedStage: job.stage,
			outcome: job.outcome,
			reasonCode: job.reasonCode,
			message: job.failureMessage,
			revision: job.revision,
		};
		const eventId = stableId("ledger-event", { jobId: job.jobId, type: "job-failed", content });
		return {
			metadata: this.#ledgerMetadata(job, eventId, content),
			eventId,
			jobId: job.jobId,
			type: "job-failed",
			failedStage: job.stage,
			outcome: job.outcome,
			reasonCode: job.reasonCode,
			message: job.failureMessage,
		};
	}

	async #syncLedger(job: EvolutionJob): Promise<void> {
		await this.#dependencies.ledger.append(this.#jobCreatedEvent(job));
		for (const checkpoint of job.checkpoints) {
			await this.#dependencies.ledger.append(this.#checkpointEvent(job, checkpoint));
		}
		if (job.outcome === "completed") await this.#dependencies.ledger.append(this.#completedEvent(job));
		if (job.outcome === "interrupted" || job.outcome === "retryable-failed" || job.outcome === "terminal-failed") {
			await this.#dependencies.ledger.append(this.#failedEvent(job));
		}
	}

	async createJob(request: EvolutionJobCreationRequest): Promise<EvolutionJobCreationResult> {
		request.signal?.throwIfAborted();
		const ownerId = this.#dependencies.ids.nextId("lease-owner");
		const initialLease = await this.#acquireScopeLease(request.scope, ownerId);
		if (initialLease === null) return { status: "not-created", reason: "scope-busy" };
		return this.#withHeartbeat(initialLease, request.signal, async (lease, signal) => {
			const processedCursor = await this.#dependencies.cursors.load(request.scope);
			const ingestionHighWaterCursor = await this.#dependencies.evidence.highWaterCursor(request.scope);
			if (!Number.isSafeInteger(ingestionHighWaterCursor) || ingestionHighWaterCursor < processedCursor.sequence) {
				throw new EvolutionExecutionError("Materialization high-water cursor is invalid", {
					reasonCode: "snapshot-invalid",
					retryable: false,
				});
			}
			const materializations = await this.#dependencies.evidence.listSuccessful(
				request.scope,
				processedCursor.sequence,
				ingestionHighWaterCursor,
			);
			const seenMaterializations = new Set<string>();
			let previousCursor = processedCursor.sequence;
			for (const materialization of materializations) {
				if (
					seenMaterializations.has(materialization.materializationId) ||
					materialization.ingestionCursor <= previousCursor ||
					materialization.ingestionCursor > ingestionHighWaterCursor ||
					computeEvolutionContentDigest(materialization.invocation) !== materialization.contentDigest
				) {
					throw new EvolutionExecutionError("Materialization catalog returned an invalid frozen range", {
						reasonCode: "snapshot-invalid",
						retryable: false,
					});
				}
				seenMaterializations.add(materialization.materializationId);
				previousCursor = materialization.ingestionCursor;
			}

			if (materializations.length === 0) {
				const excludedThroughCursor =
					(await this.#dependencies.evidence.excludedThroughCursor?.(
						request.scope,
						processedCursor.sequence,
						ingestionHighWaterCursor,
					)) ?? processedCursor.sequence;
				if (excludedThroughCursor > processedCursor.sequence) {
					const commitId = `excluded-${computeEvolutionContentDigest({
						scope: request.scope,
						afterCursor: processedCursor.sequence,
						throughCursor: excludedThroughCursor,
					}).slice("sha256:".length, "sha256:".length + 32)}`;
					const committed = await this.#dependencies.cursors.commit(
						request.scope,
						processedCursor.sequence,
						excludedThroughCursor,
						commitId,
						this.#dependencies.clock.now(),
						lease(),
					);
					if (committed === "conflict") {
						throw new EvolutionExecutionError("Excluded evidence cursor conflicted", {
							reasonCode: "snapshot-invalid",
							retryable: false,
						});
					}
				}
				return { status: "not-created", reason: "no-new-evidence" };
			}
			const evidenceRange = {
				afterCursor: processedCursor.sequence,
				throughCursor: ingestionHighWaterCursor,
			};
			const scopeJobs = await this.#dependencies.jobs.list(request.scope);
			const blocking = scopeJobs.find(
				(job) =>
					isOpenBlockingJob(job) &&
					(rangesOverlap(job.evidenceRange, evidenceRange) ||
						(request.trigger === "automatic" && job.trigger === "automatic")),
			);
			if (blocking !== undefined) {
				return { status: "not-created", reason: "blocking-job", blockingJobId: blocking.jobId };
			}

			const estimatedTokens = estimateEvolutionTokens(materializations.map((item) => item.invocation));
			if (request.trigger === "automatic") {
				const previousTerminalAt =
					scopeJobs
						.filter((job) => !isCancelledJob(job) && job.trigger === "automatic" && job.terminalAt !== null)
						.map((job) => job.terminalAt as string)
						.sort()
						.at(-1) ?? null;
				const eligibility = evaluateAutomaticEvolutionEligibility({
					invocationCount: materializations.length,
					estimatedTokens,
					now: this.#dependencies.clock.now(),
					previousAutomaticTerminalAt: previousTerminalAt,
				});
				if (!eligibility.eligible) return { status: "not-created", reason: eligibility.reason };
			}

			signal.throwIfAborted();
			const frozen = await this.#dependencies.snapshots.capture(request.scope, signal);
			if (frozen.repository.repositoryId !== request.scope.repositoryId) {
				throw new EvolutionExecutionError("Snapshot repository identity does not match the evolution scope", {
					reasonCode: "snapshot-invalid",
					retryable: false,
				});
			}
			if (computeEvolutionContentDigest(frozen.harness.memory) !== frozen.harness.memoryContentDigest) {
				throw new EvolutionExecutionError("Frozen evolution memory digest is invalid", {
					reasonCode: "snapshot-invalid",
					retryable: false,
				});
			}
			for (const document of frozen.instructions) {
				if (computeEvolutionContentDigest(document.content) !== document.contentDigest) {
					throw new EvolutionExecutionError(`Frozen instruction digest is invalid for "${document.path}"`, {
						reasonCode: "snapshot-invalid",
						retryable: false,
					});
				}
			}

			const createdAt = this.#dependencies.clock.now();
			const skillCatalog: EvolutionSkillCatalogEntry[] = [];
			const skillArtifactIds: string[] = [];
			const seenSkillVersions = new Set<string>();
			for (const source of frozen.skills) {
				const identityKey = `${source.skillId}\0${source.version}`;
				if (
					source.skillId.length === 0 ||
					source.name.length === 0 ||
					source.description.length === 0 ||
					source.source.length === 0 ||
					source.version.length === 0 ||
					source.location.length === 0 ||
					source.baseDir.length === 0 ||
					(source.sourceKind !== "evolved" && source.sourceKind !== "installed") ||
					(source.scope !== "global" && source.scope !== "workspace") ||
					(source.sourceKind === "evolved" && source.scope !== "workspace") ||
					seenSkillVersions.has(identityKey) ||
					computeEvolutionTextDigest(source.content) !== source.contentDigest
				) {
					throw new EvolutionExecutionError(`Frozen skill catalog entry is invalid for "${source.name}"`, {
						reasonCode: "snapshot-invalid",
						retryable: false,
					});
				}
				seenSkillVersions.add(identityKey);
				const workspace =
					source.scope === "workspace"
						? {
								repositoryId: frozen.repository.repositoryId,
								...(frozen.repository.directoryId === undefined
									? {}
									: { directoryId: frozen.repository.directoryId }),
							}
						: null;
				const skill: EvolutionSkillContentSnapshot = {
					skillId: source.skillId,
					name: source.name,
					description: source.description,
					sourceKind: source.sourceKind,
					scope: source.scope,
					source: source.source,
					version: source.version,
					contentDigest: source.contentDigest,
					...(source.harnessRevision === undefined ? {} : { harnessRevision: source.harnessRevision }),
					workspace,
					location: source.location,
					baseDir: source.baseDir,
					disableModelInvocation: source.disableModelInvocation,
					content: source.content,
				};
				const artifactId = stableId("skill-content", {
					skillId: source.skillId,
					version: source.version,
					contentDigest: source.contentDigest,
					createdAt,
				});
				const artifactContent = { artifactKind: "skill-content" as const, skill };
				const artifact: EvolutionSkillContentArtifact = {
					metadata: this.#metadata(artifactId, [], request.scope, createdAt, artifactContent),
					...artifactContent,
				};
				const contentArtifact = await this.#dependencies.artifacts.put(artifact);
				skillArtifactIds.push(artifactId);
				skillCatalog.push({
					skillId: skill.skillId,
					name: skill.name,
					description: skill.description,
					sourceKind: skill.sourceKind,
					scope: skill.scope,
					source: skill.source,
					version: skill.version,
					contentDigest: skill.contentDigest,
					...(skill.harnessRevision === undefined ? {} : { harnessRevision: skill.harnessRevision }),
					workspace,
					disableModelInvocation: skill.disableModelInvocation,
					contentArtifact,
				});
			}

			const snapshotId = this.#dependencies.ids.nextId("input-snapshot");
			const snapshotContent = {
				trigger: request.trigger,
				repository: frozen.repository,
				harness: frozen.harness,
				expectedHarnessBaseVersion: frozen.harness.harnessVersion,
				ingestionHighWaterCursor,
				instructions: frozen.instructions,
				skillCatalog,
				modelConfiguration: frozen.modelConfiguration,
				pipelineVersion: frozen.pipelineVersion,
				promptVersions: frozen.promptVersions,
				tokenMeasurement: {
					estimatorVersion: EVOLUTION_TOKEN_ESTIMATOR_VERSION,
					estimatedTokens,
				},
				evidenceSources: materializations.map((materialization) => ({
					sourceId: materialization.materializationId,
					materializationId: materialization.materializationId,
					ingestionCursor: materialization.ingestionCursor,
					origin: materialization.origin,
					contentDigest: materialization.contentDigest,
					invocation: materialization.invocation,
				})),
			};
			const snapshot: EvolutionInputSnapshot = {
				metadata: this.#metadata(
					snapshotId,
					[...materializations.map((item) => item.materializationId), ...skillArtifactIds],
					request.scope,
					createdAt,
					snapshotContent,
				),
				...snapshotContent,
			};
			const snapshotReference = await this.#dependencies.artifacts.put(snapshot);
			const jobId = this.#dependencies.ids.nextId("job");
			const jobWithoutMetadata: Omit<EvolutionJob, "metadata"> = {
				jobId,
				inputSnapshot: snapshotReference,
				trigger: request.trigger,
				evidenceRange,
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
			const job: EvolutionJob = {
				...jobWithoutMetadata,
				metadata: this.#metadata(jobId, [snapshotId], request.scope, createdAt, jobWithoutMetadata),
			};
			await this.#dependencies.jobs.create(job, lease());
			await this.#syncLedger(job);
			await this.#dependencies.events.emit({ jobId, emittedAt: createdAt, type: "started", stage: "queued" });
			return { status: "created", job };
		});
	}

	async #loadPriorArtifacts(job: EvolutionJob): Promise<readonly EvolutionArtifact[]> {
		const artifacts: EvolutionArtifact[] = [];
		for (const checkpoint of job.checkpoints) {
			for (const reference of checkpoint.outputArtifacts) {
				artifacts.push(await this.#dependencies.artifacts.get(reference));
			}
		}
		return artifacts;
	}

	#checkpointDirective(checkpoint: EvolutionStageCheckpoint): {
		readonly directive: EvolutionStageDirective;
		readonly resultingHarnessVersion: string | null;
	} {
		const directive = checkpoint.state.controlDirective;
		const resultingHarnessVersion = checkpoint.state.resultingHarnessVersion;
		if (
			(directive !== "continue" && directive !== "complete-no-op" && directive !== "complete-activated") ||
			(typeof resultingHarnessVersion !== "string" && resultingHarnessVersion !== null)
		) {
			throw new EvolutionExecutionError("Stage checkpoint completion state is corrupt", {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		return { directive, resultingHarnessVersion };
	}

	async #completeJob(
		job: EvolutionJob,
		checkpoint: EvolutionStageCheckpoint,
		lease: EvolutionLeaseToken,
	): Promise<EvolutionJob> {
		const { directive, resultingHarnessVersion } = this.#checkpointDirective(checkpoint);
		if (directive === "continue") throw new Error("Cannot complete a continuing evolution stage");
		const cursorResult = await this.#dependencies.cursors.commit(
			job.metadata.scope,
			job.evidenceRange.afterCursor,
			job.evidenceRange.throughCursor,
			job.jobId,
			this.#dependencies.clock.now(),
			lease,
		);
		if (cursorResult === "conflict") {
			throw new EvolutionExecutionError("Processed-evidence cursor changed before job completion", {
				reasonCode: "pipeline-invariant",
				retryable: false,
			});
		}
		const completion: EvolutionJobCompletion = {
			kind: directive === "complete-no-op" ? "no-op" : "activated",
			resultingHarnessVersion: directive === "complete-no-op" ? null : resultingHarnessVersion,
			processedEvidenceCursor: job.evidenceRange.throughCursor,
		};
		const completed = this.#withJobRevision(job, {
			stage: "completed",
			outcome: "completed",
			completion,
			reasonCode: null,
			failureMessage: null,
			terminalAt: this.#dependencies.clock.now(),
			retryNotBefore: null,
		});
		try {
			await this.#dependencies.jobs.save(completed, job.revision, lease);
		} catch (cause) {
			throw new EvolutionCompletionPendingError(job.jobId, { cause });
		}
		await this.#syncLedger(completed);
		await this.#dependencies.events.emit({
			jobId: completed.jobId,
			emittedAt: completed.updatedAt,
			type: "completed",
			stage: "completed",
		});
		return completed;
	}

	async #executeStage(
		job: EvolutionJob,
		input: EvolutionInputSnapshot,
		scopeLease: EvolutionLeaseToken,
		writerLease: EvolutionLeaseToken | null,
		signal: AbortSignal,
	): Promise<EvolutionJob> {
		if (job.stage === "completed") return job;
		const idempotencyKey = stableId("stage", { jobId: job.jobId, stage: job.stage });
		const startedAt = this.#dependencies.clock.now();
		const result = await this.#dependencies.executor.execute({
			job,
			input,
			priorArtifacts: await this.#loadPriorArtifacts(job),
			idempotencyKey,
			scopeLease,
			writerLease,
			signal,
		});
		signal.throwIfAborted();
		const outputArtifacts = [];
		for (const artifact of result.artifacts) outputArtifacts.push(await this.#dependencies.artifacts.put(artifact));
		for (const event of result.ledgerEvents ?? []) await this.#dependencies.ledger.append(event);
		const checkpoint: EvolutionStageCheckpoint = {
			schemaVersion: EVOLUTION_SCHEMA_VERSION,
			stage: job.stage,
			idempotencyKey,
			outputArtifacts,
			state: {
				...result.state,
				controlDirective: result.directive,
				resultingHarnessVersion: result.resultingHarnessVersion ?? null,
			} satisfies StageCompletionState,
			startedAt,
			completedAt: this.#dependencies.clock.now(),
		};
		const checkpointed = this.#withJobRevision(job, {
			stage: result.directive === "continue" ? NEXT_STAGE[job.stage] : job.stage,
			checkpoints: [...job.checkpoints, checkpoint],
		});
		await this.#dependencies.jobs.save(checkpointed, job.revision, scopeLease);
		await this.#dependencies.ledger.append(this.#checkpointEvent(checkpointed, checkpoint));
		await this.#dependencies.events.emit({
			jobId: checkpointed.jobId,
			emittedAt: checkpoint.completedAt,
			type: "checkpoint",
			stage: checkpoint.stage,
			checkpoint,
		});
		if (result.directive !== "continue") return this.#completeJob(checkpointed, checkpoint, scopeLease);
		return checkpointed;
	}

	async #markFailure(
		job: EvolutionJob,
		error: unknown,
		lease: EvolutionLeaseToken,
		interrupted: boolean,
	): Promise<EvolutionJob> {
		const executionError = error instanceof EvolutionExecutionError ? error : null;
		const outcome: Extract<EvolutionJobOutcome, "interrupted" | "retryable-failed" | "terminal-failed"> = interrupted
			? "interrupted"
			: executionError?.retryable === false
				? "terminal-failed"
				: "retryable-failed";
		const reasonCode: EvolutionFailureReasonCode = interrupted
			? "shutdown"
			: (executionError?.reasonCode ?? "stage-failed");
		const now = this.#dependencies.clock.now();
		const retryDelay = Math.min(this.#retryBaseDelayMs * 2 ** Math.max(job.attempt, 0), this.#retryMaxDelayMs);
		const failed = this.#withJobRevision(job, {
			outcome,
			reasonCode,
			failureMessage: error instanceof Error ? error.message : String(error),
			terminalAt: now,
			retryNotBefore: outcome === "retryable-failed" ? new Date(Date.parse(now) + retryDelay).toISOString() : null,
		});
		await this.#dependencies.jobs.save(failed, job.revision, lease);
		await this.#syncLedger(failed);
		await this.#dependencies.events.emit({
			jobId: failed.jobId,
			emittedAt: failed.updatedAt,
			type: "failed",
			stage: failed.stage,
		});
		if (outcome !== "interrupted") {
			const cause = error instanceof Error ? error.cause : undefined;
			await this.#dependencies.failures?.record({
				schemaVersion: 1,
				jobId: failed.jobId,
				trigger: failed.trigger,
				stage: failed.stage,
				outcome,
				reasonCode,
				failedAt: now,
				attempt: failed.attempt,
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? (error.stack ?? null) : null,
					cause:
						cause instanceof Error
							? { name: cause.name, message: cause.message, stack: cause.stack ?? null }
							: cause === undefined
								? null
								: { name: "Error", message: String(cause), stack: null },
					diagnostics: executionError?.diagnostics ?? null,
				},
			});
		}
		return failed;
	}

	async #saveCancelled(job: EvolutionJob, lease: EvolutionLeaseToken): Promise<EvolutionJob> {
		if (isCancelledJob(job)) return job;
		if (job.outcome === "completed") throw new Error(`Completed evolution job "${job.jobId}" cannot be cancelled`);
		if (
			job.resolution !== null ||
			(job.outcome !== "active" && job.outcome !== "interrupted" && job.outcome !== "retryable-failed")
		) {
			throw new Error(`Evolution job "${job.jobId}" cannot be cancelled from outcome "${job.outcome}"`);
		}
		const resolvedAt = this.#dependencies.clock.now();
		const cancelled = this.#withJobRevision(job, {
			outcome: "interrupted",
			reasonCode: "cancelled-by-operator",
			failureMessage: "Evolution job was cancelled by the operator",
			resolution: {
				kind: "administratively-resolved",
				reasonCode: "cancelled-by-operator",
				resolvedAt,
			},
			terminalAt: resolvedAt,
			retryNotBefore: null,
		});
		await this.#dependencies.jobs.save(cancelled, job.revision, lease);
		await this.#syncLedger(cancelled);
		await this.#dependencies.events.emit({
			jobId: cancelled.jobId,
			emittedAt: cancelled.updatedAt,
			type: "failed",
			stage: cancelled.stage,
		});
		return cancelled;
	}

	async runJob(jobId: string, signal?: AbortSignal): Promise<EvolutionJob> {
		signal?.throwIfAborted();
		const initial = await this.#dependencies.jobs.load(jobId);
		if (initial === null) throw new Error(`Unknown evolution job "${jobId}"`);
		await this.#syncLedger(initial);
		if (initial.outcome === "completed") return initial;
		if (initial.outcome === "superseded" || initial.outcome === "terminal-failed" || initial.resolution !== null) {
			throw new Error(`Evolution job "${jobId}" cannot be resumed from outcome "${initial.outcome}"`);
		}
		if (
			initial.retryNotBefore !== null &&
			Date.parse(initial.retryNotBefore) > Date.parse(this.#dependencies.clock.now())
		) {
			throw new Error(`Evolution job "${jobId}" is not eligible for retry yet`);
		}

		const ownerId = this.#dependencies.ids.nextId("lease-owner");
		const initialLease = await this.#acquireScopeLease(initial.metadata.scope, ownerId);
		if (initialLease === null) {
			throw new EvolutionExecutionError(`Evolution scope for job "${jobId}" is already leased`, {
				reasonCode: "lease-lost",
				retryable: true,
			});
		}
		return this.#withHeartbeat(
			initialLease,
			signal,
			async (scopeLease, leaseSignal) => {
				const loadedJob = await this.#dependencies.jobs.load(jobId);
				if (loadedJob === null) throw new Error(`Unknown evolution job "${jobId}"`);
				let job: EvolutionJob = loadedJob;
				if (job.outcome === "completed") return job;
				if ((await this.#dependencies.cancellations.loadCancellation(jobId)) !== null) {
					await this.#saveCancelled(job, scopeLease());
					throw new EvolutionOperatorCancellationError(jobId);
				}
				if (job.outcome === "interrupted" || job.outcome === "retryable-failed") {
					const resumed = this.#withJobRevision(job, {
						outcome: "active",
						reasonCode: null,
						failureMessage: null,
						terminalAt: null,
						retryNotBefore: null,
						attempt: job.attempt + 1,
					});
					await this.#dependencies.jobs.save(resumed, job.revision, scopeLease());
					job = resumed;
				}
				try {
					const inputArtifact = await this.#dependencies.artifacts.get(job.inputSnapshot);
					if (!isInputSnapshot(inputArtifact)) {
						throw new EvolutionExecutionError("Job input snapshot artifact has the wrong type", {
							reasonCode: "artifact-corrupt",
							retryable: false,
						});
					}
					if (job.stage === "queued") {
						const started = this.#withJobRevision(job, { stage: "snapshotting" });
						await this.#dependencies.jobs.save(started, job.revision, scopeLease());
						job = started;
					}
					const lastCheckpoint = job.checkpoints.at(-1);
					if (lastCheckpoint?.stage === job.stage) {
						const completionState = this.#checkpointDirective(lastCheckpoint);
						if (completionState.directive !== "continue") {
							return await this.#completeJob(job, lastCheckpoint, scopeLease());
						}
					}

					while (job.stage !== "completed") {
						leaseSignal.throwIfAborted();
						if (job.stage === "writing" || job.stage === "activating") {
							const writerOwnerId = this.#dependencies.ids.nextId("writer-owner");
							const writerInitial = await this.#dependencies.leases.acquire(
								"writer",
								"global",
								writerOwnerId,
								this.#dependencies.clock.now(),
								this.#leaseTtlMs,
							);
							if (writerInitial === null) {
								throw new EvolutionExecutionError("Evolution writer is already leased", {
									reasonCode: "writer-failed",
									retryable: true,
								});
							}
							job = await this.#withHeartbeat(writerInitial, leaseSignal, async (writerLease, writerSignal) => {
								let current: EvolutionJob = job;
								while (current.stage === "writing" || current.stage === "activating") {
									current = await this.#executeStage(
										current,
										inputArtifact,
										scopeLease(),
										writerLease(),
										writerSignal,
									);
								}
								return current;
							});
							continue;
						}
						job = await this.#executeStage(job, inputArtifact, scopeLease(), null, leaseSignal);
					}
					return job;
				} catch (error) {
					try {
						const latest = await this.#dependencies.jobs.load(job.jobId);
						if (latest !== null) job = latest;
						if (job.outcome === "completed" || error instanceof EvolutionCompletionPendingError) throw error;
						if (leaseSignal.reason instanceof EvolutionOperatorCancellationError) {
							await this.#saveCancelled(job, scopeLease());
						} else {
							await this.#markFailure(job, error, scopeLease(), signal?.aborted === true);
						}
					} catch (persistenceError) {
						if (persistenceError === error) throw error;
						throw new AggregateError(
							[error, persistenceError],
							`Failed evolution job "${job.jobId}" and its recovery write`,
						);
					}
					throw error;
				}
			},
			jobId,
		);
	}

	async cancelJob(jobId: string): Promise<EvolutionJob> {
		const initial = await this.#dependencies.jobs.load(jobId);
		if (initial === null) throw new Error(`Unknown evolution job "${jobId}"`);
		if (isCancelledJob(initial)) return initial;
		if (initial.outcome === "completed") throw new Error(`Completed evolution job "${jobId}" cannot be cancelled`);
		if (
			initial.resolution !== null ||
			(initial.outcome !== "active" && initial.outcome !== "interrupted" && initial.outcome !== "retryable-failed")
		) {
			throw new Error(`Evolution job "${jobId}" cannot be cancelled from outcome "${initial.outcome}"`);
		}
		await this.#dependencies.cancellations.requestCancellation(jobId, this.#dependencies.clock.now());
		while (true) {
			const current = await this.#dependencies.jobs.load(jobId);
			if (current === null) throw new Error(`Unknown evolution job "${jobId}"`);
			if (isCancelledJob(current)) return current;
			if (current.outcome === "completed") {
				throw new Error(`Completed evolution job "${jobId}" cannot be cancelled`);
			}
			const ownerId = this.#dependencies.ids.nextId("lease-owner");
			const initialLease = await this.#acquireScopeLease(current.metadata.scope, ownerId);
			if (initialLease !== null) {
				return this.#withHeartbeat(initialLease, undefined, async (lease) => {
					const leased = await this.#dependencies.jobs.load(jobId);
					if (leased === null) throw new Error(`Unknown evolution job "${jobId}"`);
					return this.#saveCancelled(leased, lease());
				});
			}
			await abortableDelay(this.#cancellationPollIntervalMs, new AbortController().signal);
		}
	}

	async requestResume(jobId: string): Promise<EvolutionJob> {
		const initial = await this.#dependencies.jobs.load(jobId);
		if (initial === null) throw new Error(`Unknown evolution job "${jobId}"`);
		if (initial.outcome !== "interrupted" && initial.outcome !== "retryable-failed") {
			throw new Error(`Evolution job "${jobId}" cannot be resumed from outcome "${initial.outcome}"`);
		}
		if (initial.resolution !== null) throw new Error(`Resolved evolution job "${jobId}" cannot be resumed`);
		if ((await this.#dependencies.cancellations.loadCancellation(jobId)) !== null) {
			throw new Error(`Evolution job "${jobId}" has a pending cancellation request`);
		}
		const ownerId = this.#dependencies.ids.nextId("lease-owner");
		const initialLease = await this.#acquireScopeLease(initial.metadata.scope, ownerId);
		if (initialLease === null) throw new Error(`Evolution scope for job "${jobId}" is already leased`);
		return this.#withHeartbeat(initialLease, undefined, async (lease) => {
			const current = await this.#dependencies.jobs.load(jobId);
			if (current === null) throw new Error(`Unknown evolution job "${jobId}"`);
			if (current.outcome !== "interrupted" && current.outcome !== "retryable-failed") {
				throw new Error(`Evolution job "${jobId}" cannot be resumed from outcome "${current.outcome}"`);
			}
			if ((await this.#dependencies.cancellations.loadCancellation(jobId)) !== null) {
				throw new Error(`Evolution job "${jobId}" has a pending cancellation request`);
			}
			const resumed = this.#withJobRevision(current, {
				outcome: "active",
				reasonCode: null,
				failureMessage: null,
				terminalAt: null,
				retryNotBefore: null,
				attempt: current.attempt + 1,
			});
			await this.#dependencies.jobs.save(resumed, current.revision, lease());
			await this.#dependencies.events.emit({
				jobId: resumed.jobId,
				emittedAt: resumed.updatedAt,
				type: "started",
				stage: resumed.stage,
			});
			return resumed;
		});
	}

	async #markInterrupted(
		jobId: string,
		reasonCode: "cancelled-by-operator" | "lease-lost",
		failureMessage: string,
		allowBusy: boolean,
	): Promise<EvolutionJob | null> {
		const initial = await this.#dependencies.jobs.load(jobId);
		if (initial === null) throw new Error(`Unknown evolution job "${jobId}"`);
		if (initial.outcome !== "active") {
			if (allowBusy) return initial;
			throw new Error(`Evolution job "${jobId}" cannot be interrupted from outcome "${initial.outcome}"`);
		}
		const ownerId = this.#dependencies.ids.nextId("lease-owner");
		const initialLease = await this.#acquireScopeLease(initial.metadata.scope, ownerId);
		if (initialLease === null) {
			if (allowBusy) return null;
			throw new Error(`Evolution scope for job "${jobId}" is already leased`);
		}
		return this.#withHeartbeat(initialLease, undefined, async (lease) => {
			const current = await this.#dependencies.jobs.load(jobId);
			if (current === null) throw new Error(`Unknown evolution job "${jobId}"`);
			if (current.outcome !== "active") return current;
			const interrupted = this.#withJobRevision(current, {
				outcome: "interrupted",
				reasonCode,
				failureMessage,
				terminalAt: this.#dependencies.clock.now(),
				retryNotBefore: null,
			});
			await this.#dependencies.jobs.save(interrupted, current.revision, lease());
			await this.#syncLedger(interrupted);
			await this.#dependencies.events.emit({
				jobId: interrupted.jobId,
				emittedAt: interrupted.updatedAt,
				type: "failed",
				stage: interrupted.stage,
			});
			return interrupted;
		});
	}

	async interruptJob(jobId: string): Promise<EvolutionJob> {
		const interrupted = await this.#markInterrupted(
			jobId,
			"cancelled-by-operator",
			"Evolution job was cancelled by the operator",
			false,
		);
		if (interrupted === null) throw new Error(`Evolution scope for job "${jobId}" is already leased`);
		return interrupted;
	}

	async recoverAbandonedJob(jobId: string): Promise<EvolutionJob | null> {
		return this.#markInterrupted(jobId, "lease-lost", "Evolution job was interrupted after its lease expired", true);
	}

	async #resolveJob(
		jobId: string,
		kind: EvolutionJobResolution["kind"],
		reasonCode: EvolutionFailureReasonCode,
	): Promise<EvolutionJob> {
		const initial = await this.#dependencies.jobs.load(jobId);
		if (initial === null) throw new Error(`Unknown evolution job "${jobId}"`);
		if (initial.outcome === "completed") throw new Error(`Completed evolution job "${jobId}" cannot be resolved`);
		const ownerId = this.#dependencies.ids.nextId("lease-owner");
		const initialLease = await this.#acquireScopeLease(initial.metadata.scope, ownerId);
		if (initialLease === null) throw new Error(`Evolution scope for job "${jobId}" is already leased`);
		return this.#withHeartbeat(initialLease, undefined, async (lease) => {
			const current = await this.#dependencies.jobs.load(jobId);
			if (current === null) throw new Error(`Unknown evolution job "${jobId}"`);
			const resolution: EvolutionJobResolution = {
				kind,
				reasonCode,
				resolvedAt: this.#dependencies.clock.now(),
			};
			const resolved = this.#withJobRevision(current, {
				outcome: kind === "superseded" ? "superseded" : current.outcome,
				resolution,
				terminalAt: current.terminalAt ?? resolution.resolvedAt,
			});
			await this.#dependencies.jobs.save(resolved, current.revision, lease());
			return resolved;
		});
	}

	supersedeJob(jobId: string): Promise<EvolutionJob> {
		return this.#resolveJob(jobId, "superseded", "superseded-by-operator");
	}

	resolveJob(jobId: string): Promise<EvolutionJob> {
		return this.#resolveJob(jobId, "administratively-resolved", "superseded-by-operator");
	}
}
