import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeHarnessSkillId,
	HarnessStateStore,
	type HarnessWorkspaceIdentity,
} from "../../harness-state/src/index.ts";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionScope,
	FileEvolutionPersistence,
	type SkillCandidateGroup,
	type SkillCandidateOperation,
	type SkillCandidateRegistry,
	type SkillDraft,
	type SkillDraftValidationReport,
	type SkillEvaluationReport,
	SkillWriter,
} from "../src/index.ts";

const now = "2026-08-29T12:00:00.000Z";
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const workspace: HarnessWorkspaceIdentity = { repositoryId: "diffex", directoryId: "directory-1" };
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1",
	promptVersion: null,
	model: null,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function skillContent(name: string, marker = name): string {
	return `---\nname: ${name}\ndescription: Use ${name} for ${marker} tasks.\n---\n\n# ${name}\n\nApply ${marker}.\n`;
}

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt: now, content });
}

function reference(artifact: EvolutionArtifact): EvolutionArtifactReference {
	return { artifactId: artifact.metadata.artifactId, contentDigest: computeEvolutionContentDigest(artifact) };
}

class MemoryArtifactStore implements EvolutionArtifactStore {
	readonly #artifacts = new Map<string, EvolutionArtifact>();

	constructor(artifacts: readonly EvolutionArtifact[]) {
		for (const artifact of artifacts) this.#artifacts.set(reference(artifact).contentDigest, artifact);
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		const artifactReference = reference(artifact);
		this.#artifacts.set(artifactReference.contentDigest, artifact);
		return artifactReference;
	}

	async get(artifactReference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.#artifacts.get(artifactReference.contentDigest);
		if (artifact === undefined) throw new Error("Unknown fixture artifact");
		return artifact;
	}
}

function registry(groups: readonly SkillCandidateGroup[]): SkillCandidateRegistry {
	const unsupported = () => Promise.reject(new Error("Unsupported fixture registry mutation"));
	return {
		list: async () => groups,
		consolidate: unsupported,
		recordDraft: unsupported,
		recordValidation: unsupported,
		startEvaluation: unsupported,
		recordEvaluation: unsupported,
	};
}

interface WriterFixtureOptions {
	readonly operation: SkillCandidateOperation;
	readonly existingNames?: readonly string[];
	readonly existingSkillIdsOverride?: readonly string[];
	readonly retainedNames?: readonly string[];
	readonly proposedName: string;
}

async function writerFixture(options: WriterFixtureOptions) {
	const root = await mkdtemp(join(tmpdir(), "diffex-skill-writer-"));
	temporaryDirectories.push(root);
	const harnessState = new HarnessStateStore(join(root, "agent"));
	const empty = await harnessState.initialize();
	const existingNames = options.existingNames ?? [];
	const retainedNames = options.retainedNames ?? [];
	const initialSkills = [...existingNames, ...retainedNames].map((name) => ({
		path: `skills/${name}/SKILL.md`,
		content: skillContent(name, `${name}-original`),
		workspace,
	}));
	const advanced = await harnessState.advance(
		{ memory: "Preserve exact harness memory.\n", skills: initialSkills },
		empty.manifest.version,
	);
	if (advanced.status !== "advanced") throw new Error("Expected fixture harness advance");
	const base = advanced.bundle;
	const existingSkills = base.state.skills.filter((skill) => existingNames.includes(skill.name));
	const existingSkillIds =
		options.existingSkillIdsOverride ??
		existingSkills.map((skill) => computeHarnessSkillId(skill.workspace, skill.path));
	const draftContent = skillContent(options.proposedName, `${options.proposedName}-evolved`);
	const draftBody = {
		artifactKind: "skill-draft" as const,
		draftId: "draft-1",
		groupId: "group-1",
		synthesisIdempotencyKey: "synthesis-1",
		proposalRevisionIds: ["revision-1"],
		sourceCandidateIds: ["candidate-1"],
		sourceEvidenceIds: ["evidence-1"],
		sourceTraceIds: ["trace-1"],
		sourceSkillVersions: existingSkillIds.map((skillId, index) => ({
			skillId,
			version: existingSkills[index]?.contentHash ?? `sha256:${"9".repeat(64)}`,
			contentDigest: existingSkills[index]?.contentHash ?? `sha256:${"9".repeat(64)}`,
		})),
		repositoryInstructionDigests: [],
		operation: options.operation,
		proposedName: options.proposedName,
		existingSkillIds,
		workspace: {
			repositoryId: workspace.repositoryId,
			directoryId: workspace.directoryId,
			rootPath: "/repo",
			repositoryRevision: "revision-1",
			evolutionScope: scope,
		},
		content: draftContent,
	};
	const draft: SkillDraft = {
		metadata: metadata(draftBody.draftId, draftBody.sourceCandidateIds, draftBody),
		...draftBody,
	};
	const draftReference = reference(draft);
	const validationBody = {
		artifactKind: "skill-draft-validation" as const,
		validationId: "validation-1",
		groupId: draft.groupId,
		draft: draftReference,
		validatorVersion: "validator-1",
		assurance: "structure-provenance-scope-and-security-only" as const,
		disposition: "accepted" as const,
		issues: [],
		validatedHarnessVersion: base.manifest.version,
		validatedSkillVersions: draft.sourceSkillVersions.map(
			(skill) => `${skill.skillId}\u0000${skill.version}\u0000${skill.contentDigest}`,
		),
		canonicalInventory: [`skills/${options.proposedName}/SKILL.md`],
		memoryRelationshipDigest: computeEvolutionContentDigest([]),
	};
	const validation: SkillDraftValidationReport = {
		metadata: metadata(validationBody.validationId, [draft.draftId], validationBody),
		...validationBody,
	};
	const validationReference = reference(validation);
	const evaluationBody = {
		artifactKind: "skill-evaluation" as const,
		schemaVersion: 1 as const,
		evaluationId: "evaluation-1",
		groupId: draft.groupId,
		evaluationIdempotencyKey: "evaluation-1",
		proposalRevisionIds: draft.proposalRevisionIds,
		draft: draftReference,
		validation: validationReference,
		evaluatorVersion: "evaluator-1",
		assurance: "retrieval-and-deterministic-behavior-gates" as const,
		disposition: "accepted" as const,
		harnessVersion: base.manifest.version,
		candidateSkill: {
			skillId: draft.draftId,
			name: draft.proposedName,
			description: `Use ${draft.proposedName} for ${draft.proposedName}-evolved tasks.`,
			source: "candidate" as const,
			version: draft.metadata.contentDigest,
			contentDigest: computeEvolutionContentDigest(draft.content),
			content: draft.content,
		},
		neighboringSkills: [],
		configuration: {
			model: { provider: "faux", model: "fixture", configurationDigest: `sha256:${"1".repeat(64)}` },
			runtime: { name: "node", version: "24", configurationDigest: `sha256:${"2".repeat(64)}` },
			retriever: { name: "fixture", version: "1", configurationDigest: `sha256:${"3".repeat(64)}` },
			executor: { name: "fixture", version: "1", configurationDigest: `sha256:${"4".repeat(64)}` },
		},
		cases: [],
		retrievalResults: [],
		behaviorResults: [],
		metrics: {
			exactRetrievalAccuracy: 1,
			sourceReplayReproducibility: 1,
			heldOutIntendedBaselineScore: 0,
			heldOutIntendedFullPoolScore: 1,
			heldOutIntendedImprovement: 1,
			negativeRegressionCount: 0,
			misapplicationCount: 0,
		},
		gates: {
			suite: { passed: true, reasonCodes: [] },
			retrieval: { passed: true, reasonCodes: [] },
			behavior: { passed: true, reasonCodes: [] },
		},
	};
	const evaluation: SkillEvaluationReport = {
		metadata: metadata(evaluationBody.evaluationId, [draft.draftId, validation.validationId], evaluationBody),
		...evaluationBody,
	};
	const group: SkillCandidateGroup = {
		groupId: draft.groupId,
		profile: {
			workspace: { repositoryId: workspace.repositoryId, directoryId: workspace.directoryId, evolutionScope: scope },
			existingSkillIds,
			skillability: "ordered-workflow",
			triggerTerms: ["fixture"],
			proceduralIntentTerms: ["fixture"],
			applicabilityTerms: ["repository"],
		},
		proposalRevisions: [
			{
				revisionId: "revision-1",
				candidateId: "candidate-1",
				candidate: { artifactId: "candidate-1", contentDigest: `sha256:${"5".repeat(64)}` },
				sourceEvolutionJobId: "job-1",
				createdAt: now,
				evidence: {
					supportingEvidenceIds: ["evidence-1"],
					contradictingEvidenceIds: [],
					supportingTraceIds: ["trace-1"],
					contradictingTraceIds: [],
					supportingTaskLineageIds: ["task-1", "task-2"],
					contradictingTaskLineageIds: [],
				},
			},
		],
		state: "accepted",
		dispositionHistory: [],
		evidence: {
			supportingEvidenceIds: ["evidence-1"],
			contradictingEvidenceIds: [],
			supportingTraceIds: ["trace-1"],
			contradictingTraceIds: [],
			supportingTaskLineageIds: ["task-1", "task-2"],
			contradictingTaskLineageIds: [],
		},
		priorityScore: null,
		draft: draftReference,
		validation: validationReference,
		evaluation: reference(evaluation),
		synthesisIdempotencyKey: draft.synthesisIdempotencyKey,
		validationIdempotencyKey: "validation-1",
		evaluationIdempotencyKey: evaluation.evaluationIdempotencyKey,
	};
	const groups = [group];
	const persistence = new FileEvolutionPersistence(join(root, "evolution"));
	const lease = await persistence.acquire("writer", "global", "writer-1", new Date().toISOString(), 60_000);
	if (lease === null) throw new Error("Expected writer lease");
	const writer = new SkillWriter({
		version: "writer-1",
		workspace,
		harnessState,
		artifacts: new MemoryArtifactStore([draft, validation, evaluation]),
		registry: registry(groups),
		leases: persistence,
		clock: { now: () => now },
		statePath: join(root, "writer-state"),
	});
	return { base, draft, group, groups, harnessState, lease, persistence, root, writer };
}

describe("skill writer", () => {
	it.each([
		{
			operation: "CREATE" as const,
			existingNames: [],
			retainedNames: ["retained"],
			proposedName: "created-skill",
			expectedNames: ["created-skill", "retained"],
		},
		{
			operation: "UPDATE" as const,
			existingNames: ["old-skill"],
			retainedNames: ["retained"],
			proposedName: "updated-skill",
			expectedNames: ["retained", "updated-skill"],
		},
		{
			operation: "MERGE" as const,
			existingNames: ["first-skill", "second-skill"],
			retainedNames: ["retained"],
			proposedName: "merged-skill",
			expectedNames: ["merged-skill", "retained"],
		},
		{
			operation: "RETIRE" as const,
			existingNames: ["retired-skill"],
			retainedNames: ["retained"],
			proposedName: "retired-skill",
			expectedNames: ["retained"],
		},
	])("stages and atomically activates an accepted $operation mutation", async (testCase) => {
		const data = await writerFixture(testCase);
		const batch = await data.writer.buildMutationBatch({ scope, groupId: data.group.groupId, createdAt: now });
		const writeReceipt = await data.writer.write(batch, { idempotencyKey: "write-1", lease: data.lease });

		expect((await data.harnessState.loadCurrent()).manifest.version).toBe(data.base.manifest.version);
		expect(writeReceipt.result).toMatchObject({
			status: "written",
			output: { expectedBaseVersion: data.base.manifest.version },
		});

		const activation = await data.writer.activate(batch, writeReceipt, {
			idempotencyKey: "activate-1",
			lease: data.lease,
		});
		const current = await data.harnessState.loadCurrent();
		expect(activation.result.status).toBe("activated");
		expect(current.manifest.version).toBe(activation.result.resultingHarnessVersion);
		expect(current.manifest.base).toBe(data.base.manifest.version);
		expect(current.state.memory).toBe(data.base.state.memory);
		expect(current.state.skills.map((skill) => skill.name).sort()).toEqual([...testCase.expectedNames].sort());
	});

	it("makes write and activation retries idempotent and preserves exact rollback lineage", async () => {
		const data = await writerFixture({
			operation: "CREATE",
			retainedNames: ["retained"],
			proposedName: "created-skill",
		});
		const batch = await data.writer.buildMutationBatch({ scope, groupId: data.group.groupId, createdAt: now });
		const firstWrite = await data.writer.write(batch, { idempotencyKey: "write-1", lease: data.lease });
		const secondWrite = await data.writer.write(batch, { idempotencyKey: "write-1", lease: data.lease });
		expect(secondWrite).toEqual(firstWrite);

		const firstActivation = await data.writer.activate(batch, firstWrite, {
			idempotencyKey: "activate-1",
			lease: data.lease,
		});
		const secondActivation = await data.writer.activate(batch, secondWrite, {
			idempotencyKey: "activate-1",
			lease: data.lease,
		});
		expect(secondActivation).toEqual(firstActivation);
		const activated = await data.harnessState.loadCurrent();
		const rollback = await data.harnessState.selectVersionIfCurrent(
			data.base.manifest.version,
			activated.manifest.version,
		);
		expect(rollback).toEqual({ status: "selected", bundle: data.base });
		expect(await data.harnessState.loadCurrent()).toEqual(data.base);
	});

	it("rejects non-harness targets, stale digests, and target name collisions", async () => {
		const installed = await writerFixture({
			operation: "UPDATE",
			existingSkillIdsOverride: ["installed:workspace:external-skill"],
			proposedName: "updated-skill",
		});
		await expect(
			installed.writer.buildMutationBatch({ scope, groupId: installed.group.groupId, createdAt: now }),
		).rejects.toThrow("is not an evolved skill in the frozen harness base");

		const staleDigest = await writerFixture({
			operation: "UPDATE",
			existingNames: ["old-skill"],
			proposedName: "updated-skill",
		});
		const validBatch = await staleDigest.writer.buildMutationBatch({
			scope,
			groupId: staleDigest.group.groupId,
			createdAt: now,
		});
		const validMutation = validBatch.mutations[0];
		if (validMutation === undefined) throw new Error("Expected skill mutation");
		const changedMutation = {
			...validMutation,
			existingSkills: validMutation.existingSkills.map((skill) => ({
				...skill,
				contentDigest: `sha256:${"f".repeat(64)}`,
			})),
		};
		const changedContent = {
			batchId: validBatch.batchId,
			targetKind: validBatch.targetKind,
			expectedBaseVersion: validBatch.expectedBaseVersion,
			workspace: validBatch.workspace,
			mutations: [changedMutation],
		};
		const changedBatch = {
			metadata: metadata(validBatch.batchId, validBatch.metadata.sourceIds, changedContent),
			...changedContent,
		};
		await expect(
			staleDigest.writer.write(changedBatch, { idempotencyKey: "write-1", lease: staleDigest.lease }),
		).rejects.toThrow("does not match its accepted candidate");
		expect(await staleDigest.harnessState.loadCurrent()).toEqual(staleDigest.base);

		const collision = await writerFixture({
			operation: "UPDATE",
			existingNames: ["old-skill"],
			retainedNames: ["retained"],
			proposedName: "retained",
		});
		const collisionBatch = await collision.writer.buildMutationBatch({
			scope,
			groupId: collision.group.groupId,
			createdAt: now,
		});
		await expect(
			collision.writer.write(collisionBatch, { idempotencyKey: "write-1", lease: collision.lease }),
		).rejects.toThrow('target "skills/retained/SKILL.md" already exists');
		expect(await collision.harnessState.loadCurrent()).toEqual(collision.base);
	});

	it("rejects stale writer leases before selecting the staged harness", async () => {
		const data = await writerFixture({ operation: "CREATE", proposedName: "created-skill" });
		const batch = await data.writer.buildMutationBatch({ scope, groupId: data.group.groupId, createdAt: now });
		const receipt = await data.writer.write(batch, { idempotencyKey: "write-1", lease: data.lease });
		await data.persistence.release(data.lease);

		await expect(
			data.writer.activate(batch, receipt, { idempotencyKey: "activate-1", lease: data.lease }),
		).rejects.toThrow("lease was lost");
		expect(await data.harnessState.loadCurrent()).toEqual(data.base);
	});

	it("rechecks accepted candidate state immediately before activation", async () => {
		const data = await writerFixture({ operation: "CREATE", proposedName: "created-skill" });
		const batch = await data.writer.buildMutationBatch({ scope, groupId: data.group.groupId, createdAt: now });
		const receipt = await data.writer.write(batch, { idempotencyKey: "write-1", lease: data.lease });
		data.groups[0] = { ...data.group, state: "evidence-qualified", draft: null, validation: null, evaluation: null };

		await expect(
			data.writer.activate(batch, receipt, { idempotencyKey: "activate-1", lease: data.lease }),
		).rejects.toThrow("is not accepted for skill activation");
		expect(await data.harnessState.loadCurrent()).toEqual(data.base);
	});

	it("rejects stale harness bases and tampered write receipts", async () => {
		const stale = await writerFixture({ operation: "CREATE", proposedName: "created-skill" });
		const staleBatch = await stale.writer.buildMutationBatch({ scope, groupId: stale.group.groupId, createdAt: now });
		const staleReceipt = await stale.writer.write(staleBatch, {
			idempotencyKey: "write-1",
			lease: stale.lease,
		});
		const competing = await stale.harnessState.advance(
			{ memory: "Competing harness memory.\n" },
			stale.base.manifest.version,
		);
		if (competing.status !== "advanced") throw new Error("Expected competing harness advance");
		await expect(
			stale.writer.activate(staleBatch, staleReceipt, {
				idempotencyKey: "activate-1",
				lease: stale.lease,
			}),
		).rejects.toMatchObject({ reasonCode: "harness-base-conflict", retryable: false });
		expect(await stale.harnessState.loadCurrent()).toEqual(competing.bundle);

		const tampered = await writerFixture({ operation: "CREATE", proposedName: "created-skill" });
		const batch = await tampered.writer.buildMutationBatch({
			scope,
			groupId: tampered.group.groupId,
			createdAt: now,
		});
		const receipt = await tampered.writer.write(batch, { idempotencyKey: "write-1", lease: tampered.lease });
		if (receipt.result.output === null) throw new Error("Expected skill write output");
		const changed = {
			...receipt,
			result: {
				...receipt.result,
				output: { ...receipt.result.output, resultingHarnessVersion: `sha256:${"f".repeat(64)}` },
			},
		};
		await expect(
			tampered.writer.activate(batch, changed, { idempotencyKey: "activate-1", lease: tampered.lease }),
		).rejects.toThrow("write receipt does not match its staged bundle");
		expect(await tampered.harnessState.loadCurrent()).toEqual(tampered.base);
	});
});
