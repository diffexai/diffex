import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	DeterministicSkillLifecycleObserver,
	type EvolutionScope,
	type SkillLifecycleObservation,
	type SkillLifecycleObservationAppendResult,
	type SkillLifecycleObservationInput,
	type SkillLifecycleObservationStore,
	type SkillLifecycleSkillVersion,
} from "../src/index.ts";

const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const digest = (value: string) => computeEvolutionContentDigest(value);

class MemoryObservationStore implements SkillLifecycleObservationStore {
	readonly observations: SkillLifecycleObservation[] = [];

	appendSkillLifecycleObservation(
		observation: SkillLifecycleObservation,
	): Promise<SkillLifecycleObservationAppendResult> {
		const existing = this.observations.find((item) => item.observationId === observation.observationId);
		if (existing !== undefined) return Promise.resolve("already-recorded");
		this.observations.push(observation);
		return Promise.resolve("committed");
	}

	listSkillLifecycleObservations(requestedScope: EvolutionScope): Promise<readonly SkillLifecycleObservation[]> {
		return Promise.resolve(
			this.observations.filter(
				(observation) =>
					observation.scope.repositoryId === requestedScope.repositoryId &&
					observation.scope.scopeId === requestedScope.scopeId,
			),
		);
	}
}

function skill(
	skillId: string,
	version: string,
	sourceKind: SkillLifecycleSkillVersion["sourceKind"] = "evolved",
): SkillLifecycleSkillVersion {
	return {
		skillId,
		version,
		contentDigest: digest(`${skillId}:${version}`),
		sourceKind,
		harnessRevision: digest(`harness:${version}`),
		workspace: { repositoryId: scope.repositoryId, directoryId: "workspace" },
	};
}

function input(
	target: SkillLifecycleSkillVersion,
	overrides: Partial<SkillLifecycleObservationInput> = {},
): SkillLifecycleObservationInput {
	return {
		scope,
		skill: target,
		invocationEvents: ["listed", "read"],
		topLevelTaskLineageId: "task-1",
		traceIds: ["trace-1"],
		evidenceIds: ["evidence-1"],
		signal: "harmful",
		signalSource: "direct-user",
		attributionMethod: "direct",
		issueKind: null,
		status: "final",
		timestamp: "2026-08-29T12:00:00.000Z",
		idempotencyKey: "observation-1",
		...overrides,
	};
}

function observer(store: SkillLifecycleObservationStore): DeterministicSkillLifecycleObserver {
	return new DeterministicSkillLifecycleObserver({
		version: "1.0.0",
		policyVersion: "skill-lifecycle-policy-v1",
		observations: store,
	});
}

describe("deterministic skill lifecycle observer", () => {
	it("attributes outcomes to an exact workspace skill version", async () => {
		const store = new MemoryObservationStore();
		const lifecycle = observer(store);
		const target = skill("skill:review", "v1");

		const recorded = await lifecycle.record(input(target));

		expect(recorded).toMatchObject({
			skill: target,
			invocationEvents: ["listed", "read"],
			topLevelTaskLineageId: "task-1",
			signal: "harmful",
			status: "final",
		});
		expect(recorded).not.toHaveProperty("content");
		expect(recorded).not.toHaveProperty("mutation");
	});

	it("weights direct and deterministic outcomes above self-assessment", async () => {
		const store = new MemoryObservationStore();
		const lifecycle = observer(store);
		const direct = skill("skill:direct", "v1");
		const deterministic = skill("skill:test", "v1");
		const selfAssessed = skill("skill:self", "v1");
		await lifecycle.record(input(direct));
		await lifecycle.record(
			input(deterministic, {
				topLevelTaskLineageId: "task-2",
				traceIds: ["trace-2"],
				evidenceIds: ["evidence-2"],
				signalSource: "test",
				attributionMethod: "deterministic",
				idempotencyKey: "observation-2",
			}),
		);
		await lifecycle.record(
			input(selfAssessed, {
				topLevelTaskLineageId: "task-3",
				traceIds: ["trace-3"],
				evidenceIds: ["evidence-3"],
				signalSource: "model-self-assessment",
				attributionMethod: "self-assessed",
				idempotencyKey: "observation-3",
			}),
		);

		const report = await lifecycle.report({
			scope,
			activeSkillVersions: [selfAssessed, deterministic, direct],
			createdAt: "2026-08-29T12:10:00.000Z",
			idempotencyKey: "report-1",
		});

		expect(report.recommendations.map((recommendation) => recommendation.evidenceWeight)).toEqual([4, 3, 1]);
		expect(report.summaries.map((summary) => summary.weightedSignals.harmful).sort()).toEqual([1, 3, 4]);
		expect(report.recommendations[0]?.handoff).toEqual({
			kind: "skill-curator-candidate",
			requiredGates: ["deterministic-validation", "retrieval-evaluation", "behavioral-evaluation"],
		});
	});

	it("proposes bounded candidate operations without changing active content", async () => {
		const store = new MemoryObservationStore();
		const lifecycle = observer(store);
		const trigger = skill("skill:trigger", "v1");
		const procedure = skill("skill:procedure", "v1");
		const duplicate = skill("skill:duplicate", "v1");
		const related = skill("skill:related", "v2");
		const obsolete = skill("skill:obsolete", "v1");
		const candidateOnly = skill("skill:candidate", "v1");
		const installed = skill("skill:installed", "v1", "installed");
		const priorHarness = { ...trigger, harnessRevision: digest("prior-harness") };
		const oldVersion = skill("skill:trigger", "v0");
		const cases: readonly [SkillLifecycleSkillVersion, Partial<SkillLifecycleObservationInput>][] = [
			[trigger, { issueKind: "trigger-mismatch", idempotencyKey: "trigger" }],
			[procedure, { issueKind: "procedure-defect", idempotencyKey: "procedure" }],
			[duplicate, { issueKind: "duplicate-guidance", relatedSkills: [related], idempotencyKey: "duplicate" }],
			[obsolete, { issueKind: "obsolete-guidance", idempotencyKey: "obsolete" }],
			[candidateOnly, { status: "candidate", idempotencyKey: "candidate" }],
			[installed, { idempotencyKey: "installed" }],
			[
				priorHarness,
				{
					issueKind: "trigger-mismatch",
					topLevelTaskLineageId: "task-from-prior-harness",
					idempotencyKey: "prior-harness",
				},
			],
			[oldVersion, { idempotencyKey: "old-version" }],
		];
		for (const [target, overrides] of cases) {
			await lifecycle.record(input(target, overrides));
		}

		const report = await lifecycle.report({
			scope,
			activeSkillVersions: [trigger, procedure, duplicate, related, obsolete, candidateOnly, installed],
			createdAt: "2026-08-29T12:10:00.000Z",
			idempotencyKey: "report-2",
		});

		expect(
			report.recommendations.map(({ action, candidateOperation }) => [action, candidateOperation]).sort(),
		).toEqual(
			[
				["merge-duplicates", "MERGE"],
				["narrow-triggers", "UPDATE"],
				["retire-obsolete", "RETIRE"],
				["revise-procedure", "UPDATE"],
			].sort(),
		);
		expect(report.staleObservationIds).toHaveLength(1);
		expect(
			report.recommendations.find((recommendation) => recommendation.action === "narrow-triggers"),
		).toMatchObject({ evidenceWeight: 8, skillVersions: [trigger] });
		expect(report.activeSkillVersions).toEqual([
			candidateOnly,
			duplicate,
			obsolete,
			procedure,
			related,
			trigger,
			installed,
		]);
		expect(report).not.toHaveProperty("skillContent");
		expect(report).not.toHaveProperty("writerPayload");
	});

	it("does not treat co-occurrence as a causal outcome", async () => {
		const lifecycle = observer(new MemoryObservationStore());
		const target = skill("skill:available", "v1");

		await expect(
			lifecycle.record(
				input(target, {
					signal: "helpful",
					signalSource: "environment",
					attributionMethod: "co-occurrence",
				}),
			),
		).rejects.toThrow("observation input is invalid");
	});
});
