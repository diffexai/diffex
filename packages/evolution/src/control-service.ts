import {
	computeHarnessSkillId,
	type HarnessSelectResult,
	type HarnessVersion,
	type HarnessVersionBundle,
	type HarnessVersionList,
} from "@earendil-works/diffex-harness-state";
import type { MaterializedEvidence } from "@earendil-works/diffex-harness-trace";
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
	EvolutionRepositorySnapshot,
	EvolutionScope,
	EvolutionSkillContentArtifact,
	HarnessActivatedLedgerEvent,
	HarnessActivationReceipt,
	ScoredProposal,
	SkillCandidate,
	SkillCandidateGroup,
	SkillCandidateOperation,
	SkillCandidateRegistryEvent,
	SkillCandidateState,
	SkillCandidateWorkCheckpointedEvent,
	SkillCandidateWorkFailedEvent,
	SkillCandidateWorkStage,
	SkillDraft,
	SkillDraftValidationReport,
	SkillEvaluationReport,
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
	SkillCandidateRegistry,
	SkillCandidateRegistryStore,
} from "./ports.ts";
import { computeEvolutionTextDigest } from "./provenance.ts";
import {
	AUTOMATIC_EVOLUTION_COOLDOWN_MS,
	AUTOMATIC_EVOLUTION_MINIMUM_INVOCATIONS,
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	countEvolutionTokens,
	evaluateAutomaticEvolutionEligibility,
} from "./token-estimator.ts";
import type { EvolutionBackgroundWorker } from "./worker.ts";

export interface EvolutionHarnessControl {
	listVersions(): Promise<HarnessVersionList>;
	selectVersionIfCurrent(version: HarnessVersion, expectedCurrent: HarnessVersion): Promise<HarnessSelectResult>;
}

export type EvolutionAnalysisStatus = "waiting" | "processing" | "completed" | "failed";

export type EvolutionCandidateGenerationStatus =
	| "waiting"
	| "processing"
	| "retrying"
	| "completed"
	| "partial-failure"
	| "failed"
	| "not-applicable";

export interface EvolutionCandidateGenerationSummary {
	readonly status: EvolutionCandidateGenerationStatus;
	readonly stage: SkillCandidateWorkStage | null;
	readonly updatedAt: string | null;
	readonly attempt: number;
	readonly retryNotBefore: string | null;
	readonly failureMessage: string | null;
}

export interface EvolutionJobSummary {
	readonly jobId: string;
	readonly trigger: EvolutionJob["trigger"];
	readonly stage: EvolutionJobStage;
	readonly outcome: EvolutionJobOutcome;
	readonly reasonCode: EvolutionFailureReasonCode | null;
	readonly analysisStatus: EvolutionAnalysisStatus;
	readonly candidateGeneration: EvolutionCandidateGenerationSummary;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly terminalAt: string | null;
	readonly resumable: boolean;
	readonly cancellable: boolean;
}

export interface EvolutionHarnessVersionInfo {
	readonly version: HarnessVersion;
	readonly kind: "default" | "evolved";
	readonly evolvedAt: string | null;
	readonly evolvedIn: string | null;
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
	readonly unprocessedTokens: number;
	readonly settledInvocationCount: number;
	readonly automaticTokenThreshold: number;
	readonly automaticMinimumInvocations: number;
	readonly lastEvolutionAt: string | null;
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

export interface EvolutionSkillCandidateSummary {
	readonly candidateId: string;
	readonly groupId: string | null;
	readonly proposedName: string;
	readonly operation: SkillCandidateOperation;
	readonly state: SkillCandidateState;
	readonly latestTransitionAt: string;
	readonly latestReasonCodes: readonly string[];
}

export interface EvolutionSkillCandidateExistingContent {
	readonly skillId: string;
	readonly name: string;
	readonly version: string;
	readonly content: string;
}

export interface EvolutionSkillCandidateDetail {
	readonly summary: EvolutionSkillCandidateSummary;
	readonly candidate: SkillCandidate;
	readonly supportingEvidence: readonly MaterializedEvidence[];
	readonly contradictingEvidence: readonly MaterializedEvidence[];
	readonly sourceEvolutionJobIds: readonly string[];
	readonly proposalRevisionIds: readonly string[];
	readonly existingContents: readonly EvolutionSkillCandidateExistingContent[];
	readonly draft: SkillDraft | null;
	readonly validation: SkillDraftValidationReport | null;
	readonly evaluation: SkillEvaluationReport | null;
	readonly targetHarnessVersion: HarnessVersion | null;
	readonly rollbackTargetHarnessVersion: HarnessVersion | null;
	readonly rollbackAvailable: boolean;
	readonly activationAvailable: boolean;
}

export interface EvolutionSkillActivationResult {
	readonly groupId: string;
	readonly batchId: string;
	readonly targetHarnessVersion: HarnessVersion;
	readonly receipt: HarnessActivationReceipt;
}

export interface EvolutionSkillActivationControl {
	activate(scope: EvolutionScope, groupId: string): Promise<EvolutionSkillActivationResult>;
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
	readonly baseHarnessInfo: EvolutionHarnessVersionInfo;
	readonly activatedHarnessVersion: HarnessVersion | null;
	readonly nextPromptWillRefresh: boolean;
	readonly proposalIds: readonly string[];
	readonly proposals: readonly EvolutionProposal[];
	readonly skillCandidates: readonly EvolutionSkillCandidateSummary[];
	readonly observability: EvolutionJobObservability;
}

export interface EvolutionStageLatency {
	readonly stage: EvolutionJobStage;
	readonly durationMs: number;
}

export interface EvolutionJobObservability {
	readonly queueAgeMs: number | null;
	readonly stageLatencies: readonly EvolutionStageLatency[];
	readonly evidenceTokens: number;
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
	} | null;
	readonly proposalDispositions: Readonly<Record<EvolutionProposalLedgerDisposition, number>>;
	readonly activationConflicts: number;
	readonly rollbackAvailable: boolean;
	readonly recoveryAttempts: number;
}

export interface EvolutionProposalDetail {
	readonly proposal: EvolutionProposal;
	readonly supportingEvidence: readonly MaterializedEvidence[];
	readonly contradictingEvidence: readonly MaterializedEvidence[];
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
	readonly skillCandidates?: SkillCandidateRegistry;
	readonly skillCandidateRegistryStore?: SkillCandidateRegistryStore;
	readonly skillActivation?: EvolutionSkillActivationControl;
	readonly observedHarnessVersion: () => HarnessVersion | undefined;
	readonly currentDirectory: {
		readonly directoryId: string;
		readonly rootPath: string;
		containsRevision(revision: string): Promise<boolean>;
	};
}

function isInputSnapshot(artifact: EvolutionArtifact): artifact is EvolutionInputSnapshot {
	return "ingestionHighWaterCursor" in artifact && "evidenceSources" in artifact && "harness" in artifact;
}

function evidenceTokenTotal(input: EvolutionInputSnapshot): number {
	return "totalTokens" in input.tokenMeasurement
		? input.tokenMeasurement.totalTokens
		: input.tokenMeasurement.estimatedTokens;
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

function isSkillCandidate(artifact: EvolutionArtifact): artifact is SkillCandidate {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-candidate";
}

function isSkillContent(artifact: EvolutionArtifact): artifact is EvolutionSkillContentArtifact {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-content";
}

function isSkillDraft(artifact: EvolutionArtifact): artifact is SkillDraft {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-draft";
}

function isSkillValidation(artifact: EvolutionArtifact): artifact is SkillDraftValidationReport {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-draft-validation";
}

function isSkillEvaluation(artifact: EvolutionArtifact): artifact is SkillEvaluationReport {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-evaluation";
}

function resolveEvidence(input: EvolutionInputSnapshot, evidenceIds: readonly string[]): MaterializedEvidence[] {
	const evidence = new Map(
		input.evidenceSources.flatMap((source) =>
			source.invocation.evidence.map((item) => [item.evidenceId, item] as const),
		),
	);
	return evidenceIds.map((evidenceId) => {
		const item = evidence.get(evidenceId);
		if (item === undefined) throw new Error(`Evolution evidence "${evidenceId}" is unavailable`);
		return item;
	});
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function analysisStatus(job: EvolutionJob): EvolutionAnalysisStatus {
	if (job.outcome === "active") return job.stage === "queued" ? "waiting" : "processing";
	return job.outcome === "completed" ? "completed" : "failed";
}

function candidateGenerationSummary(
	job: EvolutionJob,
	groups: readonly SkillCandidateGroup[],
	events: readonly SkillCandidateRegistryEvent[],
): EvolutionCandidateGenerationSummary {
	const candidateIds = stringArray(
		job.checkpoints.find((checkpoint) => checkpoint.stage === "skill-curating")?.state.candidateIds,
	);
	if (job.outcome !== "completed" || candidateIds.length === 0) {
		return {
			status: "not-applicable",
			stage: null,
			updatedAt: null,
			attempt: 0,
			retryNotBefore: null,
			failureMessage: null,
		};
	}
	const workEvents = events
		.filter(
			(event): event is SkillCandidateWorkCheckpointedEvent | SkillCandidateWorkFailedEvent =>
				(event.type === "skill-candidate-work-checkpointed" || event.type === "skill-candidate-work-failed") &&
				event.sourceEvolutionJobId === job.jobId,
		)
		.sort((left, right) => left.registrySequence - right.registrySequence);
	const latest = workEvents.at(-1);
	if (latest === undefined) {
		return {
			status: "waiting",
			stage: null,
			updatedAt: null,
			attempt: 0,
			retryNotBefore: null,
			failureMessage: null,
		};
	}
	if (latest.type === "skill-candidate-work-checkpointed") {
		return {
			status: latest.stage === "completed" ? "completed" : "processing",
			stage: latest.stage,
			updatedAt: latest.metadata.createdAt,
			attempt: latest.attempt,
			retryNotBefore: null,
			failureMessage: null,
		};
	}
	if (latest.retryNotBefore !== null) {
		return {
			status: "retrying",
			stage: latest.stage ?? null,
			updatedAt: latest.metadata.createdAt,
			attempt: latest.attempt,
			retryNotBefore: latest.retryNotBefore,
			failureMessage: latest.message,
		};
	}
	const relatedGroups = groups.filter((group) =>
		group.proposalRevisions.some((revision) => revision.sourceEvolutionJobId === job.jobId),
	);
	const failedGroupIds = new Set([
		...relatedGroups.filter((group) => group.state === "synthesis-failed").map((group) => group.groupId),
		...(latest.diagnostics ?? []).flatMap((diagnostic) => diagnostic.groupId ?? []),
	]);
	return {
		status:
			failedGroupIds.size > 0 && relatedGroups.some((group) => !failedGroupIds.has(group.groupId))
				? "partial-failure"
				: "failed",
		stage: latest.stage ?? null,
		updatedAt: latest.metadata.createdAt,
		attempt: latest.attempt,
		retryNotBefore: null,
		failureMessage: latest.message,
	};
}

function summary(
	job: EvolutionJob,
	groups: readonly SkillCandidateGroup[] = [],
	events: readonly SkillCandidateRegistryEvent[] = [],
): EvolutionJobSummary {
	return {
		jobId: job.jobId,
		trigger: job.trigger,
		stage: job.stage,
		outcome: job.outcome,
		reasonCode: job.reasonCode,
		analysisStatus: analysisStatus(job),
		candidateGeneration: candidateGenerationSummary(job, groups, events),
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		terminalAt: job.terminalAt,
		resumable: job.resolution === null && (job.outcome === "interrupted" || job.outcome === "retryable-failed"),
		cancellable:
			job.resolution === null &&
			(job.outcome === "active" || job.outcome === "interrupted" || job.outcome === "retryable-failed"),
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

function isCancelledJob(job: EvolutionJob): boolean {
	return job.resolution?.reasonCode === "cancelled-by-operator";
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

function candidateGroup(groups: readonly SkillCandidateGroup[], candidateId: string): SkillCandidateGroup | null {
	return (
		groups.find((group) => group.proposalRevisions.some((revision) => revision.candidateId === candidateId)) ?? null
	);
}

function candidateSummary(
	candidate: SkillCandidate,
	group: SkillCandidateGroup | null,
): EvolutionSkillCandidateSummary {
	const latestTransition = group?.dispositionHistory.at(-1);
	return {
		candidateId: candidate.candidateId,
		groupId: group?.groupId ?? null,
		proposedName: candidate.proposedName,
		operation: candidate.operation,
		state: group?.state ?? "proposed",
		latestTransitionAt: latestTransition?.createdAt ?? candidate.metadata.createdAt,
		latestReasonCodes: latestTransition?.reasonCodes ?? [],
	};
}

function skillCandidateIsApplied(bundle: HarnessVersionBundle, candidate: SkillCandidate, draft: SkillDraft): boolean {
	const skillIds = new Set(bundle.state.skills.map((skill) => computeHarnessSkillId(skill.workspace, skill.path)));
	if (draft.operation === "RETIRE") {
		return candidate.existingSkillIds.every((skillId) => !skillIds.has(skillId));
	}
	const target = bundle.state.skills.find(
		(skill) =>
			skill.path === `skills/${draft.proposedName}/SKILL.md` &&
			skill.contentHash === computeEvolutionTextDigest(draft.content),
	);
	if (target === undefined || target.files.length !== draft.files.length) return false;
	const targetFiles = new Map(target.files.map((file) => [file.path, file.contentHash]));
	if (draft.files.some((file) => targetFiles.get(file.path) !== computeEvolutionTextDigest(file.content)))
		return false;
	const targetId = computeHarnessSkillId(target.workspace, target.path);
	return candidate.existingSkillIds.every((skillId) => skillId === targetId || !skillIds.has(skillId));
}

function skillCandidateHarnessState(
	versions: HarnessVersionList,
	candidate: SkillCandidate,
	draft: SkillDraft,
): { readonly active: boolean; readonly rollbackTarget: HarnessVersion | null } {
	if (versions.currentVersion === null) return { active: false, rollbackTarget: null };
	const bundles = new Map(versions.versions.map((bundle) => [bundle.manifest.version, bundle]));
	let current = bundles.get(versions.currentVersion);
	if (current === undefined || !skillCandidateIsApplied(current, candidate, draft)) {
		return { active: false, rollbackTarget: null };
	}
	const visited = new Set<HarnessVersion>();
	while (current.manifest.base !== null) {
		if (visited.has(current.manifest.version)) return { active: true, rollbackTarget: null };
		visited.add(current.manifest.version);
		const parent = bundles.get(current.manifest.base);
		if (parent === undefined) return { active: true, rollbackTarget: null };
		if (!skillCandidateIsApplied(parent, candidate, draft)) {
			return { active: true, rollbackTarget: parent.manifest.version };
		}
		current = parent;
	}
	return { active: true, rollbackTarget: null };
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

	async #candidateState(): Promise<{
		readonly groups: readonly SkillCandidateGroup[];
		readonly events: readonly SkillCandidateRegistryEvent[];
	}> {
		const [groups, snapshot] = await Promise.all([
			this.#dependencies.skillCandidates?.list(this.#dependencies.scope) ?? Promise.resolve([]),
			this.#dependencies.skillCandidateRegistryStore?.loadSkillCandidateRegistry(this.#dependencies.scope) ??
				Promise.resolve({ revision: 0, events: [] }),
		]);
		return { groups, events: snapshot.events };
	}

	async #summaries(jobs: readonly EvolutionJob[]): Promise<readonly EvolutionJobSummary[]> {
		const candidateState = await this.#candidateState();
		return jobs.map((job) => summary(job, candidateState.groups, candidateState.events));
	}

	async #summary(job: EvolutionJob): Promise<EvolutionJobSummary> {
		const summaries = await this.#summaries([job]);
		const result = summaries[0];
		if (result === undefined) throw new Error(`Evolution job "${job.jobId}" summary is unavailable`);
		return result;
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
		const tokenCount = countEvolutionTokens(materializations.map((entry) => entry.invocation));
		const lastAutomaticRunAt =
			jobs
				.filter((job) => !isCancelledJob(job) && job.trigger === "automatic" && job.terminalAt !== null)
				.map((job) => job.terminalAt as string)
				.sort()
				.at(-1) ?? null;
		const lastEvolutionAt =
			jobs
				.filter((job) => job.outcome === "completed" && job.terminalAt !== null)
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
						tokens: tokenCount.totalTokens,
						now: new Date(currentTime).toISOString(),
						previousAutomaticTerminalAt: lastAutomaticRunAt,
					});
		const observedHarnessVersion = this.#dependencies.observedHarnessVersion() ?? null;
		const projectedJobs = await this.#summaries([
			...(active === null ? [] : [active]),
			...(resumable === null ? [] : [resumable]),
		]);
		const projectedById = new Map(projectedJobs.map((job) => [job.jobId, job]));
		return {
			scope: this.#dependencies.scope,
			processedEvidenceCursor: cursor.sequence,
			ingestionHighWaterCursor: highWater,
			unprocessedTokens: tokenCount.totalTokens,
			settledInvocationCount: materializations.length,
			automaticTokenThreshold: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
			automaticMinimumInvocations: AUTOMATIC_EVOLUTION_MINIMUM_INVOCATIONS,
			lastEvolutionAt,
			cooldownRemainingMs,
			automaticEligibility: eligibility,
			activeJob: active === null ? null : (projectedById.get(active.jobId) ?? null),
			newestResumableJob: resumable === null ? null : (projectedById.get(resumable.jobId) ?? null),
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
		const jobs = (await this.#dependencies.jobs.list(this.#dependencies.scope))
			.filter((job) => !isCancelledJob(job))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.jobId.localeCompare(left.jobId));
		return this.#summaries(jobs);
	}

	async #repositoryMatchesCurrentDirectory(repository: EvolutionRepositorySnapshot): Promise<boolean> {
		if (repository.directoryId !== undefined) {
			return repository.directoryId === this.#dependencies.currentDirectory.directoryId;
		}
		if (repository.rootPath === this.#dependencies.currentDirectory.rootPath) return true;
		return this.#dependencies.currentDirectory.containsRevision(repository.revision);
	}

	async #listHarnessVersionInfo(currentDirectoryOnly: boolean): Promise<readonly EvolutionHarnessVersionInfo[]> {
		const [versions, jobs] = await Promise.all([
			this.#dependencies.harnesses.listVersions(),
			this.#dependencies.jobs.list(this.#dependencies.scope),
		]);
		const info = new Map<HarnessVersion, EvolutionHarnessVersionInfo>(
			versions.versions
				.filter((bundle) => !currentDirectoryOnly || bundle.manifest.base === null)
				.map((bundle) => [
					bundle.manifest.version,
					{
						version: bundle.manifest.version,
						kind: bundle.manifest.base === null ? "default" : "evolved",
						evolvedAt: null,
						evolvedIn: null,
					},
				]),
		);
		const activations = await Promise.all(
			jobs.map(async (job) => ({
				job,
				activation: await this.#dependencies.ledger.read(job.jobId).then(harnessActivation),
			})),
		);
		activations.sort(
			(left, right) =>
				(right.job.terminalAt ?? right.job.updatedAt).localeCompare(left.job.terminalAt ?? left.job.updatedAt) ||
				right.job.jobId.localeCompare(left.job.jobId),
		);

		for (const { job, activation } of activations) {
			if (activation === null) continue;
			const existing = info.get(activation.resultingHarnessVersion);
			if (!currentDirectoryOnly && existing !== undefined && existing.evolvedAt !== null) continue;
			const inputArtifact = await this.#dependencies.artifacts.get(job.inputSnapshot).catch(() => null);
			const input = inputArtifact !== null && isInputSnapshot(inputArtifact) ? inputArtifact : null;
			if (input === null) continue;
			if (currentDirectoryOnly && !(await this.#repositoryMatchesCurrentDirectory(input.repository))) continue;
			if (existing !== undefined && existing.evolvedAt !== null) continue;
			info.set(activation.resultingHarnessVersion, {
				version: activation.resultingHarnessVersion,
				kind: "evolved",
				evolvedAt: job.terminalAt ?? job.updatedAt,
				evolvedIn: input.repository.rootPath,
			});
		}

		return [...info.values()];
	}

	listHarnessVersionInfo(): Promise<readonly EvolutionHarnessVersionInfo[]> {
		return this.#listHarnessVersionInfo(false);
	}

	listCurrentDirectoryHarnessVersionInfo(): Promise<readonly EvolutionHarnessVersionInfo[]> {
		return this.#listHarnessVersionInfo(true);
	}

	async #start(trigger: "automatic" | "manual"): Promise<EvolutionStartResult> {
		for (let contentionAttempt = 0; contentionAttempt < 20; contentionAttempt += 1) {
			const result = await this.#dependencies.controlPlane.createJob({ scope: this.#dependencies.scope, trigger });
			if (result.status === "created") return { status: "created", job: await this.#summary(result.job) };
			if (result.reason === "blocking-job" && result.blockingJobId !== undefined) {
				const blocking = await this.#dependencies.jobs.load(result.blockingJobId);
				if (blocking !== null) {
					const blockingSummary = await this.#summary(blocking);
					if (blockingSummary.cancellable || blockingSummary.resumable) {
						return { status: "attached", job: blockingSummary };
					}
					continue;
				}
			}
			if (result.reason !== "scope-busy") return { status: "not-created", reason: result.reason };
			const active = activeJob(await this.#dependencies.jobs.list(this.#dependencies.scope));
			if (active !== null) return { status: "attached", job: await this.#summary(active) };
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		return { status: "not-created", reason: "scope-busy" };
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
		return this.#summary(await this.#dependencies.controlPlane.requestResume(job.jobId));
	}

	async cancelJob(jobId: string): Promise<void> {
		const job = await this.#dependencies.jobs.load(jobId);
		if (
			job === null ||
			job.metadata.scope.repositoryId !== this.#dependencies.scope.repositoryId ||
			job.metadata.scope.scopeId !== this.#dependencies.scope.scopeId
		) {
			throw new Error(`Unknown evolution job "${jobId}"`);
		}
		await this.#dependencies.controlPlane.cancelJob(jobId);
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
		if (
			job === null ||
			isCancelledJob(job) ||
			job.metadata.scope.repositoryId !== this.#dependencies.scope.repositoryId
		) {
			throw new Error(`Unknown evolution job "${jobId}"`);
		}
		const [artifacts, events, versions, candidateState] = await Promise.all([
			loadArtifacts(job, this.#dependencies.artifacts),
			this.#dependencies.ledger.read(jobId),
			this.#dependencies.harnesses.listVersions(),
			this.#candidateState(),
		]);
		const input = artifacts.find(isInputSnapshot);
		if (input === undefined) throw new Error(`Evolution job "${jobId}" has no input snapshot`);
		const scored = artifacts.filter(isScoredProposal);
		const skillCandidates = artifacts.filter(isSkillCandidate);
		const candidateGroups = candidateState.groups;
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
		const proposals = proposalIds.flatMap((proposalId) => {
			const scoredProposal = scored.find((entry) => entry.proposal.proposalId === proposalId)?.proposal;
			if (scoredProposal !== undefined) return [scoredProposal];
			const proposal = artifacts.find(
				(artifact): artifact is EvolutionProposal => "proposalId" in artifact && artifact.proposalId === proposalId,
			);
			return proposal === undefined ? [] : [proposal];
		});
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
		const coverageMaps = artifacts.filter(isCoverageMap);
		const coverageEntries = coverageMaps.flatMap((artifact) => artifact.entries);
		const sliceCoverage =
			coverageMaps.length === 0
				? null
				: {
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
			...summary(job, candidateGroups, candidateState.events),
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
			baseHarnessInfo: {
				version: input.expectedHarnessBaseVersion,
				kind: input.harness.baseVersion === null ? "default" : "evolved",
				evolvedAt: null,
				evolvedIn: null,
			},
			activatedHarnessVersion: activation?.resultingHarnessVersion ?? null,
			nextPromptWillRefresh:
				versions.currentVersion !== null && observed !== null && versions.currentVersion !== observed,
			proposalIds,
			proposals,
			skillCandidates: skillCandidates.map((candidate) =>
				candidateSummary(candidate, candidateGroup(candidateGroups, candidate.candidateId)),
			),
			observability: {
				queueAgeMs,
				stageLatencies,
				evidenceTokens: evidenceTokenTotal(input),
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

	async getSkillCandidate(jobId: string, candidateId: string): Promise<EvolutionSkillCandidateDetail> {
		const job = await this.#dependencies.jobs.load(jobId);
		if (
			job === null ||
			isCancelledJob(job) ||
			job.metadata.scope.repositoryId !== this.#dependencies.scope.repositoryId ||
			job.metadata.scope.scopeId !== this.#dependencies.scope.scopeId
		) {
			throw new Error(`Unknown evolution job "${jobId}"`);
		}
		const [artifacts, groups, versions] = await Promise.all([
			loadArtifacts(job, this.#dependencies.artifacts),
			this.#dependencies.skillCandidates?.list(this.#dependencies.scope) ?? Promise.resolve([]),
			this.#dependencies.harnesses.listVersions(),
		]);
		const candidate = artifacts.filter(isSkillCandidate).find((item) => item.candidateId === candidateId);
		if (candidate === undefined) throw new Error(`Unknown skill candidate "${candidateId}"`);
		const input = artifacts.find(isInputSnapshot);
		if (input === undefined) throw new Error(`Evolution job "${jobId}" has no input snapshot`);
		const group = candidateGroup(groups, candidateId);
		const loadGroupArtifact = async <T extends EvolutionArtifact>(
			reference: { readonly artifactId: string; readonly contentDigest: string } | null | undefined,
			guard: (artifact: EvolutionArtifact) => artifact is T,
		): Promise<T | null> => {
			if (reference === null || reference === undefined) return null;
			const artifact = await this.#dependencies.artifacts.get(reference);
			if (!guard(artifact)) throw new Error(`Skill candidate "${candidateId}" has an invalid review artifact`);
			return artifact;
		};
		const [draft, validation, evaluation] = await Promise.all([
			loadGroupArtifact(group?.draft, isSkillDraft),
			loadGroupArtifact(group?.validation, isSkillValidation),
			loadGroupArtifact(group?.evaluation, isSkillEvaluation),
		]);
		const existingContents = await Promise.all(
			candidate.existingSkillIds.map(async (skillId) => {
				const entry = input.skillCatalog.find((skill) => skill.skillId === skillId);
				if (entry === undefined) throw new Error(`Skill candidate source "${skillId}" is unavailable`);
				const artifact = await this.#dependencies.artifacts.get(entry.contentArtifact);
				if (!isSkillContent(artifact)) throw new Error(`Skill candidate source "${skillId}" is invalid`);
				return {
					skillId,
					name: entry.name,
					version: entry.version,
					content: artifact.skill.content,
				};
			}),
		);
		const harnessState =
			draft === null
				? { active: false, rollbackTarget: null }
				: skillCandidateHarnessState(versions, candidate, draft);
		return {
			summary: candidateSummary(candidate, group),
			candidate,
			supportingEvidence: resolveEvidence(input, candidate.supportingEvidenceIds),
			contradictingEvidence: resolveEvidence(input, candidate.contradictingEvidenceIds),
			sourceEvolutionJobIds: group?.proposalRevisions.map((revision) => revision.sourceEvolutionJobId) ?? [jobId],
			proposalRevisionIds: group?.proposalRevisions.map((revision) => revision.revisionId) ?? [],
			existingContents,
			draft,
			validation,
			evaluation,
			targetHarnessVersion: harnessState.active ? versions.currentVersion : null,
			rollbackTargetHarnessVersion: harnessState.rollbackTarget,
			rollbackAvailable: harnessState.rollbackTarget !== null,
			activationAvailable:
				group?.state === "accepted" && !harnessState.active && this.#dependencies.skillActivation !== undefined,
		};
	}

	async rollbackSkillCandidate(jobId: string, candidateId: string): Promise<EvolutionRollbackAction> {
		const detail = await this.getSkillCandidate(jobId, candidateId);
		if (
			!detail.rollbackAvailable ||
			detail.targetHarnessVersion === null ||
			detail.rollbackTargetHarnessVersion === null
		) {
			throw new Error(`Skill candidate "${candidateId}" has no rollback available`);
		}
		const result = await this.#dependencies.harnesses.selectVersionIfCurrent(
			detail.rollbackTargetHarnessVersion,
			detail.targetHarnessVersion,
		);
		if (result.status === "conflict") {
			throw new Error(
				`Harness revision changed before rollback: expected ${result.expectedCurrent}, found ${result.actualCurrent}`,
			);
		}
		return {
			jobId,
			fromHarnessVersion: detail.targetHarnessVersion,
			toHarnessVersion: detail.rollbackTargetHarnessVersion,
			proposalIds: [candidateId],
		};
	}

	async activateSkillCandidate(jobId: string, candidateId: string): Promise<EvolutionSkillActivationResult> {
		const detail = await this.getSkillCandidate(jobId, candidateId);
		if (
			!detail.activationAvailable ||
			detail.summary.groupId === null ||
			this.#dependencies.skillActivation === undefined
		) {
			throw new Error(`Skill candidate "${candidateId}" is not eligible for activation`);
		}
		return this.#dependencies.skillActivation.activate(this.#dependencies.scope, detail.summary.groupId);
	}

	async getProposal(jobId: string, proposalId: string): Promise<EvolutionProposalDetail> {
		const job = await this.#dependencies.jobs.load(jobId);
		if (job === null || isCancelledJob(job)) throw new Error(`Unknown evolution job "${jobId}"`);
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
		const input = artifacts.find(isInputSnapshot);
		if (input === undefined) throw new Error(`Evolution job "${jobId}" has no input snapshot`);
		const validation = artifacts.find(isValidationReport);
		const activation = harnessActivation(events);
		return {
			proposal,
			supportingEvidence: resolveEvidence(input, proposal.supportingEvidenceIds),
			contradictingEvidence: resolveEvidence(input, proposal.contradictingEvidenceIds),
			score,
			validationDisposition:
				validation?.proposalResults.find((result) => result.proposalId === proposalId)?.disposition ?? null,
			exactAppliedDiff: activation?.proposalIds.includes(proposalId) ? activation.exactDiff : null,
			rollbackTarget: activation?.proposalIds.includes(proposalId) ? activation.rollbackParentHarnessVersion : null,
		};
	}
}
