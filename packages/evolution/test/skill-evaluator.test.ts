import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	DeterministicSkillEvaluator,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionScope,
	type SkillBehaviorEvaluationOutcome,
	type SkillCandidate,
	type SkillCandidateGroup,
	type SkillDraft,
	type SkillDraftValidationReport,
	type SkillEvaluationCase,
	type SkillEvaluationExecutionInput,
	type SkillEvaluationPoolSkill,
	type SkillEvaluationSelectionInput,
	type SkillEvaluationVerifier,
} from "../src/index.ts";

const createdAt = "2026-08-25T12:00:00.000Z";
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const harnessVersion = `sha256:${"2".repeat(64)}`;
const configurationDigest = `sha256:${"3".repeat(64)}`;
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1",
	promptVersion: null,
	model: null,
};
const verifier: SkillEvaluationVerifier = {
	kind: "test",
	name: "fixture-verifier",
	version: "1",
	configurationDigest,
};

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt, content });
}

function reference(artifact: EvolutionArtifact): EvolutionArtifactReference {
	return {
		artifactId: artifact.metadata.artifactId,
		contentDigest: computeEvolutionContentDigest(artifact),
	};
}

function candidate(candidateId: string, lineageId: string, traceId: string): SkillCandidate {
	const content = {
		artifactKind: "skill-candidate" as const,
		candidateId,
		operation: "CREATE" as const,
		workspace: {
			repositoryId: "diffex",
			directoryId: "directory-1",
			rootPath: "/repo",
			repositoryRevision: "revision-1",
			evolutionScope: scope,
		},
		proposedName: "focused-verification",
		existingSkillIds: [],
		sourceLessonIds: [`lesson-${candidateId}`],
		sourceProceduralObservationIds: [],
		supportingEvidenceIds: [`evidence-${candidateId}`],
		contradictingEvidenceIds: [],
		supportingTraceIds: [traceId],
		contradictingTraceIds: [],
		taskLineageIds: [lineageId],
		skillability: {
			classification: "verification-routine" as const,
			rationale: "The evidence describes a repeatable verification routine.",
		},
		trigger: {
			description: "A repository change requires focused verification.",
			positiveExamples: ["Verify a focused repository change."],
			negativeExamples: ["No repository files changed."],
		},
		preconditions: ["A focused test exists."],
		procedure: {
			steps: [{ sequence: 1, action: "Run the focused test.", condition: null }],
			requiredTools: ["shell"],
			environment: ["Repository checkout"],
		},
		failureHandling: [{ signal: "The test fails.", mitigation: "Inspect the failure.", recovery: "Fix and rerun." }],
		applicabilityBoundaries: ["Repositories with focused tests"],
		verificationContract: { checks: ["The test passes."], completionCondition: "The test exits successfully." },
		memoryRelationship: {
			classification: "independent" as const,
			memoryProposalIds: [],
			rationale: "The procedure is independent.",
		},
	};
	return { metadata: metadata(candidateId, content.sourceLessonIds, content), ...content };
}

class MemoryArtifactStore implements EvolutionArtifactStore {
	readonly artifacts = new Map<string, EvolutionArtifact>();

	constructor(artifacts: readonly EvolutionArtifact[]) {
		for (const artifact of artifacts) this.artifacts.set(reference(artifact).contentDigest, artifact);
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		const artifactReference = reference(artifact);
		this.artifacts.set(artifactReference.contentDigest, artifact);
		return artifactReference;
	}

	async get(artifactReference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.artifacts.get(artifactReference.contentDigest);
		if (artifact === undefined) throw new Error("Unknown artifact");
		return artifact;
	}
}

function fixture(
	options: {
		readonly cases?: (candidateSkillId: string, neighborSkillId: string) => readonly SkillEvaluationCase[];
		readonly behavior?: (
			input: SkillEvaluationExecutionInput,
			candidateSkillId: string,
		) => SkillBehaviorEvaluationOutcome;
	} = {},
) {
	const first = candidate("candidate-a", "task-a", "trace-a");
	const second = candidate("candidate-b", "task-b", "trace-b");
	const revisions = [first, second].map((item, index) => ({
		revisionId: `revision-${index + 1}`,
		candidateId: item.candidateId,
		candidate: reference(item),
		sourceEvolutionJobId: `job-${index + 1}`,
		createdAt,
		evidence: {
			supportingEvidenceIds: item.supportingEvidenceIds,
			contradictingEvidenceIds: [],
			supportingTraceIds: item.supportingTraceIds,
			contradictingTraceIds: [],
			supportingTaskLineageIds: item.taskLineageIds,
			contradictingTaskLineageIds: [],
		},
	}));
	const draftContent = {
		artifactKind: "skill-draft" as const,
		draftId: "draft-1",
		groupId: "group-1",
		synthesisIdempotencyKey: "synthesis-1",
		proposalRevisionIds: revisions.map((revision) => revision.revisionId),
		sourceCandidateIds: [first.candidateId, second.candidateId],
		sourceEvidenceIds: [...first.supportingEvidenceIds, ...second.supportingEvidenceIds],
		sourceTraceIds: ["trace-a", "trace-b"],
		sourceSkillVersions: [],
		repositoryInstructionDigests: [],
		operation: "CREATE" as const,
		proposedName: "focused-verification",
		existingSkillIds: [],
		workspace: second.workspace,
		content:
			"---\nname: focused-verification\ndescription: Run focused verification for repository changes.\n---\n\nRun the focused verification procedure.\n",
		files: [],
	};
	const draft: SkillDraft = {
		metadata: metadata(draftContent.draftId, draftContent.sourceCandidateIds, draftContent),
		...draftContent,
	};
	const draftReference = reference(draft);
	const validationContent = {
		artifactKind: "skill-draft-validation" as const,
		validationId: "validation-1",
		groupId: "group-1",
		draft: draftReference,
		validatorVersion: "validator-1",
		assurance: "structure-provenance-scope-and-security-only" as const,
		disposition: "accepted" as const,
		issues: [],
		validatedHarnessVersion: harnessVersion,
		validatedSkillVersions: [],
		canonicalInventory: ["skills/focused-verification/SKILL.md"],
		memoryRelationshipDigest: computeEvolutionContentDigest([]),
	};
	const validation: SkillDraftValidationReport = {
		metadata: metadata(validationContent.validationId, [draft.draftId], validationContent),
		...validationContent,
	};
	const validationReference = reference(validation);
	const group: SkillCandidateGroup = {
		groupId: "group-1",
		profile: {
			workspace: { repositoryId: "diffex", directoryId: "directory-1", evolutionScope: scope },
			existingSkillIds: [],
			skillability: "verification-routine",
			triggerTerms: ["focused", "verification"],
			proceduralIntentTerms: ["focused", "test"],
			applicabilityTerms: ["repository"],
		},
		proposalRevisions: revisions,
		state: "evaluation-pending",
		dispositionHistory: [],
		evidence: {
			supportingEvidenceIds: [...first.supportingEvidenceIds, ...second.supportingEvidenceIds],
			contradictingEvidenceIds: [],
			supportingTraceIds: ["trace-a", "trace-b"],
			contradictingTraceIds: [],
			supportingTaskLineageIds: ["task-a", "task-b"],
			contradictingTaskLineageIds: [],
		},
		priorityScore: null,
		draft: draftReference,
		validation: validationReference,
		evaluation: null,
		synthesisIdempotencyKey: "synthesis-1",
		validationIdempotencyKey: "validation-key-1",
		evaluationIdempotencyKey: "evaluation-key-1",
	};
	const neighbor: SkillEvaluationPoolSkill = {
		skillId: "neighbor-1",
		name: "broad-verification",
		description: "Run broad verification for release changes.",
		source: "catalog",
		version: "1",
		contentDigest: computeEvolutionContentDigest("neighbor"),
		content: "---\nname: broad-verification\ndescription: Run broad verification for release changes.\n---\n",
	};
	const requests: Array<SkillEvaluationSelectionInput | SkillEvaluationExecutionInput> = [];
	const defaultCases = (candidateSkillId: string, neighborSkillId: string): readonly SkillEvaluationCase[] => [
		{
			caseId: "replay-a",
			taskFamily: "focused-change",
			kind: "intended",
			origin: "source-replay",
			taskLineageId: "task-a",
			sourceTraceId: "trace-a",
			prompt: "Replay the original focused verification task.",
			expectedSkillIds: [candidateSkillId],
			confusableSkillIds: [neighborSkillId],
			verifier,
		},
		{
			caseId: "replay-b",
			taskFamily: "focused-change",
			kind: "intended",
			origin: "source-replay",
			taskLineageId: "task-b",
			sourceTraceId: "trace-b",
			prompt: "Replay the second focused verification task.",
			expectedSkillIds: [candidateSkillId],
			confusableSkillIds: [neighborSkillId],
			verifier,
		},
		{
			caseId: "held-out-positive",
			taskFamily: "focused-change",
			kind: "intended",
			origin: "held-out",
			taskLineageId: "held-out-a",
			sourceTraceId: null,
			prompt: "Verify a different focused repository change.",
			expectedSkillIds: [candidateSkillId],
			confusableSkillIds: [neighborSkillId],
			verifier,
		},
		{
			caseId: "held-out-hard-negative",
			taskFamily: "release-change",
			kind: "hard-negative",
			origin: "held-out",
			taskLineageId: "held-out-b",
			sourceTraceId: null,
			prompt: "Verify a release with the broad verification procedure.",
			expectedSkillIds: [neighborSkillId],
			confusableSkillIds: [neighborSkillId],
			verifier,
		},
		{
			caseId: "held-out-unrelated",
			taskFamily: "documentation",
			kind: "unrelated",
			origin: "held-out",
			taskLineageId: "held-out-c",
			sourceTraceId: null,
			prompt: "Rewrite a paragraph without changing code.",
			expectedSkillIds: [],
			confusableSkillIds: [],
			verifier,
		},
	];
	const evaluator = new DeterministicSkillEvaluator({
		version: "1",
		artifacts: new MemoryArtifactStore([first, second, draft, validation]),
		cases: {
			async build(input) {
				return (options.cases ?? defaultCases)(input.candidateSkill.skillId, neighbor.skillId);
			},
		},
		environment: {
			async capture() {
				return {
					workspace: { repositoryId: "diffex", directoryId: "directory-1" },
					harnessVersion,
					skills: [neighbor],
				};
			},
		},
		executor: {
			configuration: {
				model: { provider: "faux", model: "fixture", configurationDigest },
				runtime: { name: "node", version: "24.0.0", configurationDigest },
				retriever: { name: "fixture-retriever", version: "1", configurationDigest },
				executor: { name: "fixture-executor", version: "1", configurationDigest },
			},
			async select(input) {
				requests.push(input);
				return {
					caseId: input.testCase.caseId,
					selectedSkillIds: input.testCase.expectedSkillIds,
					scores: input.testCase.expectedSkillIds.map((skillId) => ({ skillId, score: 1 })),
				};
			},
			async execute(input) {
				requests.push(input);
				const custom = options.behavior?.(input, draft.draftId);
				if (custom !== undefined) return custom;
				const intended = input.testCase.kind === "intended";
				return {
					passed: input.arm === "full-pool" || !intended,
					score: intended ? (input.arm === "full-pool" ? 1 : 0) : 1,
					appliedSkillIds: intended && input.arm === "full-pool" ? [draft.draftId] : [],
					verifier,
					details: { deterministic: true },
				};
			},
		},
	});
	return { evaluator, group, draft, validation, requests };
}

describe("DeterministicSkillEvaluator", () => {
	it("accepts only paired retrieval and behavioral improvement with held-out non-regression", async () => {
		const data = fixture();

		const report = await data.evaluator.evaluate({
			group: data.group,
			draft: data.draft,
			validation: data.validation,
			idempotencyKey: data.group.evaluationIdempotencyKey,
			createdAt,
		});

		expect(report).toMatchObject({
			artifactKind: "skill-evaluation",
			disposition: "accepted",
			harnessVersion,
			configuration: {
				model: { provider: "faux", model: "fixture", configurationDigest },
				runtime: { name: "node", version: "24.0.0", configurationDigest },
			},
			gates: {
				suite: { passed: true, reasonCodes: [] },
				retrieval: { passed: true, reasonCodes: [] },
				behavior: { passed: true, reasonCodes: [] },
			},
			metrics: {
				exactRetrievalAccuracy: 1,
				sourceReplayReproducibility: 1,
				heldOutIntendedImprovement: 1,
				negativeRegressionCount: 0,
				misapplicationCount: 0,
			},
		});
		expect(report.cases).toHaveLength(5);
		expect(report.retrievalResults).toHaveLength(5);
		expect(report.behaviorResults).toHaveLength(5);
		expect(data.requests).toHaveLength(15);
	});

	it("quarantines exact retrieval when downstream intended behavior does not improve", async () => {
		const data = fixture({
			behavior(input, candidateSkillId) {
				const intended = input.testCase.kind === "intended";
				return {
					passed: true,
					score: 1,
					appliedSkillIds: intended && input.arm === "full-pool" ? [candidateSkillId] : [],
					verifier,
					details: { deterministic: true },
				};
			},
		});

		const report = await data.evaluator.evaluate({
			group: data.group,
			draft: data.draft,
			validation: data.validation,
			idempotencyKey: data.group.evaluationIdempotencyKey,
			createdAt,
		});

		expect(report.metrics.exactRetrievalAccuracy).toBe(1);
		expect(report.disposition).toBe("quarantined");
		expect(report.gates.retrieval.passed).toBe(true);
		expect(report.gates.behavior).toEqual({
			passed: false,
			reasonCodes: ["held-out-intended-improvement-missing"],
		});
	});

	it("quarantines negative-case regressions and candidate misapplication", async () => {
		const data = fixture({
			behavior(input, candidateSkillId) {
				if (input.testCase.kind === "hard-negative" && input.arm === "full-pool") {
					return {
						passed: false,
						score: 0,
						appliedSkillIds: [candidateSkillId],
						verifier,
						details: { deterministic: true },
					};
				}
				const intended = input.testCase.kind === "intended";
				return {
					passed: input.arm === "full-pool" || !intended,
					score: intended ? (input.arm === "full-pool" ? 1 : 0) : 1,
					appliedSkillIds: intended && input.arm === "full-pool" ? [candidateSkillId] : [],
					verifier,
					details: { deterministic: true },
				};
			},
		});

		const report = await data.evaluator.evaluate({
			group: data.group,
			draft: data.draft,
			validation: data.validation,
			idempotencyKey: data.group.evaluationIdempotencyKey,
			createdAt,
		});

		expect(report.disposition).toBe("quarantined");
		expect(report.gates.behavior).toEqual({
			passed: false,
			reasonCodes: ["candidate-misapplied", "negative-case-regression"],
		});
		expect(report.metrics).toMatchObject({ negativeRegressionCount: 1, misapplicationCount: 1 });
	});

	it("quarantines suites whose held-out lineage overlaps source evidence without executing cases", async () => {
		const data = fixture({
			cases(candidateSkillId, neighborSkillId) {
				return [
					{
						caseId: "replay-a",
						taskFamily: "focused-change",
						kind: "intended",
						origin: "source-replay",
						taskLineageId: "task-a",
						sourceTraceId: "trace-a",
						prompt: "Replay the original task.",
						expectedSkillIds: [candidateSkillId],
						confusableSkillIds: [neighborSkillId],
						verifier,
					},
					{
						caseId: "replay-b",
						taskFamily: "focused-change",
						kind: "intended",
						origin: "source-replay",
						taskLineageId: "task-b",
						sourceTraceId: "trace-b",
						prompt: "Replay the second original task.",
						expectedSkillIds: [candidateSkillId],
						confusableSkillIds: [neighborSkillId],
						verifier,
					},
					{
						caseId: "held-out-positive",
						taskFamily: "focused-change",
						kind: "intended",
						origin: "held-out",
						taskLineageId: "task-b",
						sourceTraceId: null,
						prompt: "Overlapping held-out task.",
						expectedSkillIds: [candidateSkillId],
						confusableSkillIds: [neighborSkillId],
						verifier,
					},
					{
						caseId: "hard-negative",
						taskFamily: "release",
						kind: "hard-negative",
						origin: "held-out",
						taskLineageId: "held-out-b",
						sourceTraceId: null,
						prompt: "Use the neighboring skill.",
						expectedSkillIds: [neighborSkillId],
						confusableSkillIds: [neighborSkillId],
						verifier,
					},
					{
						caseId: "unrelated",
						taskFamily: "docs",
						kind: "unrelated",
						origin: "held-out",
						taskLineageId: "held-out-c",
						sourceTraceId: null,
						prompt: "Edit prose.",
						expectedSkillIds: [],
						confusableSkillIds: [],
						verifier,
					},
				];
			},
		});

		const report = await data.evaluator.evaluate({
			group: data.group,
			draft: data.draft,
			validation: data.validation,
			idempotencyKey: data.group.evaluationIdempotencyKey,
			createdAt,
		});

		expect(report.disposition).toBe("quarantined");
		expect(report.gates.suite).toEqual({
			passed: false,
			reasonCodes: ["case-lineage-invalid", "held-out-lineage-invalid"],
		});
		expect(report.retrievalResults).toEqual([]);
		expect(report.behaviorResults).toEqual([]);
		expect(data.requests).toEqual([]);
	});
});
