import type { EvolutionJob } from "./contracts.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface EvolutionRetentionPolicy {
	readonly completedJobRetentionMs: number;
	readonly resolvedJobRetentionMs: number;
	readonly orphanArtifactRetentionMs: number;
	readonly staleTemporaryFileRetentionMs: number;
	readonly corruptArtifactBehavior: "retain-and-report";
	readonly interruptedJobBehavior: "resume-original-snapshot";
	readonly unresolvedFailureBehavior: "retain-and-block-overlap";
	readonly staleLeaseBehavior: "fenced-takeover";
}

export const DEFAULT_EVOLUTION_RETENTION_POLICY: EvolutionRetentionPolicy = Object.freeze({
	completedJobRetentionMs: 30 * DAY_MS,
	resolvedJobRetentionMs: 30 * DAY_MS,
	orphanArtifactRetentionMs: 7 * DAY_MS,
	staleTemporaryFileRetentionMs: DAY_MS,
	corruptArtifactBehavior: "retain-and-report",
	interruptedJobBehavior: "resume-original-snapshot",
	unresolvedFailureBehavior: "retain-and-block-overlap",
	staleLeaseBehavior: "fenced-takeover",
});

export interface EvolutionRetentionPlan {
	readonly removableJobIds: readonly string[];
	readonly retainedBlockingJobIds: readonly string[];
}

function assertDuration(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative duration`);
}

function elapsedSince(timestamp: string, nowMs: number, description: string): number {
	const value = Date.parse(timestamp);
	if (!Number.isFinite(value)) throw new Error(`${description} must be a valid ISO timestamp`);
	return nowMs - value;
}

export function planEvolutionRetention(
	jobs: readonly EvolutionJob[],
	now: string,
	policy: EvolutionRetentionPolicy = DEFAULT_EVOLUTION_RETENTION_POLICY,
): EvolutionRetentionPlan {
	assertDuration(policy.completedJobRetentionMs, "completedJobRetentionMs");
	assertDuration(policy.resolvedJobRetentionMs, "resolvedJobRetentionMs");
	assertDuration(policy.orphanArtifactRetentionMs, "orphanArtifactRetentionMs");
	assertDuration(policy.staleTemporaryFileRetentionMs, "staleTemporaryFileRetentionMs");
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) throw new Error("Retention planning time must be a valid ISO timestamp");

	const removableJobIds: string[] = [];
	const retainedBlockingJobIds: string[] = [];
	for (const job of jobs) {
		if (job.outcome === "completed" && job.terminalAt !== null) {
			if (
				elapsedSince(job.terminalAt, nowMs, `Job "${job.jobId}" terminal time`) >= policy.completedJobRetentionMs
			) {
				removableJobIds.push(job.jobId);
			}
			continue;
		}
		if (job.resolution !== null) {
			if (
				elapsedSince(job.resolution.resolvedAt, nowMs, `Job "${job.jobId}" resolution time`) >=
				policy.resolvedJobRetentionMs
			) {
				removableJobIds.push(job.jobId);
			}
			continue;
		}
		if (job.outcome !== "superseded") retainedBlockingJobIds.push(job.jobId);
	}
	return {
		removableJobIds: removableJobIds.sort(),
		retainedBlockingJobIds: retainedBlockingJobIds.sort(),
	};
}
