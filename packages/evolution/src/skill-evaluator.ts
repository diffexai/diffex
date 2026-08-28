import { validateHarnessSkillContent } from "@earendil-works/diffex-harness-state";
import type {
	EvolutionArtifactProducer,
	EvolutionArtifactReference,
	SkillBehaviorEvaluationOutcome,
	SkillBehaviorEvaluationResult,
	SkillCandidate,
	SkillEvaluationCase,
	SkillEvaluationGate,
	SkillEvaluationMetrics,
	SkillEvaluationPoolSkill,
	SkillEvaluationReport,
	SkillRetrievalEvaluationResult,
} from "./contracts.ts";
import { SKILL_EVALUATION_SCHEMA_VERSION } from "./contracts.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	SkillEvaluationCaseSource,
	SkillEvaluationEnvironmentSource,
	SkillEvaluationExecutor,
	SkillEvaluator,
	SkillEvaluatorInput,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

export const SKILL_EVALUATOR_VERSION = "skill-evaluator-v1";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface DeterministicSkillEvaluatorDependencies {
	readonly version: string;
	readonly artifacts: EvolutionArtifactStore;
	readonly cases: SkillEvaluationCaseSource;
	readonly environment: SkillEvaluationEnvironmentSource;
	readonly executor: SkillEvaluationExecutor;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = uniqueSorted(left);
	const normalizedRight = uniqueSorted(right);
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((value, index) => value === normalizedRight[index])
	);
}

function sameReference(left: EvolutionArtifactReference | null, right: EvolutionArtifactReference): boolean {
	return left?.artifactId === right.artifactId && left.contentDigest === right.contentDigest;
}

function contentWithoutMetadata<T extends { readonly metadata: unknown }>(value: T): Omit<T, "metadata"> {
	const { metadata: _metadata, ...content } = value;
	return content;
}

function isSkillCandidate(artifact: EvolutionArtifact): artifact is SkillCandidate {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-candidate";
}

function mean(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function gate(reasonCodes: readonly string[]): SkillEvaluationGate {
	const normalized = uniqueSorted(reasonCodes);
	return { passed: normalized.length === 0, reasonCodes: normalized };
}

function candidateSkill(input: SkillEvaluatorInput): SkillEvaluationPoolSkill {
	const frontmatter = validateHarnessSkillContent(`skills/${input.draft.proposedName}/SKILL.md`, input.draft.content);
	return {
		skillId: input.draft.draftId,
		name: frontmatter.name,
		description: frontmatter.description,
		source: "candidate",
		version: input.draft.metadata.contentDigest,
		contentDigest: computeEvolutionContentDigest(input.draft.content),
		content: input.draft.content,
	};
}

function suiteIssues(
	input: SkillEvaluatorInput,
	testCases: readonly SkillEvaluationCase[],
	skills: readonly SkillEvaluationPoolSkill[],
	candidate: SkillEvaluationPoolSkill,
): string[] {
	const issues: string[] = [];
	const caseIds = new Set<string>();
	const lineages = new Set<string>();
	const poolIds = new Set(skills.map((skill) => skill.skillId));
	const sourceLineages = new Set([
		...input.group.evidence.supportingTaskLineageIds,
		...input.group.evidence.contradictingTaskLineageIds,
	]);
	const sourceFamilies = new Set(
		testCases
			.filter((testCase) => testCase.kind === "intended" && testCase.origin === "source-replay")
			.map((testCase) => testCase.taskFamily),
	);
	const heldOutFamilies = new Set(
		testCases
			.filter((testCase) => testCase.kind === "intended" && testCase.origin === "held-out")
			.map((testCase) => testCase.taskFamily),
	);
	const replayCases = testCases.filter((testCase) => testCase.origin === "source-replay");
	const replayLineages = new Set(replayCases.map((testCase) => testCase.taskLineageId));
	const replayTraceIds = new Set(replayCases.flatMap((testCase) => testCase.sourceTraceId ?? []));

	if (sourceFamilies.size === 0) issues.push("source-replay-cases-missing");
	if (input.group.evidence.supportingTaskLineageIds.some((lineageId) => !replayLineages.has(lineageId))) {
		issues.push("source-replay-lineage-coverage-incomplete");
	}
	if (input.draft.sourceTraceIds.some((traceId) => !replayTraceIds.has(traceId))) {
		issues.push("source-replay-trace-coverage-incomplete");
	}
	if (heldOutFamilies.size === 0) issues.push("held-out-intended-cases-missing");
	if (!testCases.some((testCase) => testCase.kind === "hard-negative" && testCase.origin === "held-out")) {
		issues.push("held-out-hard-negative-cases-missing");
	}
	if (!testCases.some((testCase) => testCase.kind === "unrelated" && testCase.origin === "held-out")) {
		issues.push("held-out-unrelated-cases-missing");
	}
	for (const taskFamily of sourceFamilies) {
		if (!heldOutFamilies.has(taskFamily)) issues.push("supported-task-family-lacks-held-out-case");
	}

	for (const testCase of testCases) {
		if (testCase.caseId.trim() === "" || caseIds.has(testCase.caseId)) issues.push("case-identity-invalid");
		caseIds.add(testCase.caseId);
		if (testCase.taskFamily.trim() === "" || testCase.prompt.trim() === "") issues.push("case-content-invalid");
		if (testCase.taskLineageId.trim() === "" || lineages.has(testCase.taskLineageId)) {
			issues.push("case-lineage-invalid");
		}
		lineages.add(testCase.taskLineageId);
		if (testCase.verifier.name.trim() === "" || testCase.verifier.version.trim() === "") {
			issues.push("deterministic-verifier-invalid");
		}
		if (testCase.origin === "source-replay") {
			if (
				testCase.kind !== "intended" ||
				testCase.sourceTraceId === null ||
				!input.draft.sourceTraceIds.includes(testCase.sourceTraceId) ||
				!input.group.evidence.supportingTaskLineageIds.includes(testCase.taskLineageId)
			) {
				issues.push("source-replay-provenance-invalid");
			}
		} else if (testCase.sourceTraceId !== null || sourceLineages.has(testCase.taskLineageId)) {
			issues.push("held-out-lineage-invalid");
		}
		if (testCase.kind === "intended") {
			if (!testCase.expectedSkillIds.includes(candidate.skillId)) issues.push("intended-expectation-invalid");
		} else if (testCase.expectedSkillIds.includes(candidate.skillId)) {
			issues.push("negative-expectation-invalid");
		}
		if (testCase.kind === "hard-negative" && testCase.confusableSkillIds.length === 0) {
			issues.push("hard-negative-neighbor-missing");
		}
		if (
			testCase.expectedSkillIds.some((skillId) => !poolIds.has(skillId)) ||
			testCase.confusableSkillIds.some((skillId) => skillId === candidate.skillId || !poolIds.has(skillId))
		) {
			issues.push("case-skill-reference-invalid");
		}
	}
	return uniqueSorted(issues);
}

function assertSelectionResult(
	result: SkillRetrievalEvaluationResult,
	testCase: SkillEvaluationCase,
	pool: readonly SkillEvaluationPoolSkill[],
): void {
	const poolIds = new Set(pool.map((skill) => skill.skillId));
	if (
		result.caseId !== testCase.caseId ||
		new Set(result.selectedSkillIds).size !== result.selectedSkillIds.length ||
		result.selectedSkillIds.some((skillId) => !poolIds.has(skillId)) ||
		new Set(result.scores.map((score) => score.skillId)).size !== result.scores.length ||
		result.scores.some(
			(score) => !poolIds.has(score.skillId) || !Number.isFinite(score.score) || score.score < 0 || score.score > 1,
		)
	) {
		throw new Error(`Retrieval result for evaluation case "${testCase.caseId}" is invalid`);
	}
}

function assertBehaviorOutcome(
	outcome: SkillBehaviorEvaluationOutcome,
	testCase: SkillEvaluationCase,
	pool: readonly SkillEvaluationPoolSkill[],
): void {
	const poolIds = new Set(pool.map((skill) => skill.skillId));
	if (
		!Number.isFinite(outcome.score) ||
		outcome.score < 0 ||
		outcome.score > 1 ||
		new Set(outcome.appliedSkillIds).size !== outcome.appliedSkillIds.length ||
		outcome.appliedSkillIds.some((skillId) => !poolIds.has(skillId)) ||
		outcome.verifier.kind !== testCase.verifier.kind ||
		outcome.verifier.name !== testCase.verifier.name ||
		outcome.verifier.version !== testCase.verifier.version ||
		outcome.verifier.configurationDigest !== testCase.verifier.configurationDigest
	) {
		throw new Error(`Behavior result for evaluation case "${testCase.caseId}" is invalid`);
	}
}

function retrievalGate(
	testCases: readonly SkillEvaluationCase[],
	results: readonly SkillRetrievalEvaluationResult[],
	candidateSkillId: string,
): SkillEvaluationGate {
	const reasons: string[] = [];
	for (const result of results) {
		const testCase = testCases.find((candidate) => candidate.caseId === result.caseId);
		if (testCase === undefined) throw new Error(`Unknown retrieval evaluation case "${result.caseId}"`);
		const selectedCandidate = result.selectedSkillIds.includes(candidateSkillId);
		if (testCase.kind === "intended" && !selectedCandidate) reasons.push("intended-case-not-retrieved");
		if (testCase.kind !== "intended" && selectedCandidate) reasons.push("candidate-retrieved-for-negative-case");
	}
	return gate(reasons);
}

function behaviorGate(
	testCases: readonly SkillEvaluationCase[],
	results: readonly SkillBehaviorEvaluationResult[],
	candidateSkillId: string,
): SkillEvaluationGate {
	const reasons: string[] = [];
	const heldOutIntended: SkillBehaviorEvaluationResult[] = [];
	for (const result of results) {
		const testCase = testCases.find((candidate) => candidate.caseId === result.caseId);
		if (testCase === undefined) throw new Error(`Unknown behavior evaluation case "${result.caseId}"`);
		if (testCase.origin === "source-replay" && !result.fullPool.passed) {
			reasons.push("source-replay-not-reproduced");
		}
		if (testCase.origin === "held-out" && testCase.kind === "intended") {
			heldOutIntended.push(result);
			if (result.fullPool.score < result.baseline.score) reasons.push("held-out-intended-regression");
			if (!result.fullPool.appliedSkillIds.includes(candidateSkillId))
				reasons.push("intended-candidate-not-applied");
		}
		if (testCase.kind !== "intended") {
			if (result.fullPool.score < result.baseline.score || (result.baseline.passed && !result.fullPool.passed)) {
				reasons.push("negative-case-regression");
			}
			if (result.fullPool.appliedSkillIds.includes(candidateSkillId)) reasons.push("candidate-misapplied");
		}
	}
	if (
		heldOutIntended.length === 0 ||
		mean(heldOutIntended.map((result) => result.fullPool.score)) <=
			mean(heldOutIntended.map((result) => result.baseline.score))
	) {
		reasons.push("held-out-intended-improvement-missing");
	}
	return gate(reasons);
}

function metrics(
	testCases: readonly SkillEvaluationCase[],
	retrieval: readonly SkillRetrievalEvaluationResult[],
	behavior: readonly SkillBehaviorEvaluationResult[],
	candidateSkillId: string,
): SkillEvaluationMetrics {
	const exactSelections = retrieval.filter((result) => {
		const testCase = testCases.find((candidate) => candidate.caseId === result.caseId);
		return testCase !== undefined && sameValues(result.selectedSkillIds, testCase.expectedSkillIds);
	});
	const sourceReplay = behavior.filter((result) =>
		testCases.some((testCase) => testCase.caseId === result.caseId && testCase.origin === "source-replay"),
	);
	const heldOutIntended = behavior.filter((result) =>
		testCases.some(
			(testCase) =>
				testCase.caseId === result.caseId && testCase.origin === "held-out" && testCase.kind === "intended",
		),
	);
	const negative = behavior.filter((result) =>
		testCases.some((testCase) => testCase.caseId === result.caseId && testCase.kind !== "intended"),
	);
	const baseline = mean(heldOutIntended.map((result) => result.baseline.score));
	const fullPool = mean(heldOutIntended.map((result) => result.fullPool.score));
	return {
		exactRetrievalAccuracy: retrieval.length === 0 ? 0 : exactSelections.length / retrieval.length,
		sourceReplayReproducibility:
			sourceReplay.length === 0
				? 0
				: sourceReplay.filter((result) => result.fullPool.passed).length / sourceReplay.length,
		heldOutIntendedBaselineScore: baseline,
		heldOutIntendedFullPoolScore: fullPool,
		heldOutIntendedImprovement: fullPool - baseline,
		negativeRegressionCount: negative.filter(
			(result) =>
				result.fullPool.score < result.baseline.score || (result.baseline.passed && !result.fullPool.passed),
		).length,
		misapplicationCount: negative.filter((result) => result.fullPool.appliedSkillIds.includes(candidateSkillId))
			.length,
	};
}

export class DeterministicSkillEvaluator implements SkillEvaluator {
	readonly #dependencies: DeterministicSkillEvaluatorDependencies;
	readonly #producer: EvolutionArtifactProducer;

	constructor(dependencies: DeterministicSkillEvaluatorDependencies) {
		this.#dependencies = dependencies;
		this.#producer = {
			name: "diffex-skill-evaluator",
			version: dependencies.version,
			promptVersion: null,
			model: dependencies.executor.configuration.model,
		};
	}

	async evaluate(input: SkillEvaluatorInput): Promise<SkillEvaluationReport> {
		input.signal?.throwIfAborted();
		if (
			input.group.state !== "evaluation-pending" ||
			input.idempotencyKey !== input.group.evaluationIdempotencyKey ||
			!sameReference(input.group.draft, {
				artifactId: input.draft.draftId,
				contentDigest: computeEvolutionContentDigest(input.draft),
			}) ||
			!sameReference(input.group.validation, {
				artifactId: input.validation.validationId,
				contentDigest: computeEvolutionContentDigest(input.validation),
			}) ||
			input.validation.disposition !== "accepted"
		) {
			throw new Error(`Candidate group "${input.group.groupId}" is not ready for evaluation`);
		}
		const candidates: SkillCandidate[] = [];
		for (const revision of input.group.proposalRevisions) {
			const artifact = await this.#dependencies.artifacts.get(revision.candidate);
			if (
				!isSkillCandidate(artifact) ||
				artifact.candidateId !== revision.candidateId ||
				artifact.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(artifact)) ||
				computeEvolutionContentDigest(artifact) !== revision.candidate.contentDigest
			) {
				throw new Error(`Candidate revision "${revision.revisionId}" is invalid during evaluation`);
			}
			candidates.push(artifact);
		}
		const environment = await this.#dependencies.environment.capture(input.group.profile.workspace, input.signal);
		if (
			environment.workspace.repositoryId !== input.group.profile.workspace.repositoryId ||
			environment.workspace.directoryId !== input.group.profile.workspace.directoryId ||
			environment.harnessVersion !== input.validation.validatedHarnessVersion
		) {
			throw new Error("Skill evaluation environment no longer matches deterministic validation");
		}
		const candidate = candidateSkill(input);
		const configuration = this.#dependencies.executor.configuration;
		if (
			configuration.model.provider.trim() === "" ||
			configuration.model.model.trim() === "" ||
			!DIGEST_PATTERN.test(configuration.model.configurationDigest) ||
			[configuration.runtime, configuration.retriever, configuration.executor].some(
				(component) =>
					component.name.trim() === "" ||
					component.version.trim() === "" ||
					!DIGEST_PATTERN.test(component.configurationDigest),
			)
		) {
			throw new Error("Skill evaluation runtime configuration is invalid");
		}
		if (
			new Set(environment.skills.map((skill) => skill.skillId)).size !== environment.skills.length ||
			environment.skills.some(
				(skill) =>
					skill.source !== "catalog" ||
					skill.skillId === candidate.skillId ||
					skill.name.trim() === "" ||
					skill.description.trim() === "",
			)
		) {
			throw new Error("Skill evaluation environment contains an invalid skill pool");
		}
		const testCases = [
			...(await this.#dependencies.cases.build({
				group: input.group,
				draft: input.draft,
				validation: input.validation,
				candidates,
				environment,
				candidateSkill: candidate,
				signal: input.signal,
			})),
		].sort((left, right) => left.caseId.localeCompare(right.caseId));
		const fullPool = [candidate, ...environment.skills];
		const suite = gate(suiteIssues(input, testCases, fullPool, candidate));
		const retrievalResults: SkillRetrievalEvaluationResult[] = [];
		const behaviorResults: SkillBehaviorEvaluationResult[] = [];
		if (suite.passed) {
			for (const testCase of testCases) {
				input.signal?.throwIfAborted();
				const selection = await this.#dependencies.executor.select({
					evaluationIdempotencyKey: input.idempotencyKey,
					harnessVersion: environment.harnessVersion,
					testCase,
					skills: fullPool,
					signal: input.signal,
				});
				assertSelectionResult(selection, testCase, fullPool);
				retrievalResults.push(selection);
				const baseline = await this.#dependencies.executor.execute({
					evaluationIdempotencyKey: input.idempotencyKey,
					harnessVersion: environment.harnessVersion,
					testCase,
					skills: environment.skills,
					arm: "baseline",
					signal: input.signal,
				});
				assertBehaviorOutcome(baseline, testCase, environment.skills);
				const candidateAvailable = await this.#dependencies.executor.execute({
					evaluationIdempotencyKey: input.idempotencyKey,
					harnessVersion: environment.harnessVersion,
					testCase,
					skills: fullPool,
					arm: "full-pool",
					signal: input.signal,
				});
				assertBehaviorOutcome(candidateAvailable, testCase, fullPool);
				behaviorResults.push({ caseId: testCase.caseId, baseline, fullPool: candidateAvailable });
			}
		}
		const retrieval = suite.passed
			? retrievalGate(testCases, retrievalResults, candidate.skillId)
			: gate(["evaluation-suite-invalid"]);
		const behavior = suite.passed
			? behaviorGate(testCases, behaviorResults, candidate.skillId)
			: gate(["evaluation-suite-invalid"]);
		const neighboringSkillIds = new Set(testCases.flatMap((testCase) => testCase.confusableSkillIds));
		const neighboringSkills = environment.skills.filter((skill) => neighboringSkillIds.has(skill.skillId));
		const draftReference = {
			artifactId: input.draft.draftId,
			contentDigest: computeEvolutionContentDigest(input.draft),
		};
		const validationReference = {
			artifactId: input.validation.validationId,
			contentDigest: computeEvolutionContentDigest(input.validation),
		};
		const content = {
			artifactKind: "skill-evaluation" as const,
			schemaVersion: SKILL_EVALUATION_SCHEMA_VERSION,
			evaluationId: `skill-evaluation-${computeEvolutionContentDigest({
				groupId: input.group.groupId,
				idempotencyKey: input.idempotencyKey,
				draftReference,
				validationReference,
				configuration,
				testCases,
				retrievalResults,
				behaviorResults,
			}).slice("sha256:".length, "sha256:".length + 32)}`,
			groupId: input.group.groupId,
			evaluationIdempotencyKey: input.idempotencyKey,
			proposalRevisionIds: input.group.proposalRevisions.map((revision) => revision.revisionId),
			draft: draftReference,
			validation: validationReference,
			evaluatorVersion: SKILL_EVALUATOR_VERSION,
			assurance: "retrieval-and-deterministic-behavior-gates" as const,
			disposition:
				suite.passed && retrieval.passed && behavior.passed ? ("accepted" as const) : ("quarantined" as const),
			harnessVersion: environment.harnessVersion,
			candidateSkill: candidate,
			neighboringSkills,
			configuration,
			cases: testCases,
			retrievalResults,
			behaviorResults,
			metrics: metrics(testCases, retrievalResults, behaviorResults, candidate.skillId),
			gates: { suite, retrieval, behavior },
		};
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId: content.evaluationId,
				producer: this.#producer,
				sourceIds: uniqueSorted([
					input.draft.draftId,
					input.validation.validationId,
					...input.draft.sourceCandidateIds,
					...testCases.map((testCase) => testCase.caseId),
				]),
				scope: input.draft.metadata.scope,
				createdAt: input.createdAt,
				content,
			}),
			...content,
		};
	}
}
