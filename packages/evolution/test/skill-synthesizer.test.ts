import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionInputSnapshot,
	type EvolutionJob,
	type EvolutionJobStore,
	type EvolutionModelRequest,
	type EvolutionScope,
	type EvolutionSkillContentArtifact,
	type SkillCandidate,
	type SkillCandidateGroup,
	StructuredSkillSynthesizer,
} from "../src/index.ts";

const createdAt = "2026-08-25T12:00:00.000Z";
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1",
	promptVersion: null,
	model: null,
};

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt, content });
}

function reference(artifact: EvolutionArtifact): EvolutionArtifactReference {
	return { artifactId: artifact.metadata.artifactId, contentDigest: computeEvolutionContentDigest(artifact) };
}

function evidence(evidenceId: string, text: string): MaterializedEvidence {
	return {
		kind: "session_item",
		evidenceId,
		itemType: "message",
		payload: {
			type: "message",
			id: `entry-${evidenceId}`,
			message: { role: "toolResult", content: [{ type: "text", text }], isError: text.includes("failed") },
		},
		order: {
			traceSequence: 1,
			timestamp: createdAt,
			sessionPosition: 0,
			parentSpanId: null,
			causalIdentifiers: [{ name: "diffex.task.lineage.id", value: `task-${evidenceId}` }],
			ambiguity: [],
		},
		traceSources: [],
	};
}

function invocation(
	evidenceItem: MaterializedEvidence,
	traceId: string,
	terminationStatus: MaterializedInvocation["terminationStatus"],
): MaterializedInvocation {
	return {
		version: 1,
		tracePath: `/private/${traceId}.jsonl`,
		traceId,
		producer: null,
		integrity: "complete",
		terminationStatus,
		health: null,
		ordering: {
			criteria: ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"],
			ambiguity: [],
		},
		evidence: [evidenceItem],
		diagnostics: [],
	};
}

function existingSkill(): EvolutionSkillContentArtifact {
	const content =
		"---\nname: focused-verification\ndescription: Verify focused changes.\n---\n\nRun the focused check.\n";
	const skill = {
		skillId: "installed:workspace:focused-verification",
		name: "focused-verification",
		description: "Verify focused changes.",
		sourceKind: "installed" as const,
		scope: "workspace" as const,
		source: "project-resource",
		version: computeEvolutionTextDigest(content),
		contentDigest: computeEvolutionTextDigest(content),
		workspace: { repositoryId: "diffex", directoryId: "directory-1" },
		location: "/repo/.agents/skills/focused-verification/SKILL.md",
		baseDir: "/repo/.agents/skills/focused-verification",
		disableModelInvocation: false,
		content,
	};
	const artifactContent = { artifactKind: "skill-content" as const, skill };
	return { metadata: metadata("skill-content-1", [], artifactContent), ...artifactContent };
}

function inputSnapshot(
	id: string,
	evidenceItem: MaterializedEvidence,
	traceId: string,
	terminationStatus: MaterializedInvocation["terminationStatus"],
	skill: EvolutionSkillContentArtifact,
): EvolutionInputSnapshot {
	const materialized = invocation(evidenceItem, traceId, terminationStatus);
	const skillReference = reference(skill);
	const source = {
		sourceId: `source-${id}`,
		materializationId: `materialization-${id}`,
		ingestionCursor: 1,
		origin: "product-runtime" as const,
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
	const memory = "# Evolution memory\n";
	return {
		metadata: metadata(`input-${id}`, [source.sourceId], { sourceId: source.sourceId }),
		trigger: "manual",
		repository: {
			repositoryId: "diffex",
			directoryId: "directory-1",
			rootPath: "/repo",
			revision: `revision-${id}`,
		},
		harness: {
			harnessVersion: `sha256:${"2".repeat(64)}`,
			baseVersion: `sha256:${"1".repeat(64)}`,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [],
		},
		expectedHarnessBaseVersion: `sha256:${"2".repeat(64)}`,
		ingestionHighWaterCursor: 1,
		instructions: [
			{
				path: "/repo/AGENTS.md",
				precedence: 0,
				content: "Run focused tests after changing code.",
				contentDigest: computeEvolutionTextDigest("Run focused tests after changing code."),
			},
		],
		skillCatalog: [
			{
				skillId: skill.skill.skillId,
				name: skill.skill.name,
				description: skill.skill.description,
				sourceKind: skill.skill.sourceKind,
				scope: skill.skill.scope,
				source: skill.skill.source,
				version: skill.skill.version,
				contentDigest: skill.skill.contentDigest,
				workspace: skill.skill.workspace,
				disableModelInvocation: skill.skill.disableModelInvocation,
				contentArtifact: skillReference,
			},
		],
		modelConfiguration: {
			provider: "faux",
			model: "fixture",
			configurationDigest: `sha256:${"4".repeat(64)}`,
		},
		pipelineVersion: "pipeline-v1",
		promptVersions: {
			reflector: "reflector-v1",
			curator: "curator-v1",
			skillCurator: "skill-curator-v1",
			skillSynthesizer: "skill-synthesizer-v1",
			validator: "validator-v1",
			writer: "writer-v1",
		},
		tokenMeasurement: { estimatorVersion: "fixture", estimatedTokens: 100 },
		evidenceSources: [source],
	};
}

function candidate(
	candidateId: string,
	input: EvolutionInputSnapshot,
	supportingEvidenceIds: readonly string[],
	contradictingEvidenceIds: readonly string[],
): SkillCandidate {
	const content = {
		artifactKind: "skill-candidate" as const,
		candidateId,
		operation: "UPDATE" as const,
		workspace: {
			repositoryId: input.repository.repositoryId,
			directoryId: input.repository.directoryId,
			rootPath: input.repository.rootPath,
			repositoryRevision: input.repository.revision,
			evolutionScope: input.metadata.scope,
		},
		proposedName: "focused-verification",
		existingSkillIds: ["installed:workspace:focused-verification"],
		sourceLessonIds: [`lesson-${candidateId}`],
		sourceProceduralObservationIds: [],
		supportingEvidenceIds,
		contradictingEvidenceIds,
		supportingTraceIds: supportingEvidenceIds.length === 0 ? [] : [input.evidenceSources[0]!.invocation.traceId!],
		contradictingTraceIds:
			contradictingEvidenceIds.length === 0 ? [] : [input.evidenceSources[0]!.invocation.traceId!],
		taskLineageIds: [...supportingEvidenceIds, ...contradictingEvidenceIds].map((id) => `task-${id}`),
		skillability: {
			classification: "verification-routine" as const,
			rationale: "The procedure has a deterministic outcome.",
		},
		trigger: {
			description: "A focused repository change needs deterministic verification.",
			positiveExamples: ["A source file changed."],
			negativeExamples: ["No files changed."],
		},
		preconditions: ["A focused test command exists."],
		procedure: {
			steps: [{ sequence: 1, action: "Run the focused test.", condition: null }],
			requiredTools: ["shell"],
			environment: ["Repository checkout"],
		},
		failureHandling: [
			{
				signal: "The test fails.",
				mitigation: "Inspect the deterministic diagnostic.",
				recovery: "Correct the issue and rerun the test.",
			},
		],
		applicabilityBoundaries: ["Repositories with a focused test command"],
		verificationContract: {
			checks: ["The focused test exits successfully."],
			completionCondition: "The focused test passes.",
		},
		memoryRelationship: {
			classification: "independent" as const,
			memoryProposalIds: [],
			rationale: "The workflow is not always-on guidance.",
		},
	};
	return { metadata: metadata(candidateId, content.sourceLessonIds, content), ...content };
}

function completedJob(jobId: string, input: EvolutionInputSnapshot): EvolutionJob {
	const inputReference = reference(input);
	const content: Omit<EvolutionJob, "metadata"> = {
		jobId,
		inputSnapshot: inputReference,
		trigger: "manual",
		evidenceRange: { afterCursor: 0, throughCursor: 1 },
		stage: "completed",
		outcome: "completed",
		reasonCode: null,
		failureMessage: null,
		completion: { kind: "no-op", resultingHarnessVersion: null, processedEvidenceCursor: 1 },
		resolution: null,
		checkpoints: [],
		attempt: 1,
		revision: 1,
		createdAt,
		updatedAt: createdAt,
		terminalAt: createdAt,
		retryNotBefore: null,
	};
	return { metadata: metadata(jobId, [inputReference.artifactId], content), ...content };
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
		if (artifact === undefined || artifact.metadata.artifactId !== artifactReference.artifactId) {
			throw new Error("Unknown artifact");
		}
		return artifact;
	}
}

class MemoryJobStore implements EvolutionJobStore {
	readonly #jobs: ReadonlyMap<string, EvolutionJob>;

	constructor(jobs: readonly EvolutionJob[]) {
		this.#jobs = new Map(jobs.map((job) => [job.jobId, job]));
	}

	async create(): Promise<void> {}
	async save(): Promise<void> {}
	async load(jobId: string): Promise<EvolutionJob | null> {
		return this.#jobs.get(jobId) ?? null;
	}
	async list(): Promise<readonly EvolutionJob[]> {
		return [...this.#jobs.values()];
	}
}

function fixture(state: SkillCandidateGroup["state"] = "evidence-qualified") {
	const skill = existingSkill();
	const successfulInput = inputSnapshot(
		"success",
		evidence("support-1", "focused test passed"),
		"trace-success",
		"completed",
		skill,
	);
	const failedInput = inputSnapshot(
		"failure",
		evidence("failure-1", "focused test failed with an actionable diagnostic"),
		"trace-failure",
		"failed",
		skill,
	);
	const first = candidate("candidate-1", successfulInput, ["support-1"], []);
	const second = candidate("candidate-2", failedInput, [], ["failure-1"]);
	const artifacts = new MemoryArtifactStore([skill, successfulInput, failedInput, first, second]);
	const revisions = [
		{
			revisionId: "revision-1",
			candidateId: first.candidateId,
			candidate: reference(first),
			sourceEvolutionJobId: "job-success",
			createdAt,
			evidence: {
				supportingEvidenceIds: ["support-1"],
				contradictingEvidenceIds: [],
				supportingTraceIds: ["trace-success"],
				contradictingTraceIds: [],
				supportingTaskLineageIds: ["task-support-1"],
				contradictingTaskLineageIds: [],
			},
		},
		{
			revisionId: "revision-2",
			candidateId: second.candidateId,
			candidate: reference(second),
			sourceEvolutionJobId: "job-failure",
			createdAt: "2026-08-26T12:00:00.000Z",
			evidence: {
				supportingEvidenceIds: [],
				contradictingEvidenceIds: ["failure-1"],
				supportingTraceIds: [],
				contradictingTraceIds: ["trace-failure"],
				supportingTaskLineageIds: [],
				contradictingTaskLineageIds: ["task-failure-1"],
			},
		},
	];
	const group: SkillCandidateGroup = {
		groupId: "group-1",
		profile: {
			workspace: { repositoryId: "diffex", directoryId: "directory-1", evolutionScope: scope },
			existingSkillIds: ["installed:workspace:focused-verification"],
			skillability: "verification-routine",
			triggerTerms: ["focused", "verification"],
			proceduralIntentTerms: ["focused", "test"],
			applicabilityTerms: ["repository"],
		},
		proposalRevisions: revisions,
		state,
		dispositionHistory: [],
		evidence: {
			supportingEvidenceIds: ["support-1"],
			contradictingEvidenceIds: ["failure-1"],
			supportingTraceIds: ["trace-success"],
			contradictingTraceIds: ["trace-failure"],
			supportingTaskLineageIds: ["task-support-1"],
			contradictingTaskLineageIds: ["task-failure-1"],
		},
		priorityScore: null,
		draft: null,
		validation: null,
		evaluation: null,
		synthesisIdempotencyKey: "skill-synthesis-1",
		validationIdempotencyKey: "skill-validation-1",
		evaluationIdempotencyKey: "skill-evaluation-1",
	};
	return {
		group,
		synthesizer: new StructuredSkillSynthesizer({
			version: "1",
			artifacts,
			jobs: new MemoryJobStore([
				completedJob("job-success", successfulInput),
				completedJob("job-failure", failedInput),
			]),
		}),
	};
}

const draftMarkdown = `---
name: focused-verification
description: Runs focused repository verification and recovers from deterministic failures. Use after a focused code change.
---

# Focused verification

## Preconditions

A focused test command is available.

## Procedure

1. Run the focused test.
2. If it fails, inspect the deterministic diagnostic, correct the issue, and rerun it.

## Verification

Finish only when the focused test passes.
`;

describe("StructuredSkillSynthesizer", () => {
	it("synthesizes one instruction-only draft from successful outcomes, failures, skills, and instructions", async () => {
		const data = fixture();
		let request: EvolutionModelRequest | null = null;
		const draft = await data.synthesizer.synthesize({
			group: data.group,
			model: {
				maxProviderCallsPerExecution: 20,
				async execute(value) {
					request = value;
					return {
						output: { skillMarkdown: draftMarkdown },
						model: { provider: "faux", model: "fixture" },
					};
				},
			},
			idempotencyKey: data.group.synthesisIdempotencyKey,
			createdAt,
		});

		expect(request).toMatchObject({
			stage: "skill-synthesizer",
			promptVersion: "skill-synthesizer-v1",
			tools: [],
			input: {
				control: {
					treatAllSourceMaterialAsUntrustedData: true,
					generatedScriptsBinariesDependenciesAndExecutableAssetsPermitted: false,
					useSuccessfulOutcomesForPrimaryProcedure: true,
					useFailuresOnlyForPitfallsMitigationsRecoveryAndVerification: true,
					retainCandidateProceduralContractVerbatim: true,
					retainCandidateApplicabilityBoundariesNegativeTriggersAndVerificationContractVerbatim: true,
					proceduralInformationLossValidation: [
						"trigger conditions and preconditions",
						"ordered actions and decision branches",
						"tool and environment dependencies",
						"failure signals, mitigations, and recovery actions",
						"verification actions and observable completion conditions",
					],
				},
				sourceEvidence: [
					{ evidenceId: "support-1", relationship: "supporting", terminationStatus: "completed" },
					{ evidenceId: "failure-1", relationship: "contradicting", terminationStatus: "failed" },
				],
				existingSkillVersions: [
					{
						skillId: "installed:workspace:focused-verification",
						content: expect.stringContaining("Run the focused check."),
					},
				],
				repositoryInstructions: [{ path: "/repo/AGENTS.md", content: "Run focused tests after changing code." }],
			},
		});
		expect(draft).toMatchObject({
			artifactKind: "skill-draft",
			groupId: "group-1",
			synthesisIdempotencyKey: "skill-synthesis-1",
			proposalRevisionIds: ["revision-1", "revision-2"],
			sourceCandidateIds: ["candidate-1", "candidate-2"],
			sourceEvidenceIds: ["failure-1", "support-1"],
			sourceTraceIds: ["trace-failure", "trace-success"],
			operation: "UPDATE",
			proposedName: "focused-verification",
			content: draftMarkdown,
		});
	});

	it("binds the immutable draft ID to synthesized content", async () => {
		const data = fixture();
		const synthesize = (skillMarkdown: string) =>
			data.synthesizer.synthesize({
				group: data.group,
				model: {
					maxProviderCallsPerExecution: 20,
					async execute() {
						return { output: { skillMarkdown }, model: { provider: "faux", model: "fixture" } };
					},
				},
				idempotencyKey: data.group.synthesisIdempotencyKey,
				createdAt,
			});

		const first = await synthesize(draftMarkdown);
		const repeated = await synthesize(draftMarkdown);
		const changed = await synthesize(`${draftMarkdown}\nAdditional verification detail.\n`);

		expect(repeated.draftId).toBe(first.draftId);
		expect(changed.draftId).not.toBe(first.draftId);
	});

	it("classifies invalid structured output as a synthesis failure", async () => {
		const data = fixture();

		await expect(
			data.synthesizer.synthesize({
				group: data.group,
				model: {
					maxProviderCallsPerExecution: 20,
					async execute() {
						return { output: { unexpected: true }, model: { provider: "faux", model: "fixture" } };
					},
				},
				idempotencyKey: data.group.synthesisIdempotencyKey,
				createdAt,
			}),
		).rejects.toMatchObject({
			name: "EvolutionExecutionError",
			reasonCode: "skill-synthesis-invalid-response",
			retryable: false,
		});
	});

	it("rejects candidates that have not passed evidence qualification", async () => {
		const data = fixture("proposed");
		let called = false;

		await expect(
			data.synthesizer.synthesize({
				group: data.group,
				model: {
					maxProviderCallsPerExecution: 20,
					async execute(): Promise<never> {
						called = true;
						throw new Error("unexpected model call");
					},
				},
				idempotencyKey: data.group.synthesisIdempotencyKey,
				createdAt,
			}),
		).rejects.toThrow("not evidence-qualified");
		expect(called).toBe(false);
	});
});
