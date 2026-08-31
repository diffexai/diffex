import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	DeterministicSkillDraftValidator,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionInputSnapshot,
	type EvolutionJob,
	type EvolutionJobStore,
	type EvolutionScope,
	type SkillCandidate,
	type SkillCandidateGroup,
	type SkillCandidateGroupCapsule,
	type SkillDraft,
	type SkillDraftValidationEnvironment,
} from "../src/index.ts";
import { synthesisRequestFixture } from "./synthesis-request-fixture.ts";

const createdAt = "2026-08-25T12:00:00.000Z";
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const harnessVersion = `sha256:${"2".repeat(64)}`;
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

function evidence(evidenceId: string, lineageId: string, position: number): MaterializedEvidence {
	return {
		kind: "session_item",
		evidenceId,
		itemType: "message",
		payload: {
			type: "message",
			id: `entry-${position}`,
			message: { role: "assistant", content: evidenceId },
		},
		order: {
			traceSequence: position + 1,
			timestamp: createdAt,
			sessionPosition: position,
			parentSpanId: null,
			causalIdentifiers: [{ name: "diffex.task.lineage.id", value: lineageId }],
			ambiguity: [],
		},
		traceSources: [],
	};
}

function invocation(): MaterializedInvocation {
	return {
		version: 1,
		tracePath: "/private/trace-1.jsonl",
		traceId: "trace-1",
		producer: null,
		integrity: "complete",
		terminationStatus: "completed",
		health: null,
		ordering: {
			criteria: ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"],
			ambiguity: [],
		},
		evidence: [evidence("evidence-a", "task-a", 0), evidence("evidence-b", "task-b", 1)],
		diagnostics: [],
	};
}

function inputSnapshot(): EvolutionInputSnapshot {
	const materialized = invocation();
	const memory = "# Evolution memory\n";
	return {
		metadata: metadata("input-1", ["source-1"], { sourceId: "source-1" }),
		trigger: "manual",
		repository: {
			repositoryId: "diffex",
			directoryId: "directory-1",
			rootPath: "/repo",
			revision: "revision-1",
		},
		harness: {
			harnessVersion,
			baseVersion: `sha256:${"1".repeat(64)}`,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [],
		},
		expectedHarnessBaseVersion: harnessVersion,
		ingestionHighWaterCursor: 1,
		instructions: [
			{
				path: "/repo/AGENTS.md",
				precedence: 0,
				content: "Run focused tests.",
				contentDigest: computeEvolutionContentDigest("Run focused tests."),
			},
			{
				path: "/repo/packages/evolution/AGENTS.md",
				precedence: 1,
				content: "Instructions for source files under packages/evolution only.",
				contentDigest: computeEvolutionContentDigest(
					"Instructions for source files under packages/evolution only.",
				),
			},
		],
		skillCatalog: [
			{
				skillId: "installed:focused-test",
				name: "focused-test",
				description: "Run focused tests.",
				sourceKind: "installed",
				scope: "workspace",
				source: "project-resource",
				version: "version-1",
				contentDigest: `sha256:${"5".repeat(64)}`,
				workspace: { repositoryId: "diffex", directoryId: "directory-1" },
				disableModelInvocation: false,
				contentArtifact: { artifactId: "skill-content-1", contentDigest: `sha256:${"6".repeat(64)}` },
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
		evidenceSources: [
			{
				sourceId: "source-1",
				materializationId: "materialization-1",
				ingestionCursor: 1,
				origin: "product-runtime",
				contentDigest: computeEvolutionContentDigest(materialized),
				invocation: materialized,
			},
		],
	};
}

function candidate(input: EvolutionInputSnapshot): SkillCandidate {
	const content = {
		artifactKind: "skill-candidate" as const,
		candidateId: "candidate-1",
		operation: "UPDATE" as const,
		workspace: {
			repositoryId: input.repository.repositoryId,
			directoryId: input.repository.directoryId,
			rootPath: input.repository.rootPath,
			repositoryRevision: input.repository.revision,
			evolutionScope: input.metadata.scope,
		},
		proposedName: "focused-verification",
		existingSkillIds: ["installed:focused-test"],
		sourceLessonIds: ["lesson-1"],
		provenanceBindings: [
			{
				sourceLessonId: "lesson-1",
				supportingEvidenceIds: ["evidence-a", "evidence-b"],
				contradictingEvidenceIds: [],
				materialFields: [
					"operation",
					"proposedName",
					"existingSkillIds",
					"skillability",
					"trigger.description",
					"trigger.positiveExamples",
					"trigger.negativeExamples",
					"preconditions",
					"procedure.steps",
					"procedure.requiredTools",
					"procedure.environment",
					"failureHandling",
					"applicabilityBoundaries",
					"verificationContract.checks",
					"verificationContract.completionCondition",
					"memoryRelationship",
				] as const,
			},
		],
		supportingEvidenceIds: ["evidence-a", "evidence-b"],
		contradictingEvidenceIds: [],
		supportingTraceIds: ["trace-1"],
		contradictingTraceIds: [],
		taskLineageIds: ["task-a", "task-b"],
		skillability: {
			classification: "verification-routine" as const,
			rationale: "The procedure has deterministic outcomes.",
		},
		trigger: {
			description: "A focused repository change needs verification.",
			positiveExamples: ["A source file changed."],
			negativeExamples: ["No repository files changed."],
		},
		preconditions: ["A focused test command exists."],
		procedure: {
			steps: [
				{
					sequence: 1,
					action: "Run the focused test.",
					condition: "A focused repository change is ready for verification.",
				},
				{ sequence: 2, action: "Record the focused test result.", condition: null },
			],
			requiredTools: ["shell"],
			environment: ["Repository checkout"],
		},
		failureHandling: [
			{
				signal: "The test fails.",
				mitigation: "Inspect the diagnostic.",
				recovery: "Correct the issue and rerun the test.",
			},
		],
		applicabilityBoundaries: ["Repositories with a focused test command."],
		verificationContract: {
			checks: ["The focused test exits successfully."],
			completionCondition: "The focused test passes.",
		},
		memoryRelationship: {
			classification: "independent" as const,
			memoryProposalIds: [],
			rationale: "The workflow is distinct from selected memory guidance.",
		},
		capsuleSize: {
			serialization: "canonical-json-utf8-v1" as const,
			serializedBytes: 1_024,
			estimatedTokens: 256,
			maxSerializedBytes: 65_536,
			maxEstimatedTokens: 16_384,
		},
	};
	return { metadata: metadata(content.candidateId, content.sourceLessonIds, content), ...content };
}

function completedJob(input: EvolutionInputSnapshot): EvolutionJob {
	const inputReference = reference(input);
	const content: Omit<EvolutionJob, "metadata"> = {
		jobId: "job-1",
		inputSnapshot: inputReference,
		trigger: "manual",
		evidenceRange: { afterCursor: 0, throughCursor: 1 },
		stage: "completed",
		outcome: "completed",
		reasonCode: null,
		failureMessage: null,
		completion: { kind: "no-op", resultingHarnessVersion: null, processedEvidenceCursor: 1 },
		resolution: null,
		checkpoints: [
			{
				schemaVersion: 1,
				stage: "skill-curating",
				idempotencyKey: "job-1:skill-curating",
				outputArtifacts: [],
				state: { candidateIds: ["candidate-1"], deferredFindingIds: [], selectedMemoryProposalIds: [] },
				completedAt: createdAt,
			},
		],
		attempt: 1,
		revision: 1,
		createdAt,
		updatedAt: createdAt,
		terminalAt: createdAt,
		retryNotBefore: null,
	};
	return { metadata: metadata(content.jobId, [inputReference.artifactId], content), ...content };
}

class MemoryArtifactStore implements EvolutionArtifactStore {
	readonly artifacts: ReadonlyMap<string, EvolutionArtifact>;

	constructor(artifacts: readonly EvolutionArtifact[]) {
		this.artifacts = new Map(artifacts.map((artifact) => [reference(artifact).contentDigest, artifact]));
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		return reference(artifact);
	}

	async get(artifactReference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.artifacts.get(artifactReference.contentDigest);
		if (artifact === undefined) throw new Error("Unknown artifact");
		return artifact;
	}
}

class MemoryJobStore implements EvolutionJobStore {
	readonly job: EvolutionJob;

	constructor(job: EvolutionJob) {
		this.job = job;
	}

	async create(): Promise<void> {}
	async save(): Promise<void> {}
	async load(jobId: string): Promise<EvolutionJob | null> {
		return jobId === this.job.jobId ? this.job : null;
	}
	async list(): Promise<readonly EvolutionJob[]> {
		return [this.job];
	}
}

const validMarkdown = `---
name: focused-verification
description: Verify focused repository changes with a deterministic test and recovery routine.
---

Use when A focused repository change needs verification.
For example: A source file changed.
Use only for Repositories with a focused test command.
Do not use when No repository files changed.

Precondition: A focused test command exists.
Tool: shell.
Environment: Repository checkout.

Condition: A focused repository change is ready for verification.
1. Run the focused test.
2. Record the focused test result.

Failure signal: The test fails.
Mitigation: Inspect the diagnostic.
Recovery: Correct the issue and rerun the test.

Verify that The focused test exits successfully.
Finish only when The focused test passes.
`;

function fixture(
	options: {
		readonly content?: string;
		readonly environment?: Partial<SkillDraftValidationEnvironment>;
		readonly files?: SkillDraft["files"];
		readonly historicalAdditions?: SkillCandidateGroupCapsule["historicalAdditions"];
	} = {},
) {
	const input = inputSnapshot();
	const sourceCandidate = candidate(input);
	const candidateReference = reference(sourceCandidate);
	const job = completedJob(input);
	const proposalRevision = {
		revisionId: "proposal-revision-1",
		candidateId: sourceCandidate.candidateId,
		candidate: candidateReference,
		sourceEvolutionJobId: job.jobId,
		createdAt,
		evidence: {
			supportingEvidenceIds: sourceCandidate.supportingEvidenceIds,
			contradictingEvidenceIds: [],
			supportingTraceIds: sourceCandidate.supportingTraceIds,
			contradictingTraceIds: [],
			supportingTaskLineageIds: sourceCandidate.taskLineageIds,
			contradictingTaskLineageIds: [],
		},
	};
	const capsuleContent = {
		artifactKind: "skill-candidate-group-capsule" as const,
		capsuleId: "skill-candidate-group-capsule-1",
		groupId: "group-1",
		baseProposalRevisionId: proposalRevision.revisionId,
		proposalRevisionIds: [proposalRevision.revisionId],
		sourceDigests: [candidateReference.contentDigest],
		contract: {
			operation: sourceCandidate.operation,
			proposedName: sourceCandidate.proposedName,
			workspace: sourceCandidate.workspace,
			existingSkillIds: sourceCandidate.existingSkillIds,
			skillability: sourceCandidate.skillability,
			trigger: sourceCandidate.trigger,
			preconditions: sourceCandidate.preconditions,
			procedure: sourceCandidate.procedure,
			failureHandling: sourceCandidate.failureHandling,
			applicabilityBoundaries: sourceCandidate.applicabilityBoundaries,
			verificationContract: sourceCandidate.verificationContract,
			memoryRelationship: sourceCandidate.memoryRelationship,
		},
		historicalAdditions: options.historicalAdditions ?? [],
		support: [],
		conflicts: [],
		evidence: proposalRevision.evidence,
	};
	const capsule: SkillCandidateGroupCapsule = {
		metadata: metadata(capsuleContent.capsuleId, [sourceCandidate.candidateId], capsuleContent),
		...capsuleContent,
	};
	const capsuleReference = reference(capsule);
	const draftContent = {
		artifactKind: "skill-draft" as const,
		draftId: "draft-1",
		groupId: "group-1",
		synthesisIdempotencyKey: "skill-synthesis-1",
		proposalRevisionIds: ["proposal-revision-1"],
		sourceCandidateIds: ["candidate-1"],
		sourceEvidenceIds: ["evidence-a", "evidence-b"],
		sourceTraceIds: ["trace-1"],
		sourceSkillVersions: [
			{
				skillId: "installed:focused-test",
				version: "version-1",
				contentDigest: `sha256:${"5".repeat(64)}`,
			},
		],
		repositoryInstructionDigests: [input.instructions[0]!.contentDigest],
		synthesisRequest: { ...synthesisRequestFixture, capsuleDigest: capsuleReference.contentDigest },
		operation: sourceCandidate.operation,
		proposedName: sourceCandidate.proposedName,
		existingSkillIds: sourceCandidate.existingSkillIds,
		workspace: sourceCandidate.workspace,
		content: options.content ?? validMarkdown,
		files: options.files ?? [],
	};
	const draft: SkillDraft = {
		metadata: metadata(
			draftContent.draftId,
			[
				...draftContent.sourceCandidateIds,
				...draftContent.sourceEvidenceIds,
				...draftContent.sourceTraceIds,
				...draftContent.sourceSkillVersions.map((skill) => skill.skillId),
				...draftContent.repositoryInstructionDigests,
			].sort((left, right) => left.localeCompare(right)),
			draftContent,
		),
		...draftContent,
	};
	const draftReference = reference(draft);
	const group: SkillCandidateGroup = {
		groupId: "group-1",
		canonicalCapsule: capsuleReference,
		profile: {
			workspace: { repositoryId: "diffex", directoryId: "directory-1", evolutionScope: scope },
			existingSkillIds: sourceCandidate.existingSkillIds,
			skillability: "verification-routine",
			triggerTerms: ["focused", "verification"],
			proceduralIntentTerms: ["focused", "test"],
			applicabilityTerms: ["repository"],
		},
		proposalRevisions: [proposalRevision],
		state: "drafted",
		dispositionHistory: [],
		evidence: {
			supportingEvidenceIds: sourceCandidate.supportingEvidenceIds,
			contradictingEvidenceIds: [],
			supportingTraceIds: sourceCandidate.supportingTraceIds,
			contradictingTraceIds: [],
			supportingTaskLineageIds: sourceCandidate.taskLineageIds,
			contradictingTaskLineageIds: [],
		},
		priorityScore: null,
		draft: draftReference,
		validation: null,
		evaluation: null,
		synthesisIdempotencyKey: "skill-synthesis-1",
		validationIdempotencyKey: "skill-validation-1",
		evaluationIdempotencyKey: "skill-evaluation-1",
	};
	const environment: SkillDraftValidationEnvironment = {
		workspace: { repositoryId: "diffex", directoryId: "directory-1" },
		harnessVersion,
		skillVersions: [
			{
				skillId: "installed:focused-test",
				version: "version-1",
				contentDigest: `sha256:${"5".repeat(64)}`,
			},
		],
		...options.environment,
	};
	return {
		draft,
		group,
		validator: new DeterministicSkillDraftValidator({
			version: "validator-v1",
			artifacts: new MemoryArtifactStore([input, sourceCandidate, capsule]),
			jobs: new MemoryJobStore(job),
			environment: { capture: async () => environment },
		}),
	};
}

function historicalAddition(
	field: SkillCandidateGroupCapsule["historicalAdditions"][number]["field"],
	value: SkillCandidateGroupCapsule["historicalAdditions"][number]["value"],
): SkillCandidateGroupCapsule["historicalAdditions"][number] {
	return {
		field,
		value,
		valueDigest: computeEvolutionContentDigest(value),
		supportCount: 1,
		revisionSpans: [{ startIndex: 0, endIndex: 0 }],
	};
}

describe("DeterministicSkillDraftValidator", () => {
	it("accepts a current, closed skill package with declared local references", async () => {
		const data = fixture({
			content: `${validMarkdown}\nSee [the verification script](scripts/verify.sh).\n`,
			files: [{ path: "scripts/verify.sh", content: "#!/bin/sh\nexec npm run test:focused\n" }],
		});
		const report = await data.validator.validate({
			group: data.group,
			draft: data.draft,
			idempotencyKey: "skill-validation-1",
			createdAt,
		});

		expect(report).toMatchObject({
			artifactKind: "skill-draft-validation",
			groupId: "group-1",
			validatorVersion: "validator-v1",
			assurance: "structure-provenance-scope-and-security-only",
			disposition: "accepted",
			issues: [],
			validatedHarnessVersion: harnessVersion,
			canonicalInventory: ["skills/focused-verification/SKILL.md", "skills/focused-verification/scripts/verify.sh"],
		});
	});

	it("rejects a draft that omits unique historical capsule requirements", async () => {
		const data = fixture({
			historicalAdditions: [
				historicalAddition("preconditions", "The legacy verifier is installed."),
				historicalAddition("procedure.requiredTools", "legacy-verifier"),
				historicalAddition("procedure.environment", "Legacy package workspace"),
				historicalAddition("procedure.steps", {
					sequence: 3,
					action: "Archive the legacy verifier output.",
					condition: "The legacy verifier ran.",
				}),
				historicalAddition("failureHandling", {
					signal: "The legacy verifier cannot start.",
					mitigation: "Inspect the legacy verifier installation.",
					recovery: "Install the verifier and rerun it.",
				}),
				historicalAddition("applicabilityBoundaries", "Legacy packages only."),
				historicalAddition("verificationContract.checks", "The archived verifier output is readable."),
			],
		});
		const report = await data.validator.validate({
			group: data.group,
			draft: data.draft,
			idempotencyKey: "skill-validation-1",
			createdAt,
		});

		expect(report.disposition).toBe("rejected");
		expect(report.issues.map((item) => item.code)).toEqual(
			expect.arrayContaining([
				"precondition-missing",
				"tool-dependency-missing",
				"environment-dependency-missing",
				"procedure-action-missing",
				"decision-branch-missing",
				"failure-signal-missing",
				"failure-mitigation-missing",
				"recovery-action-missing",
				"applicability-boundary-missing",
				"acceptance-criterion-missing",
			]),
		);
	});

	it.each([
		{
			name: "sensitive content",
			fixture: () => fixture({ content: `${validMarkdown}\napi_key = abcdefghijklmnopqrstuvwxyz123456\n` }),
			code: "sensitive-data-detected",
		},
		{
			name: "undeclared local references",
			fixture: () => fixture({ content: `${validMarkdown}\nSee [script](scripts/run.sh).\n` }),
			code: "undeclared-reference",
		},
		{
			name: "escaping local references",
			fixture: () => fixture({ content: `${validMarkdown}\nSee [outside](../outside.sh).\n` }),
			code: "local-reference-invalid",
		},
		{
			name: "nested skill entrypoints",
			fixture: () => fixture({ files: [{ path: "references/SKILL.md", content: "ambiguous" }] }),
			code: "skill-file-path-invalid",
		},
		{
			name: "stale harness bases",
			fixture: () => fixture({ environment: { harnessVersion: `sha256:${"9".repeat(64)}` } }),
			code: "harness-base-stale",
		},
		{
			name: "stale source skill versions",
			fixture: () =>
				fixture({
					environment: {
						skillVersions: [
							{
								skillId: "installed:focused-test",
								version: "version-2",
								contentDigest: `sha256:${"7".repeat(64)}`,
							},
						],
					},
				}),
			code: "source-skill-stale",
		},
		{
			name: "omitted candidate boundaries",
			fixture: () =>
				fixture({
					content: validMarkdown.replace("Repositories with a focused test command.", "Other repositories."),
				}),
			code: "applicability-boundary-missing",
		},
		{
			name: "omitted trigger conditions",
			fixture: () =>
				fixture({
					content: validMarkdown.replace("A focused repository change needs verification.", "Use this workflow."),
				}),
			code: "trigger-condition-missing",
		},
		{
			name: "omitted preconditions",
			fixture: () =>
				fixture({ content: validMarkdown.replace("A focused test command exists.", "Prepare the project.") }),
			code: "precondition-missing",
		},
		{
			name: "omitted procedure actions",
			fixture: () => fixture({ content: validMarkdown.replace("Run the focused test.", "Run a check.") }),
			code: "procedure-action-missing",
		},
		{
			name: "changed procedure action order",
			fixture: () =>
				fixture({
					content: validMarkdown.replace(
						"1. Run the focused test.\n2. Record the focused test result.",
						"1. Record the focused test result.\n2. Run the focused test.",
					),
				}),
			code: "procedure-action-order-invalid",
		},
		{
			name: "omitted decision branches",
			fixture: () =>
				fixture({
					content: validMarkdown.replace(
						"A focused repository change is ready for verification.",
						"The project is available.",
					),
				}),
			code: "decision-branch-missing",
		},
		{
			name: "omitted tool dependencies",
			fixture: () => fixture({ content: validMarkdown.replace("Tool: shell.", "Use the available runner.") }),
			code: "tool-dependency-missing",
		},
		{
			name: "omitted environment dependencies",
			fixture: () =>
				fixture({
					content: validMarkdown.replace("Environment: Repository checkout.", "Prepare the environment."),
				}),
			code: "environment-dependency-missing",
		},
		{
			name: "omitted failure signals",
			fixture: () => fixture({ content: validMarkdown.replace("The test fails.", "A problem occurs.") }),
			code: "failure-signal-missing",
		},
		{
			name: "omitted failure mitigations",
			fixture: () => fixture({ content: validMarkdown.replace("Inspect the diagnostic.", "Investigate.") }),
			code: "failure-mitigation-missing",
		},
		{
			name: "omitted recovery actions",
			fixture: () =>
				fixture({ content: validMarkdown.replace("Correct the issue and rerun the test.", "Recover safely.") }),
			code: "recovery-action-missing",
		},
		{
			name: "omitted negative triggers",
			fixture: () => fixture({ content: validMarkdown.replace("No repository files changed.", "Never use this.") }),
			code: "counterexample-missing",
		},
		{
			name: "omitted verification checks",
			fixture: () =>
				fixture({ content: validMarkdown.replace("The focused test exits successfully.", "The check completes.") }),
			code: "acceptance-criterion-missing",
		},
		{
			name: "omitted completion conditions",
			fixture: () => fixture({ content: validMarkdown.replace("The focused test passes.", "Work is done.") }),
			code: "acceptance-criterion-missing",
		},
	] as const)("rejects $name", async ({ fixture: createFixture, code }) => {
		const data = createFixture();
		const report = await data.validator.validate({
			group: data.group,
			draft: data.draft,
			idempotencyKey: "skill-validation-1",
			createdAt,
		});

		expect(report.disposition).toBe("rejected");
		expect(report.issues).toContainEqual(expect.objectContaining({ code }));
	});
});
