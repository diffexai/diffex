import type {
	CounterAttributionMethod,
	CounterSignal,
	CounterSignalSource,
	EvolutionArtifactProducer,
	EvolutionScope,
	SkillLifecycleIssueKind,
	SkillLifecycleObservation,
	SkillLifecycleOutcomeSummary,
	SkillLifecycleRecommendation,
	SkillLifecycleRecommendationAction,
	SkillLifecycleReport,
	SkillLifecycleSkillVersion,
} from "./contracts.ts";
import { SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION, SKILL_LIFECYCLE_REPORT_SCHEMA_VERSION } from "./contracts.ts";
import type { SkillLifecycleObservationStore } from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HANDOFF = {
	kind: "skill-curator-candidate" as const,
	requiredGates: ["deterministic-validation", "retrieval-evaluation", "behavioral-evaluation"] as const,
};

export interface SkillLifecycleObservationInput {
	readonly scope: EvolutionScope;
	readonly skill: SkillLifecycleSkillVersion;
	readonly relatedSkills?: readonly SkillLifecycleSkillVersion[];
	readonly invocationEvents: SkillLifecycleObservation["invocationEvents"];
	readonly topLevelTaskLineageId: string;
	readonly traceIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly signal: CounterSignal;
	readonly signalSource: CounterSignalSource;
	readonly attributionMethod: CounterAttributionMethod;
	readonly issueKind: SkillLifecycleIssueKind | null;
	readonly status: SkillLifecycleObservation["status"];
	readonly timestamp: string;
	readonly idempotencyKey: string;
}

export interface SkillLifecycleReportInput {
	readonly scope: EvolutionScope;
	readonly activeSkillVersions: readonly SkillLifecycleSkillVersion[];
	readonly createdAt: string;
	readonly idempotencyKey: string;
}

export interface DeterministicSkillLifecycleObserverDependencies {
	readonly version: string;
	readonly policyVersion: string;
	readonly observations: SkillLifecycleObservationStore;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameWorkspace(
	left: SkillLifecycleSkillVersion["workspace"],
	right: SkillLifecycleSkillVersion["workspace"],
): boolean {
	return left.repositoryId === right.repositoryId && left.directoryId === right.directoryId;
}

function skillVersionKey(skill: SkillLifecycleSkillVersion): string {
	return [
		skill.workspace.repositoryId,
		skill.workspace.directoryId ?? "",
		skill.sourceKind,
		skill.skillId,
		skill.version,
		skill.contentDigest,
		skill.harnessRevision,
	].join("\u0000");
}

function sortSkillVersions(skills: readonly SkillLifecycleSkillVersion[]): SkillLifecycleSkillVersion[] {
	return [...skills].sort((left, right) => skillVersionKey(left).localeCompare(skillVersionKey(right)));
}

function assertSkillVersion(skill: SkillLifecycleSkillVersion, scope: EvolutionScope): void {
	if (
		skill.skillId.trim() === "" ||
		skill.version.trim() === "" ||
		!DIGEST_PATTERN.test(skill.contentDigest) ||
		!DIGEST_PATTERN.test(skill.harnessRevision) ||
		(skill.sourceKind !== "evolved" && skill.sourceKind !== "installed") ||
		skill.workspace.repositoryId !== scope.repositoryId ||
		skill.workspace.repositoryId.trim() === ""
	) {
		throw new Error(`Skill lifecycle identity for "${skill.skillId}" is invalid`);
	}
}

function attributionWeight(source: CounterSignalSource, method: CounterAttributionMethod): number {
	if (source === "direct-user" && method === "direct") return 4;
	if (
		method === "deterministic" &&
		(source === "environment" || source === "replay" || source === "test" || source === "tool")
	) {
		return 3;
	}
	if (method === "co-occurrence") return 0.25;
	if (source === "model-self-assessment" || method === "self-assessed") return 1;
	if (method === "inferred") return 0.5;
	return 1;
}

function actionFor(observation: SkillLifecycleObservation): SkillLifecycleRecommendationAction | null {
	if (observation.issueKind === "trigger-mismatch") return "narrow-triggers";
	if (observation.issueKind === "procedure-defect") return "revise-procedure";
	if (observation.issueKind === "duplicate-guidance") return "merge-duplicates";
	if (observation.issueKind === "obsolete-guidance") return "retire-obsolete";
	return observation.signal === "harmful" ? "deactivate-harmful" : null;
}

function operationFor(action: SkillLifecycleRecommendationAction): SkillLifecycleRecommendation["candidateOperation"] {
	if (action === "merge-duplicates") return "MERGE";
	if (action === "deactivate-harmful" || action === "retire-obsolete") return "RETIRE";
	return "UPDATE";
}

function reasonFor(action: SkillLifecycleRecommendationAction): string {
	if (action === "narrow-triggers") return "observed-trigger-mismatch";
	if (action === "revise-procedure") return "observed-procedure-defect";
	if (action === "merge-duplicates") return "observed-duplicate-guidance";
	if (action === "retire-obsolete") return "observed-obsolete-guidance";
	return "observed-harmful-outcome";
}

function emptyWeights(): Record<CounterSignal, number> {
	return { helpful: 0, harmful: 0, neutral: 0, unknown: 0 };
}

export class DeterministicSkillLifecycleObserver {
	readonly #observations: SkillLifecycleObservationStore;
	readonly #policyVersion: string;
	readonly #producer: EvolutionArtifactProducer;

	constructor(dependencies: DeterministicSkillLifecycleObserverDependencies) {
		if (dependencies.version.trim() === "" || dependencies.policyVersion.trim() === "") {
			throw new Error("Skill lifecycle observer and policy versions must be non-empty");
		}
		this.#observations = dependencies.observations;
		this.#policyVersion = dependencies.policyVersion;
		this.#producer = {
			name: "diffex-skill-lifecycle-observer",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
	}

	async record(input: SkillLifecycleObservationInput): Promise<SkillLifecycleObservation> {
		assertSkillVersion(input.skill, input.scope);
		if (
			input.topLevelTaskLineageId.trim() === "" ||
			input.idempotencyKey.trim() === "" ||
			!Number.isFinite(Date.parse(input.timestamp)) ||
			input.invocationEvents.length === 0 ||
			new Set(input.invocationEvents).size !== input.invocationEvents.length ||
			input.traceIds.some((traceId) => traceId.trim() === "") ||
			input.evidenceIds.some((evidenceId) => evidenceId.trim() === "") ||
			(input.attributionMethod === "co-occurrence" && (input.signal !== "unknown" || input.issueKind !== null))
		) {
			throw new Error("Skill lifecycle observation input is invalid");
		}
		const relatedSkills = sortSkillVersions(input.relatedSkills ?? []);
		for (const skill of relatedSkills) {
			assertSkillVersion(skill, input.scope);
			if (skillVersionKey(skill) === skillVersionKey(input.skill)) {
				throw new Error("A skill lifecycle observation cannot relate a skill version to itself");
			}
			if (!sameWorkspace(skill.workspace, input.skill.workspace)) {
				throw new Error("Related skill lifecycle observations must share one workspace");
			}
		}
		if (input.issueKind === "duplicate-guidance" && relatedSkills.length === 0) {
			throw new Error("Duplicate skill guidance requires at least one related skill version");
		}
		const identity = {
			scope: input.scope,
			skill: input.skill,
			topLevelTaskLineageId: input.topLevelTaskLineageId,
			idempotencyKey: input.idempotencyKey,
		};
		const observation: SkillLifecycleObservation = {
			schemaVersion: SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
			observationId: `skill-observation-${computeEvolutionContentDigest(identity).slice("sha256:".length, "sha256:".length + 32)}`,
			scope: input.scope,
			skill: input.skill,
			relatedSkills,
			invocationEvents: uniqueSorted(input.invocationEvents) as SkillLifecycleObservation["invocationEvents"],
			topLevelTaskLineageId: input.topLevelTaskLineageId,
			traceIds: uniqueSorted(input.traceIds),
			evidenceIds: uniqueSorted(input.evidenceIds),
			signal: input.signal,
			signalSource: input.signalSource,
			attributionMethod: input.attributionMethod,
			issueKind: input.issueKind,
			status: input.status,
			policyVersion: this.#policyVersion,
			timestamp: input.timestamp,
			idempotencyKey: input.idempotencyKey,
		};
		await this.#observations.appendSkillLifecycleObservation(observation);
		return observation;
	}

	async report(input: SkillLifecycleReportInput): Promise<SkillLifecycleReport> {
		if (input.idempotencyKey.trim() === "" || !Number.isFinite(Date.parse(input.createdAt))) {
			throw new Error("Skill lifecycle report input is invalid");
		}
		const activeSkillVersions = sortSkillVersions(input.activeSkillVersions);
		const activeByKey = new Map<string, SkillLifecycleSkillVersion>();
		for (const skill of activeSkillVersions) {
			assertSkillVersion(skill, input.scope);
			const key = skillVersionKey(skill);
			if (activeByKey.has(key)) throw new Error(`Duplicate active skill lifecycle identity "${skill.skillId}"`);
			activeByKey.set(key, skill);
		}
		const observations = await this.#observations.listSkillLifecycleObservations(input.scope);
		const current = observations.filter((observation) => activeByKey.has(skillVersionKey(observation.skill)));
		const staleObservationIds = uniqueSorted(
			observations
				.filter((observation) => !activeByKey.has(skillVersionKey(observation.skill)))
				.map((observation) => observation.observationId),
		);
		const summaries: SkillLifecycleOutcomeSummary[] = [];
		for (const skill of activeSkillVersions) {
			const matching = current.filter(
				(observation) => skillVersionKey(observation.skill) === skillVersionKey(skill),
			);
			const final = matching.filter((observation) => observation.status === "final");
			const weightedSignals = emptyWeights();
			for (const observation of final) {
				weightedSignals[observation.signal] += attributionWeight(
					observation.signalSource,
					observation.attributionMethod,
				);
			}
			summaries.push({
				skill,
				finalObservationIds: uniqueSorted(final.map((observation) => observation.observationId)),
				candidateObservationIds: uniqueSorted(
					matching
						.filter((observation) => observation.status === "candidate")
						.map((observation) => observation.observationId),
				),
				topLevelTaskLineageIds: uniqueSorted(final.map((observation) => observation.topLevelTaskLineageId)),
				traceIds: uniqueSorted(final.flatMap((observation) => observation.traceIds)),
				evidenceIds: uniqueSorted(final.flatMap((observation) => observation.evidenceIds)),
				weightedSignals,
			});
		}
		const recommendationGroups = new Map<string, SkillLifecycleObservation[]>();
		for (const observation of current) {
			if (observation.status !== "final" || observation.skill.sourceKind !== "evolved") continue;
			const action = actionFor(observation);
			if (action === null) continue;
			const skillVersions = sortSkillVersions([observation.skill, ...observation.relatedSkills]);
			if (
				action === "merge-duplicates" &&
				skillVersions.some((skill) => skill.sourceKind !== "evolved" || !activeByKey.has(skillVersionKey(skill)))
			) {
				continue;
			}
			const key = `${action}\u0000${skillVersions.map(skillVersionKey).join("\u0001")}`;
			const grouped = recommendationGroups.get(key) ?? [];
			grouped.push(observation);
			recommendationGroups.set(key, grouped);
		}
		const recommendations = [...recommendationGroups.entries()]
			.map(([key, grouped]): SkillLifecycleRecommendation => {
				const first = grouped[0];
				if (first === undefined) throw new Error(`Empty skill lifecycle recommendation group "${key}"`);
				const action = actionFor(first);
				if (action === null) throw new Error("Skill lifecycle recommendation lost its action");
				const skillVersions = sortSkillVersions([first.skill, ...first.relatedSkills]);
				const observationIds = uniqueSorted(grouped.map((observation) => observation.observationId));
				return {
					recommendationId: `skill-lifecycle-recommendation-${computeEvolutionContentDigest({ action, skillVersions, observationIds }).slice("sha256:".length, "sha256:".length + 32)}`,
					action,
					candidateOperation: operationFor(action),
					skillVersions,
					observationIds,
					topLevelTaskLineageIds: uniqueSorted(grouped.map((observation) => observation.topLevelTaskLineageId)),
					traceIds: uniqueSorted(grouped.flatMap((observation) => observation.traceIds)),
					evidenceIds: uniqueSorted(grouped.flatMap((observation) => observation.evidenceIds)),
					evidenceWeight: grouped.reduce(
						(total, observation) =>
							total + attributionWeight(observation.signalSource, observation.attributionMethod),
						0,
					),
					reasonCodes: [reasonFor(action)],
					handoff: HANDOFF,
				};
			})
			.sort(
				(left, right) =>
					right.evidenceWeight - left.evidenceWeight ||
					left.recommendationId.localeCompare(right.recommendationId),
			);
		const content = {
			artifactKind: "skill-lifecycle-report" as const,
			schemaVersion: SKILL_LIFECYCLE_REPORT_SCHEMA_VERSION,
			policyVersion: this.#policyVersion,
			activeSkillVersions,
			summaries,
			recommendations,
			staleObservationIds,
		};
		const artifactId = `skill-lifecycle-report-${computeEvolutionContentDigest({
			idempotencyKey: input.idempotencyKey,
			content,
		}).slice("sha256:".length, "sha256:".length + 32)}`;
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId,
				producer: this.#producer,
				sourceIds: uniqueSorted(observations.map((observation) => observation.observationId)),
				scope: input.scope,
				createdAt: input.createdAt,
				content,
			}),
			...content,
		};
	}
}
