import type { HarnessSelectResult, HarnessVersion, HarnessVersionList } from "@earendil-works/diffex-harness-state";
import type {
	EvolutionFailureReasonCode,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionJobOutcome,
	EvolutionJobStage,
	EvolutionLedgerEvent,
	EvolutionMemoryExactDiff,
	EvolutionProposal,
	EvolutionProposalLedgerDisposition,
	EvolutionScope,
	HarnessActivatedLedgerEvent,
	ScoredProposal,
	ValidationReport,
} from "./contracts.ts";
import type { EvolutionControlPlane, EvolutionJobCreationBlockReason } from "./control-plane.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionClock,
	EvolutionCursorStore,
	EvolutionEventSink,
	EvolutionEvidenceCatalog,
	EvolutionJobStore,
	EvolutionLedger,
	EvolutionProgressEvent,
} from "./ports.ts";
import {
	AUTOMATIC_EVOLUTION_COOLDOWN_MS,
	AUTOMATIC_EVOLUTION_MINIMUM_INVOCATIONS,
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	estimateEvolutionTokens,
	evaluateAutomaticEvolutionEligibility,
} from "./token-estimator.ts";
import type { EvolutionBackgroundWorker } from "./worker.ts";

export interface EvolutionHarnessControl {
	listVersions(): Promise<HarnessVersionList>;
	selectVersionIfCurrent(version: HarnessVersion, expectedCurrent: HarnessVersion): Promise<HarnessSelectResult>;
}

export interface EvolutionJobSummary {
	readonly jobId: string;
	readonly trigger: EvolutionJob["trigger"];
	readonly stage: EvolutionJobStage;
	readonly outcome: EvolutionJobOutcome;
	readonly reasonCode: EvolutionFailureReasonCode | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly terminalAt: string | null;
	readonly resumable: boolean;
	readonly cancellable: boolean;
}

export interface EvolutionRollbackAction {
	readonly jobId: string;
	readonly fromHarnessVersion: HarnessVersion;
	readonly toHarnessVersion: HarnessVersion;
	readonly proposalIds: readonly string[];
}

export interface EvolutionOverview {
	readonly scope: EvolutionScope;
	readonly processedEvidenceCursor: number;
	readonly ingestionHighWaterCursor: number;
	readonly unprocessedEstimatedTokens: number;
	readonly settledInvocationCount: number;
	readonly automaticTokenThreshold: number;
	readonly automaticMinimumInvocations: number;
	readonly lastAutomaticRunAt: string | null;
	readonly cooldownRemainingMs: number;
	readonly automaticEligibility:
		| { readonly eligible: true }
		| { readonly eligible: false; readonly reason: EvolutionJobCreationBlockReason };
	readonly activeJob: EvolutionJobSummary | null;
	readonly newestResumableJob: EvolutionJobSummary | null;
	readonly currentHarnessVersion: HarnessVersion | null;
	readonly observedHarnessVersion: HarnessVersion | null;
	readonly nextPromptWillRefresh: boolean;
	readonly rollbackAction: EvolutionRollbackAction | null;
}

export interface EvolutionJobDetail extends EvolutionJobSummary {
	readonly evidenceHighWaterCursor: number;
	readonly completedSlices: number;
	readonly discoveredSlices: number;
	readonly modelCalls: number;
	readonly modelRetries: number;
	readonly emittedProposals: number;
	readonly eligibleProposals: number;
	readonly selectedOperations: number;
	readonly lastCheckpointAt: string | null;
	readonly errorMessage: string | null;
	readonly baseHarnessVersion: HarnessVersion;
	readonly activatedHarnessVersion: HarnessVersion | null;
	readonly nextPromptWillRefresh: boolean;
	readonly proposalIds: readonly string[];
	readonly observability: EvolutionJobObservability;
}

export interface EvolutionStageLatency {
	readonly stage: EvolutionJobStage;
	readonly durationMs: number;
}

export interface EvolutionJobObservability {
	readonly queueAgeMs: number | null;
	readonly stageLatencies: readonly EvolutionStageLatency[];
	readonly estimatedEvidenceTokens: number;
	readonly providerCostUsd: null;
	readonly reflectorBudget: {
		readonly modelCalls: number;
		readonly reflectionRounds: number;
		readonly toolCalls: number;
	};
	readonly sliceCoverage: {
		readonly analyzed: number;
		readonly corrupt: number;
		readonly skipped: number;
		readonly unreadable: number;
	};
	readonly proposalDispositions: Readonly<Record<EvolutionProposalLedgerDisposition, number>>;
	readonly activationConflicts: number;
	readonly rollbackAvailable: boolean;
	readonly recoveryAttempts: number;
}

export interface EvolutionProposalDetail {
	readonly proposal: EvolutionProposal;
	readonly score: ScoredProposal | null;
	readonly validationDisposition: string | null;
	readonly exactAppliedDiff: EvolutionMemoryExactDiff | null;
	readonly rollbackTarget: HarnessVersion | null;
}

export type EvolutionStartResult =
	| { readonly status: "created"; readonly job: EvolutionJobSummary }
	| { readonly status: "attached"; readonly job: EvolutionJobSummary }
	| { readonly status: "not-created"; readonly reason: EvolutionJobCreationBlockReason };

export interface EvolutionControlServiceDependencies {
	readonly scope: EvolutionScope;
	readonly clock: EvolutionClock;
	readonly controlPlane: EvolutionControlPlane;
	readonly worker: EvolutionBackgroundWorker;
	readonly jobs: EvolutionJobStore;
	readonly cursors: EvolutionCursorStore;
	readonly evidence: EvolutionEvidenceCatalog;
	readonly artifacts: EvolutionArtifactStore;
	readonly ledger: EvolutionLedger;
	readonly harnesses: EvolutionHarnessControl;
	readonly progress: EvolutionProgressBus;
	readonly observedHarnessVersion: () => HarnessVersion | undefined;
}

function isInputSnapshot(artifact: EvolutionArtifact): artifact is EvolutionInputSnapshot {
	return "ingestionHighWaterCursor" in artifact && "evidenceSources" in artifact && "harness" in artifact;
}

function isScoredProposal(artifact: EvolutionArtifact): artifact is ScoredProposal {
	return "proposal" in artifact && "evidenceRankingScore" in artifact;
}

function isValidationReport(artifact: EvolutionArtifact): artifact is ValidationReport {
	return "proposalResults" in artifact && "validatorVersion" in artifact;
}

function isCoverageMap(artifact: EvolutionArtifact): artifact is Extract<EvolutionArtifact, { entries: unknown }> {
	return "manifestDigest" in artifact && "entries" in artifact && "finalLessonIds" in artifact;
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function summary(job: EvolutionJob): EvolutionJobSummary {
	return {
		jobId: job.jobId,
		trigger: job.trigger,
		stage: job.stage,
		outcome: job.outcome,
		reasonCode: job.reasonCode,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		terminalAt: job.terminalAt,
		resumable: job.resolution === null && (job.outcome === "interrupted" || job.outcome === "retryable-failed"),
		cancellable: job.resolution === null && job.outcome === "active",
	};
}

function newest(jobs: readonly EvolutionJob[]): EvolutionJob | null {
	return (
		[...jobs].sort(
			(left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.jobId.localeCompare(left.jobId),
		)[0] ?? null
	);
}

function activeJob(jobs: readonly EvolutionJob[]): EvolutionJob | null {
	return newest(jobs.filter((job) => job.resolution === null && job.outcome === "active"));
}

function resumableJob(jobs: readonly EvolutionJob[]): EvolutionJob | null {
	return newest(
		jobs.filter(
			(job) => job.resolution === null && (job.outcome === "interrupted" || job.outcome === "retryable-failed"),
		),
	);
}

async function loadArtifacts(job: EvolutionJob, store: EvolutionArtifactStore): Promise<readonly EvolutionArtifact[]> {
	const artifacts: EvolutionArtifact[] = [await store.get(job.inputSnapshot)];
	for (const checkpoint of job.checkpoints) {
		for (const reference of checkpoint.outputArtifacts) artifacts.push(await store.get(reference));
	}
	return artifacts;
}

function harnessActivation(events: readonly EvolutionLedgerEvent[]): HarnessActivatedLedgerEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "harness-activated") return event;
	}
	return null;
}

export class EvolutionProgressBus implements EvolutionEventSink {
	readonly #listeners = new Set<(event: EvolutionProgressEvent) => void>();

	emit(event: EvolutionProgressEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	subscribe(listener: (event: EvolutionProgressEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

export class EvolutionControlService {
	readonly #dependencies: EvolutionControlServiceDependencies;
	#started = false;

	constructor(dependencies: EvolutionControlServiceDependencies) {
		this.#dependencies = dependencies;
	}

	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#dependencies.worker.start();
	}

	subscribe(listener: (event: EvolutionProgressEvent) => void): () => void {
		return this.#dependencies.progress.subscribe(listener);
	}

	async stop(): Promise<void> {
		if (!this.#started) return;
		this.#started = false;
		await this.#dependencies.worker.stop(new Error("Evolution shutdown interrupted active work"));
	}

	async #rollbackAction(
		jobs: readonly EvolutionJob[],
		versions: HarnessVersionList,
	): Promise<EvolutionRollbackAction | null> {
		if (versions.currentVersion === null) return null;
		const validVersions = new Set(versions.versions.map((bundle) => bundle.manifest.version));
		for (const job of [...jobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
			const activation = harnessActivation(await this.#dependencies.ledger.read(job.jobId));
			if (
				activation?.resultingHarnessVersion === versions.currentVersion &&
				validVersions.has(activation.rollbackParentHarnessVersion)
			) {
				return {
					jobId: job.jobId,
					fromHarnessVersion: activation.resultingHarnessVersion,
					toHarnessVersion: activation.rollbackParentHarnessVersion,
					proposalIds: activation.proposalIds,
				};
			}
		}
		return null;
	}

	async overview(): Promise<EvolutionOverview> {
		const [cursor, highWater, jobs, versions] = await Promise.all([
			this.#dependencies.cursors.load(this.#dependencies.scope),
			this.#dependencies.evidence.highWaterCursor(this.#dependencies.scope),
			this.#dependencies.jobs.list(this.#dependencies.scope),
			this.#dependencies.harnesses.listVersions(),
		]);
		const materializations = await this.#dependencies.evidence.listSuccessful(
			this.#dependencies.scope,
			cursor.sequence,
			highWater,
		);
		const estimatedTokens = estimateEvolutionTokens(materializations.map((entry) => entry.invocation));
		const lastAutomaticRunAt =
			jobs
				.filter((job) => job.trigger === "automatic" && job.terminalAt !== null)
				.map((job) => job.terminalAt as string)
				.sort()
				.at(-1) ?? null;
		const currentTime = Date.parse(this.#dependencies.clock.now());
		const cooldownRemainingMs =
			lastAutomaticRunAt === null
				? 0
				: Math.max(0, AUTOMATIC_EVOLUTION_COOLDOWN_MS - (currentTime - Date.parse(lastAutomaticRunAt)));
		const active = activeJob(jobs);
		const resumable = resumableJob(jobs);
		const eligibility =
			active !== null
				? ({ eligible: false, reason: "blocking-job" } as const)
				: evaluateAutomaticEvolutionEligibility({
						invocationCount: materializations.length,
						estimatedTokens,
						now: new Date(currentTime).toISOString(),
						previousAutomaticTerminalAt: lastAutomaticRunAt,
					});
		const observedHarnessVersion = this.#dependencies.observedHarnessVersion() ?? null;
		return {
			scope: this.#dependencies.scope,
			processedEvidenceCursor: cursor.sequence,
			ingestionHighWaterCursor: highWater,
			unprocessedEstimatedTokens: estimatedTokens,
			settledInvocationCount: materializations.length,
			automaticTokenThreshold: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
			automaticMinimumInvocations: AUTOMATIC_EVOLUTION_MINIMUM_INVOCATIONS,
			lastAutomaticRunAt,
			cooldownRemainingMs,
			automaticEligibility: eligibility,
			activeJob: active === null ? null : summary(active),
			newestResumableJob: resumable === null ? null : summary(resumable),
			currentHarnessVersion: versions.currentVersion,
			observedHarnessVersion,
			nextPromptWillRefresh:
				versions.currentVersion !== null &&
				observedHarnessVersion !== null &&
				versions.currentVersion !== observedHarnessVersion,
			rollbackAction: await this.#rollbackAction(jobs, versions),
		};
	}

	async listJobs(): Promise<readonly EvolutionJobSummary[]> {
		return (await this.#dependencies.jobs.list(this.#dependencies.scope))
			.slice()
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.jobId.localeCompare(left.jobId))
			.map(summary);
	}

	async #start(trigger: "automatic" | "manual"): Promise<EvolutionStartResult> {
		const result = await this.#dependencies.controlPlane.createJob({ scope: this.#dependencies.scope, trigger });
		if (result.status === "created") return { status: "created", job: summary(result.job) };
		if (result.reason === "blocking-job" && result.blockingJobId !== undefined) {
			const blocking = await this.#dependencies.jobs.load(result.blockingJobId);
			if (blocking !== null) return { status: "attached", job: summary(blocking) };
		}
		return { status: "not-created", reason: result.reason };
	}

	startManual(): Promise<EvolutionStartResult> {
		return this.#start("manual");
	}

	triggerAutomatic(): Promise<EvolutionStartResult> {
		return this.#start("automatic");
	}

	async resumeNewest(): Promise<EvolutionJobSummary> {
		const job = resumableJob(await this.#dependencies.jobs.list(this.#dependencies.scope));
		if (job === null) throw new Error("No interrupted or retryable evolution job is available");
		return summary(await this.#dependencies.controlPlane.requestResume(job.jobId));
	}

	async cancelActive(): Promise<EvolutionJobSummary> {
		const active = activeJob(await this.#dependencies.jobs.list(this.#dependencies.scope));
		if (active === null) throw new Error("No active evolution job is available");
		await this.#dependencies.worker.stop(new Error("Evolution job cancelled by the operator"));
		let current = await this.#dependencies.jobs.load(active.jobId);
		if (current?.outcome === "active") current = await this.#dependencies.controlPlane.interruptJob(active.jobId);
		if (this.#started) this.#dependencies.worker.start();
		if (current === null) throw new Error(`Unknown evolution job "${active.jobId}"`);
		return summary(current);
	}

	async rollback(): Promise<EvolutionRollbackAction> {
		const jobs = await this.#dependencies.jobs.list(this.#dependencies.scope);
		const versions = await this.#dependencies.harnesses.listVersions();
		const action = await this.#rollbackAction(jobs, versions);
		if (action === null) throw new Error("No valid evolution rollback is available");
		const result = await this.#dependencies.harnesses.selectVersionIfCurrent(
			action.toHarnessVersion,
			action.fromHarnessVersion,
		);
		if (result.status === "conflict") {
			throw new Error(
				`Harness revision changed before rollback: expected ${result.expectedCurrent}, found ${result.actualCurrent}`,
			);
		}
		return action;
	}

	async getJob(jobId: string): Promise<EvolutionJobDetail> {
		const job = await this.#dependencies.jobs.load(jobId);
		if (job === null || job.metadata.scope.repositoryId !== this.#dependencies.scope.repositoryId) {
			throw new Error(`Unknown evolution job "${jobId}"`);
		}
		const [artifacts, events, versions] = await Promise.all([
			loadArtifacts(job, this.#dependencies.artifacts),
			this.#dependencies.ledger.read(jobId),
			this.#dependencies.harnesses.listVersions(),
		]);
		const input = artifacts.find(isInputSnapshot);
		if (input === undefined) throw new Error(`Evolution job "${jobId}" has no input snapshot`);
		const scored = artifacts.filter(isScoredProposal);
		const discoveredSlices = new Set(
			artifacts.flatMap((artifact) => ("sliceIds" in artifact ? stringArray(artifact.sliceIds) : [])),
		).size;
		const completedSlices = new Set(
			artifacts.flatMap((artifact) =>
				"sliceIds" in artifact && "status" in artifact && artifact.status === "complete"
					? stringArray(artifact.sliceIds)
					: [],
			),
		).size;
		const proposalIds = [
			...new Set(
				job.checkpoints.flatMap((checkpoint) =>
					checkpoint.stage === "curating" ? stringArray(checkpoint.state.proposalIds) : [],
				),
			),
		];
		const activation = harnessActivation(events);
		const modelCalls = events.filter((event) => event.type === "reflector-model-call").length;
		const modelRetries = events.filter((event) => event.type === "reflector-model-call" && event.attempt > 1).length;
		const selectedOperations = activation?.operationIds.length ?? 0;
		const observed = this.#dependencies.observedHarnessVersion() ?? null;
		const firstCheckpoint = job.checkpoints[0];
		const queueStart = firstCheckpoint?.startedAt;
		const queueAgeMs =
			queueStart === undefined ? null : Math.max(0, Date.parse(queueStart) - Date.parse(job.createdAt));
		const stageLatencies = job.checkpoints.map((checkpoint, index) => {
			const startedAt = checkpoint.startedAt ?? job.checkpoints[index - 1]?.completedAt ?? job.createdAt;
			return {
				stage: checkpoint.stage,
				durationMs: Math.max(0, Date.parse(checkpoint.completedAt) - Date.parse(startedAt)),
			};
		});
		const reflectorBudget = events.reduce(
			(total, event) => {
				if (event.type !== "reflector-model-call" && event.type !== "reflector-tool-call") return total;
				return {
					modelCalls: total.modelCalls + event.budgetCharge.modelCalls,
					reflectionRounds: total.reflectionRounds + event.budgetCharge.reflectionRounds,
					toolCalls: total.toolCalls + event.budgetCharge.toolCalls,
				};
			},
			{ modelCalls: 0, reflectionRounds: 0, toolCalls: 0 },
		);
		const coverageEntries = artifacts.filter(isCoverageMap).flatMap((artifact) => artifact.entries);
		const sliceCoverage = {
			analyzed: coverageEntries.filter((entry) => entry.disposition === "analyzed").length,
			corrupt: coverageEntries.filter((entry) => entry.disposition === "corrupt").length,
			skipped: coverageEntries.filter((entry) => entry.disposition === "skipped").length,
			unreadable: coverageEntries.filter((entry) => entry.disposition === "unreadable").length,
		};
		const proposalDispositions: Record<EvolutionProposalLedgerDisposition, number> = {
			applied: 0,
			deferred: 0,
			failed: 0,
			quarantined: 0,
			rejected: 0,
			"rolled-back": 0,
			superseded: 0,
			unselected: 0,
		};
		for (const event of events) {
			if (event.type === "proposal-disposition") proposalDispositions[event.disposition] += 1;
			if (event.type === "proposal-rolled-back") proposalDispositions["rolled-back"] += 1;
		}
		const validVersions = new Set(versions.versions.map((bundle) => bundle.manifest.version));
		const rollbackAvailable =
			activation !== null &&
			versions.currentVersion === activation.resultingHarnessVersion &&
			validVersions.has(activation.rollbackParentHarnessVersion);
		return {
			...summary(job),
			evidenceHighWaterCursor: input.ingestionHighWaterCursor,
			completedSlices,
			discoveredSlices,
			modelCalls,
			modelRetries,
			emittedProposals: proposalIds.length,
			eligibleProposals: scored.filter(
				(entry) => entry.disposition === "selected" || entry.disposition === "unselected",
			).length,
			selectedOperations,
			lastCheckpointAt: job.checkpoints.at(-1)?.completedAt ?? null,
			errorMessage: job.failureMessage,
			baseHarnessVersion: input.expectedHarnessBaseVersion,
			activatedHarnessVersion: activation?.resultingHarnessVersion ?? null,
			nextPromptWillRefresh:
				versions.currentVersion !== null && observed !== null && versions.currentVersion !== observed,
			proposalIds,
			observability: {
				queueAgeMs,
				stageLatencies,
				estimatedEvidenceTokens: input.tokenMeasurement.estimatedTokens,
				providerCostUsd: null,
				reflectorBudget,
				sliceCoverage,
				proposalDispositions,
				activationConflicts: events.filter(
					(event) => event.type === "job-failed" && event.reasonCode === "harness-base-conflict",
				).length,
				rollbackAvailable,
				recoveryAttempts: job.attempt,
			},
		};
	}

	async getProposal(jobId: string, proposalId: string): Promise<EvolutionProposalDetail> {
		const job = await this.#dependencies.jobs.load(jobId);
		if (job === null) throw new Error(`Unknown evolution job "${jobId}"`);
		const [artifacts, events] = await Promise.all([
			loadArtifacts(job, this.#dependencies.artifacts),
			this.#dependencies.ledger.read(jobId),
		]);
		const score =
			artifacts.filter(isScoredProposal).find((entry) => entry.proposal.proposalId === proposalId) ?? null;
		const proposal =
			score?.proposal ??
			(artifacts.find(
				(artifact): artifact is EvolutionProposal => "proposalId" in artifact && artifact.proposalId === proposalId,
			) as EvolutionProposal | undefined);
		if (proposal === undefined) throw new Error(`Unknown evolution proposal "${proposalId}"`);
		const validation = artifacts.find(isValidationReport);
		const activation = harnessActivation(events);
		return {
			proposal,
			score,
			validationDisposition:
				validation?.proposalResults.find((result) => result.proposalId === proposalId)?.disposition ?? null,
			exactAppliedDiff: activation?.proposalIds.includes(proposalId) ? activation.exactDiff : null,
			rollbackTarget: activation?.proposalIds.includes(proposalId) ? activation.rollbackParentHarnessVersion : null,
		};
	}
}
