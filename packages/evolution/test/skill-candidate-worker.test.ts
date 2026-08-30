import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	EvolutionControlService,
	type EvolutionControlServiceDependencies,
	EvolutionExecutionError,
	type EvolutionInputSnapshot,
	type EvolutionJob,
	type EvolutionJobStore,
	type EvolutionLeaseStore,
	type EvolutionLeaseToken,
	type EvolutionScope,
	FileEvolutionPersistence,
	PollingSkillCandidateWorkSource,
	type SkillCandidate,
	type SkillCandidateDraftRecordingInput,
	type SkillCandidateEvaluationRecordingInput,
	type SkillCandidateEvaluationStartInput,
	type SkillCandidateGroup,
	type SkillCandidateRegistry,
	type SkillCandidateRegistryAppendResult,
	type SkillCandidateRegistryConsolidationInput,
	type SkillCandidateRegistryEvent,
	type SkillCandidateRegistrySnapshot,
	type SkillCandidateRegistryStore,
	SkillCandidateRegistryWorker,
	type SkillCandidateSynthesisFailureRecordingInput,
	type SkillCandidateValidationRecordingInput,
	type SkillDraft,
	type SkillDraftValidationReport,
	type SkillDraftValidatorInput,
	type SkillEvaluationReport,
	type SkillEvaluatorInput,
	type SkillSynthesizerInput,
} from "../src/index.ts";

const now = "2026-08-25T12:00:00.000Z";
const harnessVersion = `sha256:${"2".repeat(64)}`;
const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1",
	promptVersion: null,
	model: null,
};

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt: now, content });
}

function inputSnapshot(): EvolutionInputSnapshot {
	const memory = "# Evolution memory\n";
	return {
		metadata: metadata("input-1", [], { trigger: "manual" }),
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
		ingestionHighWaterCursor: 0,
		instructions: [],
		skillCatalog: [],
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
		evidenceSources: [],
	};
}

function candidate(): SkillCandidate {
	return {
		artifactKind: "skill-candidate",
		candidateId: "candidate-1",
		metadata: metadata("candidate-1", [], { artifactKind: "skill-candidate", candidateId: "candidate-1" }),
	} as unknown as SkillCandidate;
}

function reference(artifact: EvolutionArtifact): EvolutionArtifactReference {
	return {
		artifactId: artifact.metadata.artifactId,
		contentDigest: computeEvolutionContentDigest(artifact),
	};
}

function completedJob(
	inputReference: EvolutionArtifactReference,
	candidateReference: EvolutionArtifactReference,
): EvolutionJob {
	const checkpoint = {
		schemaVersion: 1 as const,
		stage: "skill-curating" as const,
		idempotencyKey: "job-1:skill-curating",
		outputArtifacts: [candidateReference],
		state: {
			candidateIds: ["candidate-1"],
			deferredFindingIds: [],
			selectedMemoryProposalIds: [],
		},
		completedAt: now,
	};
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
		checkpoints: [checkpoint],
		attempt: 1,
		revision: 3,
		createdAt: now,
		updatedAt: now,
		terminalAt: now,
		retryNotBefore: null,
	};
	return {
		metadata: metadata(content.jobId, [inputReference.artifactId], content),
		...content,
	};
}

function transientSynthesisError(message = "temporary provider failure"): EvolutionExecutionError {
	return new EvolutionExecutionError(message, {
		reasonCode: "model-call-failed",
		retryable: true,
	});
}

function qualifiedGroup(candidateReference: EvolutionArtifactReference): SkillCandidateGroup {
	return {
		groupId: "group-qualified",
		profile: {
			workspace: { repositoryId: "diffex", directoryId: "directory-1", evolutionScope: scope },
			existingSkillIds: [],
			skillability: "verification-routine",
			triggerTerms: ["focused", "verification"],
			proceduralIntentTerms: ["focused", "test"],
			applicabilityTerms: ["repository"],
		},
		proposalRevisions: [
			{
				revisionId: "proposal-revision-1",
				candidateId: "candidate-1",
				candidate: candidateReference,
				sourceEvolutionJobId: "job-1",
				createdAt: now,
				evidence: {
					supportingEvidenceIds: [],
					contradictingEvidenceIds: [],
					supportingTraceIds: [],
					contradictingTraceIds: [],
					supportingTaskLineageIds: ["task-a", "task-b"],
					contradictingTaskLineageIds: [],
				},
			},
		],
		state: "evidence-qualified",
		dispositionHistory: [],
		evidence: {
			supportingEvidenceIds: [],
			contradictingEvidenceIds: [],
			supportingTraceIds: [],
			contradictingTraceIds: [],
			supportingTaskLineageIds: ["task-a", "task-b"],
			contradictingTaskLineageIds: [],
		},
		priorityScore: null,
		draft: null,
		validation: null,
		evaluation: null,
		synthesisIdempotencyKey: "skill-synthesis-qualified",
		validationIdempotencyKey: "skill-validation-qualified",
		evaluationIdempotencyKey: "skill-evaluation-qualified",
	};
}

class MemoryJobStore implements EvolutionJobStore {
	readonly jobs: EvolutionJob[];

	constructor(jobs: readonly EvolutionJob[]) {
		this.jobs = [...jobs];
	}

	async create(): Promise<void> {}
	async save(): Promise<void> {}

	async load(jobId: string): Promise<EvolutionJob | null> {
		return this.jobs.find((job) => job.jobId === jobId) ?? null;
	}

	async list(): Promise<readonly EvolutionJob[]> {
		return this.jobs;
	}
}

class MemoryArtifactStore implements EvolutionArtifactStore {
	readonly artifacts: Map<string, EvolutionArtifact>;

	constructor(artifacts: readonly EvolutionArtifact[]) {
		this.artifacts = new Map(artifacts.map((artifact) => [reference(artifact).contentDigest, artifact]));
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

class MemoryRegistryStore implements SkillCandidateRegistryStore {
	readonly events: SkillCandidateRegistryEvent[];

	constructor(events: readonly SkillCandidateRegistryEvent[] = []) {
		this.events = [...events];
	}

	async loadSkillCandidateRegistry(): Promise<SkillCandidateRegistrySnapshot> {
		return { revision: this.events.length, events: [...this.events] };
	}

	async appendSkillCandidateRegistryEvents(
		_scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
	): Promise<SkillCandidateRegistryAppendResult> {
		if (this.events.length !== expectedRevision) return "conflict";
		this.events.push(...events);
		return "committed";
	}
}

function workCheckpoint(
	registrySequence: number,
	stage: "synthesizing" | "evaluating" | "completed",
	groupIds: readonly string[],
	attempt = 3,
): SkillCandidateRegistryEvent {
	const content = {
		schemaVersion: 1 as const,
		eventId: `work-checkpoint-${registrySequence}`,
		registrySequence,
		type: "skill-candidate-work-checkpointed" as const,
		workId: "work-job-1",
		sourceEvolutionJobId: "job-1",
		stage,
		idempotencyKey: `work-checkpoint-${stage}`,
		attempt,
		groupIds,
	};
	return { metadata: metadata(content.eventId, [content.sourceEvolutionJobId, ...groupIds], content), ...content };
}

function legacyWorkFailure(registrySequence: number, attempt = 3): SkillCandidateRegistryEvent {
	const content = {
		schemaVersion: 1 as const,
		eventId: `legacy-work-failure-${registrySequence}`,
		registrySequence,
		type: "skill-candidate-work-failed" as const,
		workId: "work-job-1",
		sourceEvolutionJobId: "job-1",
		idempotencyKey: `legacy-work-failure-${attempt}`,
		attempt,
		message: "legacy synthesis failed",
		retryNotBefore: null,
	};
	return { metadata: metadata(content.eventId, [content.sourceEvolutionJobId], content), ...content };
}

class CompletionAcknowledgementLostStore extends MemoryRegistryStore {
	interrupted = false;

	override async appendSkillCandidateRegistryEvents(
		scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
	): Promise<SkillCandidateRegistryAppendResult> {
		if (
			!this.interrupted &&
			events.some((event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed")
		) {
			this.interrupted = true;
			if (this.events.length !== expectedRevision) return "conflict";
			this.events.push(...events);
			throw new Error("completion acknowledgement lost");
		}
		return super.appendSkillCandidateRegistryEvents(scope, expectedRevision, events);
	}
}

class MemoryLeaseStore implements EvolutionLeaseStore {
	readonly leases = new Map<string, EvolutionLeaseToken>();

	async assertHeld(lease: EvolutionLeaseToken): Promise<void> {
		const current = this.leases.get(`${lease.kind}\0${lease.key}`);
		if (current?.ownerId !== lease.ownerId || current.fence !== lease.fence) throw new Error("lease was lost");
	}

	async acquire(
		kind: EvolutionLeaseToken["kind"],
		key: string,
		ownerId: string,
		acquiredAt: string,
		ttlMs: number,
	): Promise<EvolutionLeaseToken | null> {
		const leaseKey = `${kind}\0${key}`;
		const current = this.leases.get(leaseKey);
		if (current !== undefined && Date.parse(current.expiresAt) > Date.parse(acquiredAt)) return null;
		const lease = {
			kind,
			key,
			ownerId,
			fence: (current?.fence ?? 0) + 1,
			expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString(),
		};
		this.leases.set(leaseKey, lease);
		return lease;
	}

	async renew(lease: EvolutionLeaseToken, renewedAt: string, ttlMs: number): Promise<EvolutionLeaseToken | null> {
		await this.assertHeld(lease);
		const renewed = { ...lease, expiresAt: new Date(Date.parse(renewedAt) + ttlMs).toISOString() };
		this.leases.set(`${lease.kind}\0${lease.key}`, renewed);
		return renewed;
	}

	async release(lease: EvolutionLeaseToken): Promise<void> {
		const leaseKey = `${lease.kind}\0${lease.key}`;
		const current = this.leases.get(leaseKey);
		if (current?.ownerId === lease.ownerId && current.fence === lease.fence) this.leases.delete(leaseKey);
	}
}

class FixtureRegistry implements SkillCandidateRegistry {
	readonly requests: SkillCandidateRegistryConsolidationInput[] = [];
	readonly draftRequests: SkillCandidateDraftRecordingInput[] = [];
	readonly validationRequests: SkillCandidateValidationRecordingInput[] = [];
	readonly evaluationSkipRequests: SkillCandidateEvaluationStartInput[] = [];
	readonly evaluationStartRequests: SkillCandidateEvaluationStartInput[] = [];
	readonly evaluationRequests: SkillCandidateEvaluationRecordingInput[] = [];
	readonly groups: SkillCandidateGroup[] = [];
	failuresRemaining = 0;

	async consolidate(
		input: SkillCandidateRegistryConsolidationInput,
	): Promise<{ readonly groups: readonly SkillCandidateGroup[]; readonly changedGroupIds: readonly string[] }> {
		this.requests.push(input);
		if (this.failuresRemaining > 0) {
			this.failuresRemaining -= 1;
			throw new Error("registry unavailable");
		}
		return { groups: this.groups, changedGroupIds: ["group-1"] };
	}

	async recordSynthesisFailures(
		input: SkillCandidateSynthesisFailureRecordingInput,
	): Promise<readonly SkillCandidateGroup[]> {
		return input.failures.map((failure) => {
			const index = this.groups.findIndex((candidateGroup) => candidateGroup.groupId === failure.groupId);
			const group = this.groups[index];
			if (group === undefined) throw new Error("Unknown group");
			if (group.state === "synthesis-failed") return group;
			const failed = {
				...group,
				state: "synthesis-failed" as const,
				dispositionHistory: [
					...group.dispositionHistory,
					{
						eventId: `synthesis-failed-${failure.groupId}`,
						from: group.state,
						to: "synthesis-failed" as const,
						reasonCodes: [failure.reasonCode],
						createdAt: input.createdAt,
					},
				],
			};
			this.groups[index] = failed;
			return failed;
		});
	}

	async recordDraft(input: SkillCandidateDraftRecordingInput): Promise<SkillCandidateGroup> {
		this.draftRequests.push(input);
		const index = this.groups.findIndex((candidateGroup) => candidateGroup.groupId === input.groupId);
		const group = this.groups[index];
		if (group === undefined) throw new Error("Unknown group");
		const drafted = { ...group, state: "drafted" as const, draft: input.draft };
		this.groups[index] = drafted;
		return drafted;
	}

	async recordValidation(input: SkillCandidateValidationRecordingInput): Promise<SkillCandidateGroup> {
		this.validationRequests.push(input);
		const index = this.groups.findIndex((candidateGroup) => candidateGroup.groupId === input.groupId);
		const group = this.groups[index];
		if (group === undefined) throw new Error("Unknown group");
		const validated = {
			...group,
			state: "structurally-valid" as const,
			draft: input.draft,
			validation: input.validation,
		};
		this.groups[index] = validated;
		return validated;
	}

	async skipEvaluation(input: SkillCandidateEvaluationStartInput): Promise<SkillCandidateGroup> {
		this.evaluationSkipRequests.push(input);
		const index = this.groups.findIndex((candidateGroup) => candidateGroup.groupId === input.groupId);
		const group = this.groups[index];
		if (group === undefined) throw new Error("Unknown group");
		const accepted = {
			...group,
			state: "accepted" as const,
			draft: input.draft,
			validation: input.validation,
			dispositionHistory: [
				...group.dispositionHistory,
				{
					eventId: "evaluation-skipped",
					from: group.state,
					to: "accepted" as const,
					reasonCodes: ["retrieval-and-behavior-evaluation-skipped"],
					createdAt: input.createdAt,
				},
			],
		};
		this.groups[index] = accepted;
		return accepted;
	}

	async startEvaluation(input: SkillCandidateEvaluationStartInput): Promise<SkillCandidateGroup> {
		this.evaluationStartRequests.push(input);
		const index = this.groups.findIndex((candidateGroup) => candidateGroup.groupId === input.groupId);
		const group = this.groups[index];
		if (group === undefined) throw new Error("Unknown group");
		const pending = {
			...group,
			state: "evaluation-pending" as const,
			draft: input.draft,
			validation: input.validation,
		};
		this.groups[index] = pending;
		return pending;
	}

	async recordEvaluation(input: SkillCandidateEvaluationRecordingInput): Promise<SkillCandidateGroup> {
		this.evaluationRequests.push(input);
		const index = this.groups.findIndex((candidateGroup) => candidateGroup.groupId === input.groupId);
		const group = this.groups[index];
		if (group === undefined) throw new Error("Unknown group");
		const accepted = { ...group, state: "accepted" as const, evaluation: input.evaluation };
		this.groups[index] = accepted;
		return accepted;
	}

	async list(): Promise<readonly SkillCandidateGroup[]> {
		return this.groups;
	}
}

function fixture(withEvaluator = false, store: MemoryRegistryStore = new MemoryRegistryStore()) {
	const input = inputSnapshot();
	const skillCandidate = candidate();
	const inputReference = reference(input);
	const candidateReference = reference(skillCandidate);
	const job = completedJob(inputReference, candidateReference);
	const jobs = new MemoryJobStore([job]);
	const leases = new MemoryLeaseStore();
	const registry = new FixtureRegistry();
	const synthesisRequests: SkillSynthesizerInput[] = [];
	const synthesisFailures = new Map<string, unknown>();
	const validationRequests: SkillDraftValidatorInput[] = [];
	const evaluationRequests: SkillEvaluatorInput[] = [];
	let clockTime = now;
	const clock = { now: () => clockTime };
	return {
		job,
		jobs,
		store,
		registry,
		synthesisRequests,
		synthesisFailures,
		validationRequests,
		evaluationRequests,
		clock,
		setClock(value: string) {
			clockTime = value;
		},
		worker: new SkillCandidateRegistryWorker({
			version: "1",
			clock,
			jobs,
			artifacts: new MemoryArtifactStore([input, skillCandidate]),
			store,
			leases,
			ownerId: "worker-1",
			registry,
			synthesizer: {
				async synthesize(request): Promise<SkillDraft> {
					synthesisRequests.push(request);
					const synthesisFailure = synthesisFailures.get(request.group.groupId);
					if (synthesisFailure !== undefined) throw synthesisFailure;
					const content = {
						artifactKind: "skill-draft" as const,
						draftId: "draft-1",
						groupId: request.group.groupId,
						synthesisIdempotencyKey: request.idempotencyKey,
						proposalRevisionIds: request.group.proposalRevisions.map((revision) => revision.revisionId),
						sourceCandidateIds: ["candidate-1"],
						sourceEvidenceIds: [],
						sourceTraceIds: [],
						sourceSkillVersions: [],
						repositoryInstructionDigests: [],
						operation: "CREATE" as const,
						proposedName: "fixture-skill",
						existingSkillIds: [],
						workspace: {
							repositoryId: "diffex",
							directoryId: "directory-1",
							rootPath: "/repo",
							repositoryRevision: "revision-1",
							evolutionScope: scope,
						},
						content: "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n",
						files: [],
					};
					return { metadata: metadata(content.draftId, content.sourceCandidateIds, content), ...content };
				},
			},
			validator: {
				async validate(request): Promise<SkillDraftValidationReport> {
					validationRequests.push(request);
					const content = {
						artifactKind: "skill-draft-validation" as const,
						validationId: "validation-1",
						groupId: request.group.groupId,
						draft: reference(request.draft),
						validatorVersion: "validator-v1",
						assurance: "structure-provenance-scope-and-security-only" as const,
						disposition: "accepted" as const,
						issues: [],
						validatedHarnessVersion: harnessVersion,
						validatedSkillVersions: [],
						canonicalInventory: ["skills/fixture-skill/SKILL.md"],
						memoryRelationshipDigest: computeEvolutionContentDigest([]),
					};
					return { metadata: metadata(content.validationId, [request.draft.draftId], content), ...content };
				},
			},
			...(withEvaluator
				? {
						evaluator: {
							async evaluate(request: SkillEvaluatorInput): Promise<SkillEvaluationReport> {
								evaluationRequests.push(request);
								const draftReference = reference(request.draft);
								const validationReference = reference(request.validation);
								const content = {
									artifactKind: "skill-evaluation" as const,
									schemaVersion: 1 as const,
									evaluationId: "evaluation-1",
									groupId: request.group.groupId,
									evaluationIdempotencyKey: request.idempotencyKey,
									proposalRevisionIds: request.group.proposalRevisions.map((revision) => revision.revisionId),
									draft: draftReference,
									validation: validationReference,
									evaluatorVersion: "skill-evaluator-v1",
									assurance: "retrieval-and-deterministic-behavior-gates" as const,
									disposition: "accepted" as const,
									harnessVersion,
									candidateSkill: {
										skillId: request.draft.draftId,
										name: request.draft.proposedName,
										description: "Fixture skill.",
										source: "candidate" as const,
										version: request.draft.metadata.contentDigest,
										contentDigest: computeEvolutionContentDigest(request.draft.content),
										content: request.draft.content,
									},
									neighboringSkills: [],
									configuration: {
										model: {
											provider: "faux",
											model: "fixture",
											configurationDigest: `sha256:${"4".repeat(64)}`,
										},
										runtime: { name: "node", version: "24", configurationDigest: `sha256:${"5".repeat(64)}` },
										retriever: {
											name: "fixture",
											version: "1",
											configurationDigest: `sha256:${"6".repeat(64)}`,
										},
										executor: {
											name: "fixture",
											version: "1",
											configurationDigest: `sha256:${"7".repeat(64)}`,
										},
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
								return {
									metadata: metadata(content.evaluationId, [request.draft.draftId], content),
									...content,
								};
							},
						},
					}
				: {}),
			model: {
				maxProviderCallsPerExecution: 20,
				execute: () => Promise.reject(new Error("Fixture synthesizer does not call the model")),
			},
		}),
	};
}

describe("skill candidate registry worker", () => {
	it("discovers only completed evolution jobs with unfinished candidate work", async () => {
		const data = fixture();
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store: data.store,
			registry: data.registry,
			evaluatorAvailable: false,
		});

		expect(await source.nextRunnableJob(now)).toBe(data.job.jobId);
		await data.worker.process(data.job.jobId);
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("loads checkpointed immutable candidates and records resumable work checkpoints", async () => {
		const data = fixture();

		await data.worker.process(data.job.jobId);
		await data.worker.process(data.job.jobId);

		expect(data.registry.requests).toHaveLength(1);
		expect(data.registry.requests[0]).toMatchObject({
			sourceEvolutionJobId: "job-1",
			candidates: [{ candidate: { candidateId: "candidate-1" } }],
		});
		expect(
			data.store.events.flatMap((event) =>
				event.type === "skill-candidate-work-checkpointed" ? [event.stage] : [],
			),
		).toEqual(["consolidating", "scoring", "synthesizing", "validating", "evaluating", "completed"]);
		expect(
			data.store.events
				.filter((event) => event.type === "skill-candidate-work-checkpointed")
				.map((event) => event.idempotencyKey),
		).toEqual([
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
			expect.stringMatching(/^skill-candidate-work-stage-/),
		]);
	});

	it("claims candidate work before concurrent processors can synthesize it", async () => {
		const data = fixture(true);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));

		const results = await Promise.all([data.worker.process(data.job.jobId), data.worker.process(data.job.jobId)]);

		expect(results).toEqual(["processed", "busy"]);
		expect(data.registry.requests).toHaveLength(1);
		expect(data.synthesisRequests).toHaveLength(1);
		expect(
			data.store.events.filter(
				(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
			),
		).toHaveLength(1);
		expect(data.store.events.some((event) => event.type === "skill-candidate-work-failed")).toBe(false);
	});

	it("does not append failure after a committed completion loses its acknowledgement", async () => {
		const store = new CompletionAcknowledgementLostStore();
		const data = fixture(false, store);

		await expect(data.worker.process(data.job.jobId)).rejects.toThrow("completion acknowledgement lost");

		expect(
			store.events.filter(
				(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
			),
		).toHaveLength(1);
		expect(store.events.some((event) => event.type === "skill-candidate-work-failed")).toBe(false);
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store,
			registry: data.registry,
			evaluatorAvailable: false,
		});
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("synthesizes and records drafts only for evidence-qualified groups", async () => {
		const data = fixture();
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));

		await data.worker.process(data.job.jobId);

		expect(data.synthesisRequests).toHaveLength(1);
		expect(data.synthesisRequests[0]).toMatchObject({
			group: { groupId: "group-qualified", state: "evidence-qualified" },
			idempotencyKey: "skill-synthesis-qualified",
		});
		expect(data.registry.draftRequests).toEqual([
			expect.objectContaining({
				groupId: "group-qualified",
				proposalRevisionIds: ["proposal-revision-1"],
				idempotencyKey: "skill-synthesis-qualified",
				draft: expect.objectContaining({ artifactId: "draft-1" }),
			}),
		]);
		expect(data.validationRequests).toEqual([
			expect.objectContaining({
				group: expect.objectContaining({ groupId: "group-qualified", state: "drafted" }),
				idempotencyKey: "skill-validation-qualified",
			}),
		]);
		expect(data.registry.validationRequests).toEqual([
			expect.objectContaining({
				groupId: "group-qualified",
				idempotencyKey: "skill-validation-qualified",
				validation: expect.objectContaining({ artifactId: "validation-1" }),
			}),
		]);
	});

	it("continues processing later candidates when one synthesis fails", async () => {
		const data = fixture(true);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		const group = qualifiedGroup(candidateReference);
		data.registry.groups.push(
			{
				...group,
				groupId: "group-failing",
				synthesisIdempotencyKey: "skill-synthesis-failing",
				validationIdempotencyKey: "skill-validation-failing",
				evaluationIdempotencyKey: "skill-evaluation-failing",
			},
			{
				...group,
				groupId: "group-succeeding",
				synthesisIdempotencyKey: "skill-synthesis-succeeding",
				validationIdempotencyKey: "skill-validation-succeeding",
				evaluationIdempotencyKey: "skill-evaluation-succeeding",
			},
		);
		const providerError = new Error("Provider rejected the structured response");
		providerError.name = "ProviderError";
		data.synthesisFailures.set(
			"group-failing",
			new EvolutionExecutionError("Skill synthesizer failed to produce a draft", {
				reasonCode: "skill-synthesis-invalid-response",
				retryable: false,
				cause: providerError,
				diagnostics: { lastCorrection: "files must be an array" },
			}),
		);

		await expect(data.worker.process(data.job.jobId)).rejects.toThrow(
			"Skill synthesis failed for candidate groups: group-failing",
		);

		expect(data.synthesisRequests.map((request) => request.group.groupId)).toEqual([
			"group-failing",
			"group-succeeding",
		]);
		expect(data.validationRequests.map((request) => request.group.groupId)).toEqual(["group-succeeding"]);
		expect(data.evaluationRequests.map((request) => request.group.groupId)).toEqual(["group-succeeding"]);
		expect(data.registry.groups.find((candidateGroup) => candidateGroup.groupId === "group-failing")).toMatchObject({
			state: "synthesis-failed",
			dispositionHistory: [expect.objectContaining({ reasonCodes: ["skill-synthesis-non-retryable"] })],
		});
		expect(data.registry.groups.find((candidateGroup) => candidateGroup.groupId === "group-succeeding")?.state).toBe(
			"accepted",
		);
		expect(data.store.events.find((event) => event.type === "skill-candidate-work-failed")).toMatchObject({
			message: "Skill synthesis failed for candidate groups: group-failing",
			stage: "synthesizing",
			diagnostics: [
				{
					groupId: "group-failing",
					synthesisIdempotencyKey: "skill-synthesis-failing",
					error: {
						name: "EvolutionExecutionError",
						message: "Skill synthesizer failed to produce a draft",
						reasonCode: "skill-synthesis-invalid-response",
						retryable: false,
						diagnostics: { lastCorrection: "files must be an array" },
						cause: { name: "ProviderError", message: "Provider rejected the structured response" },
					},
				},
			],
			retryNotBefore: null,
		});
		expect(
			data.store.events.some(
				(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
			),
		).toBe(false);
	});

	it("reconciles legacy exhausted synthesis by identity under fresh bounded retries", async () => {
		const store = new MemoryRegistryStore([
			workCheckpoint(1, "synthesizing", ["group-failing", "group-succeeding"]),
			legacyWorkFailure(2),
		]);
		const data = fixture(true, store);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		const group = qualifiedGroup(candidateReference);
		data.registry.groups.push(
			{
				...group,
				groupId: "group-failing",
				synthesisIdempotencyKey: "skill-synthesis-failing",
				validationIdempotencyKey: "skill-validation-failing",
				evaluationIdempotencyKey: "skill-evaluation-failing",
			},
			{
				...group,
				groupId: "group-succeeding",
				synthesisIdempotencyKey: "skill-synthesis-succeeding",
				validationIdempotencyKey: "skill-validation-succeeding",
				evaluationIdempotencyKey: "skill-evaluation-succeeding",
			},
			{
				...group,
				groupId: "group-unrelated",
				synthesisIdempotencyKey: "skill-synthesis-unrelated",
				validationIdempotencyKey: "skill-validation-unrelated",
				evaluationIdempotencyKey: "skill-evaluation-unrelated",
			},
		);
		data.synthesisFailures.set("group-failing", transientSynthesisError());
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store,
			registry: data.registry,
			evaluatorAvailable: true,
		});

		expect(await source.nextRunnableJob(now)).toBeNull();
		await source.reconcileLegacyWork();
		expect(await source.nextRunnableJob(now)).toBe(data.job.jobId);

		for (let retryAttempt = 1; retryAttempt <= 3; retryAttempt += 1) {
			await expect(data.worker.process(data.job.jobId)).rejects.toThrow(
				"Skill synthesis failed for candidate groups: group-failing",
			);
			const failure = store.events.find(
				(event) => event.type === "skill-candidate-work-failed" && event.attempt === retryAttempt + 3,
			);
			expect(failure).toMatchObject({ retryNotBefore: retryAttempt === 3 ? null : expect.any(String) });
		}

		expect(data.synthesisRequests.map((request) => request.group.groupId)).toEqual([
			"group-failing",
			"group-succeeding",
			"group-failing",
			"group-failing",
		]);
		expect(data.registry.groups).toEqual([
			expect.objectContaining({ groupId: "group-failing", state: "synthesis-failed" }),
			expect.objectContaining({ groupId: "group-succeeding", state: "accepted" }),
			expect.objectContaining({ groupId: "group-unrelated", state: "evidence-qualified" }),
		]);
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("reconciles a completed checkpoint followed by a legacy synthesis failure", async () => {
		const store = new MemoryRegistryStore([
			workCheckpoint(1, "synthesizing", ["group-qualified"]),
			workCheckpoint(2, "completed", ["group-qualified"]),
			legacyWorkFailure(3),
		]);
		const data = fixture(false, store);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store,
			registry: data.registry,
			evaluatorAvailable: false,
		});

		await source.reconcileLegacyWork();
		expect(await source.nextRunnableJob(now)).toBe(data.job.jobId);
		await data.worker.process(data.job.jobId);

		const completions = store.events.filter(
			(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
		);
		expect(completions).toHaveLength(2);
		expect(completions[1]?.registrySequence).toBeGreaterThan(legacyWorkFailure(3).registrySequence);
		expect(data.registry.groups[0]?.state).toBe("accepted");
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("tracks transient synthesis attempts by identity across source evolution jobs", async () => {
		const data = fixture(true);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));
		data.synthesisFailures.set("group-qualified", transientSynthesisError());

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const job = attempt === 1 ? data.job : { ...data.job, jobId: `job-${attempt}` };
			if (attempt > 1) data.jobs.jobs.push(job);
			await expect(data.worker.process(job.jobId)).rejects.toThrow(
				"Skill synthesis failed for candidate groups: group-qualified",
			);
			const failure = data.store.events.find(
				(event) => event.type === "skill-candidate-work-failed" && event.sourceEvolutionJobId === job.jobId,
			);
			expect(failure).toMatchObject({
				retryNotBefore: attempt === 3 ? null : expect.any(String),
				diagnostics: [expect.objectContaining({ synthesisIdempotencyKey: "skill-synthesis-qualified" })],
			});
		}

		expect(data.synthesisRequests).toHaveLength(3);
		expect(data.registry.groups[0]).toMatchObject({
			state: "synthesis-failed",
			dispositionHistory: [expect.objectContaining({ reasonCodes: ["skill-synthesis-attempts-exhausted"] })],
		});
	});

	it("durably exposes exhausted synthesis without blocking a later candidate in the same batch", async () => {
		const data = fixture(true);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		const group = qualifiedGroup(candidateReference);
		data.registry.groups.push(
			{
				...group,
				groupId: "group-failing",
				synthesisIdempotencyKey: "skill-synthesis-failing",
				validationIdempotencyKey: "skill-validation-failing",
				evaluationIdempotencyKey: "skill-evaluation-failing",
			},
			{
				...group,
				groupId: "group-succeeding",
				synthesisIdempotencyKey: "skill-synthesis-succeeding",
				validationIdempotencyKey: "skill-validation-succeeding",
				evaluationIdempotencyKey: "skill-evaluation-succeeding",
			},
		);
		data.synthesisFailures.set("group-failing", transientSynthesisError());

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await expect(data.worker.process(data.job.jobId)).rejects.toThrow(
				"Skill synthesis failed for candidate groups: group-failing",
			);
			expect(
				data.store.events.find(
					(event) => event.type === "skill-candidate-work-failed" && event.attempt === attempt,
				),
			).toMatchObject({ retryNotBefore: attempt === 3 ? null : expect.any(String) });
		}

		expect(data.synthesisRequests.map((request) => request.group.groupId)).toEqual([
			"group-failing",
			"group-succeeding",
			"group-failing",
			"group-failing",
		]);
		expect(data.registry.groups).toEqual([
			expect.objectContaining({
				groupId: "group-failing",
				state: "synthesis-failed",
				dispositionHistory: [
					expect.objectContaining({
						from: "evidence-qualified",
						to: "synthesis-failed",
						reasonCodes: ["skill-synthesis-attempts-exhausted"],
					}),
				],
			}),
			expect.objectContaining({ groupId: "group-succeeding", state: "accepted" }),
		]);

		const persistenceRoot = await mkdtemp(join(tmpdir(), "diffex-mixed-candidate-outcomes-"));
		try {
			const durableStore = new FileEvolutionPersistence(persistenceRoot);
			expect(await durableStore.appendSkillCandidateRegistryEvents(scope, 0, data.store.events)).toBe("committed");
			const reloadedStore = new FileEvolutionPersistence(persistenceRoot);
			const source = new PollingSkillCandidateWorkSource({
				clock: data.clock,
				jobs: data.jobs,
				store: reloadedStore,
				registry: data.registry,
				evaluatorAvailable: true,
			});
			expect(await source.nextRunnableJob(now)).toBeNull();
			const control = new EvolutionControlService({
				scope,
				jobs: data.jobs,
				skillCandidates: data.registry,
				skillCandidateRegistryStore: reloadedStore,
			} as unknown as EvolutionControlServiceDependencies);
			expect(await control.listJobs()).toEqual([
				expect.objectContaining({
					candidateGeneration: {
						status: "partial-failure",
						stage: "synthesizing",
						updatedAt: expect.any(String),
						attempt: 3,
						retryNotBefore: null,
						failureMessage: "Skill synthesis failed for candidate groups: group-failing",
					},
				}),
			]);
		} finally {
			await rm(persistenceRoot, { recursive: true, force: true });
		}

		const nextJob = { ...data.job, jobId: "job-2" };
		data.jobs.jobs.push(nextJob);
		await data.worker.process(nextJob.jobId);

		expect(data.synthesisRequests).toHaveLength(4);
		expect(
			data.store.events.some(
				(event) =>
					event.type === "skill-candidate-work-checkpointed" &&
					event.sourceEvolutionJobId === nextJob.jobId &&
					event.stage === "completed",
			),
		).toBe(true);
	});

	it("accepts structurally valid drafts when retrieval and behavior evaluation is unavailable", async () => {
		const data = fixture();
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));

		await data.worker.process(data.job.jobId);

		expect(data.registry.groups[0]).toMatchObject({
			state: "accepted",
			evaluation: null,
			dispositionHistory: [expect.objectContaining({ reasonCodes: ["retrieval-and-behavior-evaluation-skipped"] })],
		});
		expect(data.registry.evaluationSkipRequests).toEqual([
			expect.objectContaining({
				groupId: "group-qualified",
				idempotencyKey: "skill-evaluation-qualified",
			}),
		]);
		expect(
			data.store.events.some(
				(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
			),
		).toBe(true);
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store: data.store,
			registry: data.registry,
			evaluatorAvailable: false,
		});
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("reopens legacy completed work to record skipped evaluation when no evaluator is available", async () => {
		const data = fixture();
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));
		await data.worker.process(data.job.jobId);
		const accepted = data.registry.groups[0];
		if (accepted === undefined) throw new Error("Expected accepted group");
		data.registry.groups[0] = { ...accepted, state: "structurally-valid", evaluation: null };
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store: data.store,
			registry: data.registry,
			evaluatorAvailable: false,
		});

		expect(await source.nextRunnableJob(now)).toBeNull();
		await source.reconcileLegacyWork();
		expect(await source.nextRunnableJob(now)).toBe(data.job.jobId);
		await data.worker.process(data.job.jobId);

		expect(data.registry.evaluationSkipRequests).toHaveLength(2);
		expect(data.registry.groups[0]).toMatchObject({
			state: "accepted",
			evaluation: null,
			dispositionHistory: expect.arrayContaining([
				expect.objectContaining({ reasonCodes: ["retrieval-and-behavior-evaluation-skipped"] }),
			]),
		});
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("reopens legacy completed work when its evaluator becomes available", async () => {
		const data = fixture(true);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));
		await data.worker.process(data.job.jobId);
		const accepted = data.registry.groups[0];
		if (accepted === undefined) throw new Error("Expected accepted group");
		data.registry.groups[0] = { ...accepted, state: "structurally-valid", evaluation: null };
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store: data.store,
			registry: data.registry,
			evaluatorAvailable: true,
		});

		expect(await source.nextRunnableJob(now)).toBe(data.job.jobId);
		await data.worker.process(data.job.jobId);

		expect(data.evaluationRequests).toHaveLength(2);
		expect(data.registry.groups[0]?.state).toBe("accepted");
		expect(await source.nextRunnableJob(now)).toBeNull();
	});

	it("evaluates structurally valid drafts and records the gated disposition", async () => {
		const data = fixture(true);
		const candidateReference = data.job.checkpoints[0]?.outputArtifacts[0];
		if (candidateReference === undefined) throw new Error("Expected candidate reference");
		data.registry.groups.push(qualifiedGroup(candidateReference));

		await data.worker.process(data.job.jobId);

		expect(data.evaluationRequests).toEqual([
			expect.objectContaining({
				group: expect.objectContaining({ groupId: "group-qualified", state: "evaluation-pending" }),
				idempotencyKey: "skill-evaluation-qualified",
			}),
		]);
		expect(data.registry.evaluationStartRequests).toEqual([
			expect.objectContaining({
				groupId: "group-qualified",
				idempotencyKey: "skill-evaluation-qualified",
			}),
		]);
		expect(data.registry.evaluationRequests).toEqual([
			expect.objectContaining({
				groupId: "group-qualified",
				idempotencyKey: "skill-evaluation-qualified",
				evaluation: expect.objectContaining({ artifactId: "evaluation-1" }),
			}),
		]);
	});

	it("persists bounded retry timing without marking failed work complete", async () => {
		const data = fixture();
		data.registry.failuresRemaining = 1;
		const source = new PollingSkillCandidateWorkSource({
			clock: data.clock,
			jobs: data.jobs,
			store: data.store,
			registry: data.registry,
			evaluatorAvailable: false,
		});

		await expect(data.worker.process(data.job.jobId)).rejects.toThrow("registry unavailable");
		const failure = data.store.events.find((event) => event.type === "skill-candidate-work-failed");
		expect(failure).toMatchObject({
			sourceEvolutionJobId: "job-1",
			attempt: 1,
			retryNotBefore: "2026-08-25T12:00:05.000Z",
		});
		expect(await source.nextRunnableJob(now)).toBeNull();

		data.setClock("2026-08-25T12:00:05.000Z");
		expect(await source.nextRunnableJob(data.clock.now())).toBe("job-1");
		await data.worker.process(data.job.jobId);
		expect(
			data.store.events.some((event) => event.type === "skill-candidate-work-failed" && event.attempt === 2),
		).toBe(false);
		expect(
			data.store.events.some(
				(event) => event.type === "skill-candidate-work-checkpointed" && event.stage === "completed",
			),
		).toBe(true);
	});
});
