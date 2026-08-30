import { computeHarnessSkillPackageVersion } from "@earendil-works/diffex-harness-state";
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
	type EvolutionScope,
	PersistentSkillCandidateRegistry,
	type SkillCandidate,
	type SkillCandidateRegistryAppendResult,
	type SkillCandidateRegistryEvent,
	type SkillCandidateRegistrySnapshot,
	type SkillCandidateRegistryStore,
	type SkillDraft,
	type SkillDraftValidationReport,
	type SkillEvaluationReport,
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
			timestamp: new Date(Date.parse(createdAt) + position).toISOString(),
			sessionPosition: position,
			parentSpanId: null,
			causalIdentifiers: [{ name: "diffex.task.lineage.id", value: lineageId }],
			ambiguity: [],
		},
		traceSources: [],
		sessionSource: {
			bindingId: `binding-${lineageId}`,
			sessionId: `session-${lineageId}`,
			path: `/private/${lineageId}.jsonl`,
			sessionFormat: "coding-agent-v3",
			formatVersion: 3,
			segmentTraceSequences: [position + 1],
			entryId: `entry-${position}`,
			entryOrdinal: position,
		},
	};
}

function invocation(items: readonly MaterializedEvidence[], traceId: string): MaterializedInvocation {
	return {
		version: 1,
		tracePath: `/private/${traceId}.jsonl`,
		traceId,
		producer: {
			diffexVersion: "0.2.0",
			sourceRevision: "revision-1",
			runtime: { kind: "node", version: "24.0.0" },
			telemetrySchemaVersions: {},
			metadata: {},
		},
		integrity: "complete",
		terminationStatus: "completed",
		health: null,
		ordering: {
			criteria: ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"],
			ambiguity: [],
		},
		evidence: items,
		diagnostics: [],
	};
}

function input(items: readonly MaterializedEvidence[], traceId: string): EvolutionInputSnapshot {
	const materialized = invocation(items, traceId);
	const source = {
		sourceId: `source-${traceId}`,
		materializationId: `materialization-${traceId}`,
		ingestionCursor: 1,
		origin: "product-runtime" as const,
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
	const memory = "# Evolution memory\n";
	return {
		metadata: metadata(`input-${traceId}`, [source.sourceId], { sourceId: source.sourceId }),
		trigger: "manual",
		repository: {
			repositoryId: "diffex",
			directoryId: "directory-1",
			rootPath: "/repo",
			revision: "current-revision",
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
		evidenceSources: [source],
	};
}

function candidate(options: {
	readonly candidateId: string;
	readonly input: EvolutionInputSnapshot;
	readonly proposedName: string;
	readonly supportingEvidenceIds?: readonly string[];
	readonly contradictingEvidenceIds?: readonly string[];
	readonly taskLineageIds: readonly string[];
	readonly trigger?: string;
	readonly action?: string;
	readonly additionalPositiveExamples?: readonly string[];
	readonly additionalPreconditions?: readonly string[];
	readonly additionalSteps?: readonly string[];
	readonly additionalTools?: readonly string[];
	readonly additionalEnvironment?: readonly string[];
	readonly additionalFailures?: SkillCandidate["failureHandling"];
	readonly additionalBoundaries?: readonly string[];
	readonly additionalChecks?: readonly string[];
}): { readonly candidate: SkillCandidate; readonly reference: EvolutionArtifactReference } {
	const supportingEvidenceIds = options.supportingEvidenceIds ?? [];
	const contradictingEvidenceIds = options.contradictingEvidenceIds ?? [];
	const traceId = options.input.evidenceSources[0]?.invocation.traceId;
	const content = {
		artifactKind: "skill-candidate" as const,
		candidateId: options.candidateId,
		operation: "CREATE" as const,
		workspace: {
			repositoryId: options.input.repository.repositoryId,
			directoryId: options.input.repository.directoryId,
			rootPath: options.input.repository.rootPath,
			repositoryRevision: options.input.repository.revision,
			evolutionScope: options.input.metadata.scope,
		},
		proposedName: options.proposedName,
		existingSkillIds: [],
		sourceLessonIds: [`lesson-${options.candidateId}`],
		provenanceBindings: [
			{
				sourceLessonId: `lesson-${options.candidateId}`,
				supportingEvidenceIds,
				contradictingEvidenceIds,
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
		supportingEvidenceIds,
		contradictingEvidenceIds,
		supportingTraceIds: supportingEvidenceIds.length === 0 || traceId === null ? [] : [traceId],
		contradictingTraceIds: contradictingEvidenceIds.length === 0 || traceId === null ? [] : [traceId],
		taskLineageIds: options.taskLineageIds,
		skillability: {
			classification: "verification-routine" as const,
			rationale: "The evidence describes a repeatable verification routine.",
		},
		trigger: {
			description: options.trigger ?? "A repository change requires focused verification.",
			positiveExamples: [
				"A focused code change needs a deterministic check.",
				...(options.additionalPositiveExamples ?? []),
			],
			negativeExamples: ["No repository files changed."],
		},
		preconditions: ["A focused verification command is available.", ...(options.additionalPreconditions ?? [])],
		procedure: {
			steps: [
				{
					sequence: 1,
					action: options.action ?? "Run the focused verification command and inspect its result.",
					condition: null,
				},
				...(options.additionalSteps ?? []).map((action, index) => ({
					sequence: index + 2,
					action,
					condition: null,
				})),
			],
			requiredTools: ["shell", ...(options.additionalTools ?? [])],
			environment: ["Repository checkout", ...(options.additionalEnvironment ?? [])],
		},
		failureHandling: [
			{
				signal: "The focused command fails.",
				mitigation: "Inspect the deterministic diagnostic.",
				recovery: "Correct the issue and rerun the focused command.",
			},
			...(options.additionalFailures ?? []),
		],
		applicabilityBoundaries: [
			"Repositories with deterministic verification",
			...(options.additionalBoundaries ?? []),
		],
		verificationContract: {
			checks: ["The focused verification command exits successfully.", ...(options.additionalChecks ?? [])],
			completionCondition: "The focused verification command passes.",
		},
		memoryRelationship: {
			classification: "independent" as const,
			memoryProposalIds: [],
			rationale: "The procedure is distinct from selected memory guidance.",
		},
		capsuleSize: {
			serialization: "canonical-json-utf8-v1" as const,
			serializedBytes: 1_024,
			estimatedTokens: 256,
			maxSerializedBytes: 65_536,
			maxEstimatedTokens: 16_384,
		},
	};
	const result: SkillCandidate = {
		metadata: metadata(options.candidateId, content.sourceLessonIds, content),
		...content,
	};
	return {
		candidate: result,
		reference: {
			artifactId: result.candidateId,
			contentDigest: computeEvolutionContentDigest(result),
		},
	};
}

class MemoryArtifactStore implements EvolutionArtifactStore {
	readonly artifacts = new Map<string, EvolutionArtifact>();

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		const contentDigest = computeEvolutionContentDigest(artifact);
		this.artifacts.set(contentDigest, artifact);
		return { artifactId: artifact.metadata.artifactId, contentDigest };
	}

	async get(reference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.artifacts.get(reference.contentDigest);
		if (artifact === undefined) throw new Error("Unknown artifact");
		return artifact;
	}
}

class MemoryRegistryStore implements SkillCandidateRegistryStore {
	readonly events: SkillCandidateRegistryEvent[] = [];

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

class DraftPartialCommitRegistryStore extends MemoryRegistryStore {
	interruptNextMultiAppend = false;

	override async appendSkillCandidateRegistryEvents(
		scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
	): Promise<SkillCandidateRegistryAppendResult> {
		if (this.interruptNextMultiAppend && events.length > 1) {
			this.interruptNextMultiAppend = false;
			if (this.events.length !== expectedRevision) return "conflict";
			this.events.push(events[0]!);
			throw new Error("interrupted draft registry append");
		}
		return super.appendSkillCandidateRegistryEvents(scope, expectedRevision, events);
	}
}

class PartialCommitRegistryStore extends MemoryRegistryStore {
	interrupted = false;

	override async appendSkillCandidateRegistryEvents(
		scope: EvolutionScope,
		expectedRevision: number,
		events: readonly SkillCandidateRegistryEvent[],
	): Promise<SkillCandidateRegistryAppendResult> {
		if (!this.interrupted && events.length > 1) {
			this.interrupted = true;
			this.events.push(events[0]!);
			throw new Error("interrupted registry append");
		}
		return super.appendSkillCandidateRegistryEvents(scope, expectedRevision, events);
	}
}

function registryFixture(store: MemoryRegistryStore = new MemoryRegistryStore()) {
	const artifacts = new MemoryArtifactStore();
	return {
		artifacts,
		store,
		registry: new PersistentSkillCandidateRegistry({ version: "1", artifacts, store }),
	};
}

describe("persistent skill candidate registry", () => {
	it("builds one canonical capsule from the latest contract and unique historical additions", async () => {
		const fixture = registryFixture();
		const firstInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const firstCandidate = candidate({
			candidateId: "candidate-a",
			input: firstInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-a"],
			taskLineageIds: ["task-a"],
			additionalPositiveExamples: ["A legacy package needs its focused verifier."],
			additionalPreconditions: ["The legacy verifier is installed."],
			additionalSteps: ["Archive the legacy verifier output for inspection."],
			additionalTools: ["legacy-verifier"],
			additionalEnvironment: ["Legacy package workspace"],
			additionalFailures: [
				{
					signal: "The legacy verifier cannot start.",
					mitigation: "Inspect the legacy verifier installation.",
					recovery: "Install the verifier and rerun it.",
				},
			],
			additionalBoundaries: ["Legacy packages only"],
			additionalChecks: ["The archived verifier output is readable."],
		});
		const first = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-a",
			input: firstInput,
			candidates: [firstCandidate],
			idempotencyKey: "job-a:registry",
			createdAt,
		});

		const secondInput = input([evidence("support-b", "task-b", 0)], "trace-b");
		const secondCandidate = candidate({
			candidateId: "candidate-b",
			input: secondInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-b"],
			taskLineageIds: ["task-b"],
		});
		await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-b",
			input: secondInput,
			candidates: [secondCandidate],
			idempotencyKey: "job-b:registry",
			createdAt: "2026-08-26T12:00:00.000Z",
		});

		const thirdInput = input([evidence("support-c", "task-c", 0)], "trace-c");
		const thirdCandidate = candidate({
			candidateId: "candidate-c",
			input: thirdInput,
			proposedName: "focused-check-v2",
			supportingEvidenceIds: ["support-c"],
			taskLineageIds: ["task-c"],
		});
		const third = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-c",
			input: thirdInput,
			candidates: [thirdCandidate],
			idempotencyKey: "job-c:registry",
			createdAt: "2026-08-27T12:00:00.000Z",
		});
		const group = third.groups[0];
		if (group === undefined) throw new Error("Expected a canonical candidate group");
		const artifact = await fixture.artifacts.get(group.canonicalCapsule);
		if (!("artifactKind" in artifact) || artifact.artifactKind !== "skill-candidate-group-capsule") {
			throw new Error("Expected a canonical group capsule artifact");
		}

		expect(artifact.contract.proposedName).toBe("focused-check-v2");
		expect(artifact.baseProposalRevisionId).toBe(group.proposalRevisions.at(-1)?.revisionId);
		expect(artifact.proposalRevisionIds).toEqual(group.proposalRevisions.map((revision) => revision.revisionId));
		expect(artifact.sourceDigests).toEqual(
			group.proposalRevisions.map((revision) => revision.candidate.contentDigest),
		);
		expect(artifact.historicalAdditions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					field: "procedure.steps",
					value: expect.objectContaining({ action: "Archive the legacy verifier output for inspection." }),
					supportCount: 1,
					revisionSpans: [{ startIndex: 0, endIndex: 0 }],
				}),
				expect.objectContaining({ field: "procedure.requiredTools", value: "legacy-verifier" }),
				expect.objectContaining({ field: "failureHandling" }),
				expect.objectContaining({ field: "verificationContract.checks" }),
			]),
		);
		const defaultStepDigest = computeEvolutionContentDigest({
			sequence: 1,
			action: "Run the focused verification command and inspect its result.",
			condition: null,
		});
		expect(artifact.support).toContainEqual({
			field: "procedure.steps",
			valueDigest: defaultStepDigest,
			supportCount: 3,
			revisionSpans: [{ startIndex: 0, endIndex: 2 }],
		});
		expect(artifact.conflicts).toContainEqual(
			expect.objectContaining({
				field: "proposedName",
				alternatives: [
					expect.objectContaining({
						value: "focused-check",
						supportCount: 2,
						revisionSpans: [{ startIndex: 0, endIndex: 1 }],
					}),
				],
			}),
		);
		expect(group.canonicalCapsule).not.toEqual(first.groups[0]?.canonicalCapsule);
		expect(
			fixture.store.events.filter((event) => event.type === "skill-candidate-group-capsule-recorded"),
		).toHaveLength(3);

		const retried = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-c",
			input: thirdInput,
			candidates: [thirdCandidate],
			idempotencyKey: "job-c:registry",
			createdAt: "2026-08-27T12:00:00.000Z",
		});
		expect(retried.changedGroupIds).toEqual([]);
		expect(retried.groups[0]?.canonicalCapsule).toEqual(group.canonicalCapsule);
	});

	it("compacts hundreds of repeated revisions without repeating procedural prose", async () => {
		const fixture = registryFixture();
		const sourceInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const candidates = Array.from({ length: 200 }, (_value, index) =>
			candidate({
				candidateId: `candidate-${index.toString().padStart(3, "0")}`,
				input: sourceInput,
				proposedName: "focused-check",
				supportingEvidenceIds: ["support-a"],
				taskLineageIds: ["task-a"],
			}),
		);
		const result = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-repeated",
			input: sourceInput,
			candidates,
			idempotencyKey: "job-repeated:registry",
			createdAt,
		});
		const group = result.groups[0];
		if (group === undefined) throw new Error("Expected a repeated candidate group");
		const artifact = await fixture.artifacts.get(group.canonicalCapsule);
		if (!("artifactKind" in artifact) || artifact.artifactKind !== "skill-candidate-group-capsule") {
			throw new Error("Expected a canonical group capsule artifact");
		}
		const serialized = JSON.stringify(artifact);
		const repeatedProcedure = "Run the focused verification command and inspect its result.";
		const candidateBytes = candidates.reduce((total, item) => total + JSON.stringify(item.candidate).length, 0);

		expect(artifact.proposalRevisionIds).toHaveLength(200);
		expect(artifact.sourceDigests).toHaveLength(200);
		expect(artifact.historicalAdditions).toEqual([]);
		expect(artifact.conflicts).toEqual([]);
		expect(serialized.split(repeatedProcedure)).toHaveLength(2);
		expect(serialized.length).toBeLessThan(candidateBytes / 4);
		expect(artifact.support.find((support) => support.field === "procedure.steps")).toEqual(
			expect.objectContaining({
				supportCount: 200,
				revisionSpans: [{ startIndex: 0, endIndex: 199 }],
			}),
		);
	});

	it("requalifies an exhausted synthesis only after the proposal revision set changes", async () => {
		const fixture = registryFixture();
		const firstInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const firstCandidate = candidate({
			candidateId: "candidate-a",
			input: firstInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-a"],
			taskLineageIds: ["task-a"],
		});

		const first = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-a",
			input: firstInput,
			candidates: [firstCandidate],
			idempotencyKey: "job-a:registry",
			createdAt,
		});
		expect(first.groups).toHaveLength(1);
		expect(first.groups[0]).toMatchObject({
			state: "proposed",
			evidence: { supportingTaskLineageIds: ["task-a"] },
		});

		const secondInput = input([evidence("support-b", "task-b", 0)], "trace-b");
		const secondCandidate = candidate({
			candidateId: "candidate-b",
			input: secondInput,
			proposedName: "repository-verifier",
			supportingEvidenceIds: ["support-b"],
			taskLineageIds: ["task-b"],
		});
		const second = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-b",
			input: secondInput,
			candidates: [secondCandidate],
			idempotencyKey: "job-b:registry",
			createdAt: "2026-08-26T12:00:00.000Z",
		});

		expect(second.groups).toHaveLength(1);
		expect(second.groups[0]).toMatchObject({
			state: "evidence-qualified",
			evidence: { supportingTaskLineageIds: ["task-a", "task-b"] },
		});
		expect(second.groups[0]?.proposalRevisions.map((revision) => revision.candidateId)).toEqual([
			"candidate-a",
			"candidate-b",
		]);
		expect(second.groups[0]?.dispositionHistory.map((record) => record.to)).toEqual([
			"proposed",
			"evidence-qualified",
		]);
		expect(second.groups[0]?.synthesisIdempotencyKey).toMatch(/^skill-synthesis-/);
		expect(second.groups[0]?.evaluationIdempotencyKey).toMatch(/^skill-evaluation-/);
		const group = second.groups[0];
		if (group === undefined) throw new Error("Expected a qualified candidate group");

		const [failed] = await fixture.registry.recordSynthesisFailures({
			scope,
			failures: [
				{
					groupId: group.groupId,
					proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
					idempotencyKey: group.synthesisIdempotencyKey,
					reasonCode: "skill-synthesis-attempts-exhausted",
				},
			],
			createdAt: "2026-08-26T12:01:00.000Z",
		});
		expect(failed).toMatchObject({
			state: "synthesis-failed",
			dispositionHistory: [
				expect.objectContaining({ to: "proposed" }),
				expect.objectContaining({ to: "evidence-qualified" }),
				expect.objectContaining({
					from: "evidence-qualified",
					to: "synthesis-failed",
					reasonCodes: ["skill-synthesis-attempts-exhausted"],
				}),
			],
		});
		expect(
			await fixture.registry.recordSynthesisFailures({
				scope,
				failures: [
					{
						groupId: group.groupId,
						proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
						idempotencyKey: group.synthesisIdempotencyKey,
						reasonCode: "skill-synthesis-attempts-exhausted",
					},
				],
				createdAt: "2026-08-26T12:01:00.000Z",
			}),
		).toEqual([failed]);

		const unchanged = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-b",
			input: secondInput,
			candidates: [secondCandidate],
			idempotencyKey: "job-b:registry",
			createdAt: "2026-08-26T12:00:00.000Z",
		});
		expect(unchanged.changedGroupIds).toEqual([]);
		expect(unchanged.groups[0]?.state).toBe("synthesis-failed");

		const thirdInput = input([evidence("support-c", "task-c", 0)], "trace-c");
		const thirdCandidate = candidate({
			candidateId: "candidate-c",
			input: thirdInput,
			proposedName: "focused-check-revised",
			supportingEvidenceIds: ["support-c"],
			taskLineageIds: ["task-c"],
		});
		const revised = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-c",
			input: thirdInput,
			candidates: [thirdCandidate],
			idempotencyKey: "job-c:registry",
			createdAt: "2026-08-27T12:00:00.000Z",
		});
		expect(revised.groups[0]).toMatchObject({
			state: "evidence-qualified",
			dispositionHistory: [
				expect.objectContaining({ to: "proposed" }),
				expect.objectContaining({ to: "evidence-qualified" }),
				expect.objectContaining({ to: "synthesis-failed" }),
				expect.objectContaining({
					from: "synthesis-failed",
					to: "evidence-qualified",
					reasonCodes: ["proposal-revision-set-changed"],
				}),
			],
		});
		expect(revised.groups[0]?.synthesisIdempotencyKey).not.toBe(group.synthesisIdempotencyKey);
	});

	it("records an immutable draft and advances only an evidence-qualified group", async () => {
		const store = new DraftPartialCommitRegistryStore();
		const fixture = registryFixture(store);
		const firstInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const firstCandidate = candidate({
			candidateId: "candidate-a",
			input: firstInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-a"],
			taskLineageIds: ["task-a"],
		});
		await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-a",
			input: firstInput,
			candidates: [firstCandidate],
			idempotencyKey: "job-a:registry",
			createdAt,
		});
		const secondInput = input([evidence("support-b", "task-b", 0)], "trace-b");
		const secondCandidate = candidate({
			candidateId: "candidate-b",
			input: secondInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-b"],
			taskLineageIds: ["task-b"],
		});
		const consolidated = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-b",
			input: secondInput,
			candidates: [secondCandidate],
			idempotencyKey: "job-b:registry",
			createdAt: "2026-08-26T12:00:00.000Z",
		});
		const group = consolidated.groups[0];
		if (group === undefined) throw new Error("Expected a candidate group");
		const draftContent = {
			artifactKind: "skill-draft" as const,
			draftId: "skill-draft-1",
			groupId: group.groupId,
			synthesisIdempotencyKey: group.synthesisIdempotencyKey,
			proposalRevisionIds: group.proposalRevisions.map((revision) => revision.revisionId),
			sourceCandidateIds: ["candidate-a", "candidate-b"],
			sourceEvidenceIds: ["support-a", "support-b"],
			sourceTraceIds: ["trace-a", "trace-b"],
			sourceSkillVersions: [],
			repositoryInstructionDigests: [],
			operation: secondCandidate.candidate.operation,
			proposedName: secondCandidate.candidate.proposedName,
			existingSkillIds: [],
			workspace: secondCandidate.candidate.workspace,
			content: "---\nname: focused-check\ndescription: Run a focused check after repository changes.\n---\n",
			files: [],
		};
		const draft: SkillDraft = {
			metadata: metadata(draftContent.draftId, draftContent.sourceCandidateIds, draftContent),
			...draftContent,
		};
		const draftReference = await fixture.artifacts.put(draft);
		const request = {
			scope,
			groupId: group.groupId,
			draft: draftReference,
			proposalRevisionIds: draft.proposalRevisionIds,
			idempotencyKey: group.synthesisIdempotencyKey,
			createdAt: "2026-08-26T12:01:00.000Z",
		};

		store.interruptNextMultiAppend = true;
		await expect(fixture.registry.recordDraft(request)).rejects.toThrow("interrupted draft registry append");
		const recorded = await fixture.registry.recordDraft(request);
		const retried = await fixture.registry.recordDraft(request);

		expect(recorded).toMatchObject({ state: "drafted", draft: draftReference });
		expect(retried).toMatchObject({ state: "drafted", draft: draftReference });
		expect(fixture.store.events.filter((event) => event.type === "skill-candidate-draft-recorded")).toHaveLength(1);
		expect(recorded.dispositionHistory.at(-1)).toMatchObject({
			from: "evidence-qualified",
			to: "drafted",
			reasonCodes: ["outcome-aware-draft-recorded"],
		});
		const validationContent = {
			artifactKind: "skill-draft-validation" as const,
			validationId: "skill-validation-1",
			groupId: group.groupId,
			draft: draftReference,
			validatorVersion: "validator-v1",
			assurance: "structure-provenance-scope-and-security-only" as const,
			disposition: "accepted" as const,
			issues: [],
			validatedHarnessVersion: secondInput.expectedHarnessBaseVersion,
			validatedSkillVersions: [],
			canonicalInventory: ["skills/focused-check/SKILL.md"],
			memoryRelationshipDigest: computeEvolutionContentDigest([]),
		};
		const validation: SkillDraftValidationReport = {
			metadata: metadata(validationContent.validationId, [draft.draftId], validationContent),
			...validationContent,
		};
		const validationReference = await fixture.artifacts.put(validation);
		const validationRequest = {
			scope,
			groupId: group.groupId,
			draft: draftReference,
			validation: validationReference,
			proposalRevisionIds: draft.proposalRevisionIds,
			idempotencyKey: recorded.validationIdempotencyKey,
			createdAt: "2026-08-26T12:02:00.000Z",
		};
		store.interruptNextMultiAppend = true;
		await expect(fixture.registry.recordValidation(validationRequest)).rejects.toThrow(
			"interrupted draft registry append",
		);
		const validated = await fixture.registry.recordValidation(validationRequest);

		expect(validated).toMatchObject({ state: "structurally-valid", validation: validationReference });
		expect(validated.dispositionHistory.at(-1)).toMatchObject({
			from: "drafted",
			to: "structurally-valid",
			reasonCodes: ["deterministic-draft-validation-passed"],
		});

		const evaluationStart = {
			scope,
			groupId: group.groupId,
			draft: draftReference,
			validation: validationReference,
			proposalRevisionIds: draft.proposalRevisionIds,
			idempotencyKey: validated.evaluationIdempotencyKey,
			createdAt: "2026-08-26T12:03:00.000Z",
		};
		const skipStore = new MemoryRegistryStore();
		skipStore.events.push(...fixture.store.events);
		const skipRegistry = new PersistentSkillCandidateRegistry({
			version: "1",
			artifacts: fixture.artifacts,
			store: skipStore,
		});
		const skipped = await skipRegistry.skipEvaluation(evaluationStart);
		const skippedRetry = await skipRegistry.skipEvaluation(evaluationStart);
		expect(skipped).toMatchObject({ state: "accepted", evaluation: null });
		expect(skippedRetry).toMatchObject({ state: "accepted", evaluation: null });
		expect(skipped.dispositionHistory.at(-1)).toMatchObject({
			from: "structurally-valid",
			to: "accepted",
			reasonCodes: ["retrieval-and-behavior-evaluation-skipped"],
		});

		const pending = await fixture.registry.startEvaluation(evaluationStart);
		const pendingRetry = await fixture.registry.startEvaluation(evaluationStart);
		expect(pending).toMatchObject({ state: "evaluation-pending", evaluation: null });
		expect(pendingRetry).toMatchObject({ state: "evaluation-pending", evaluation: null });
		const pendingSkipStore = new MemoryRegistryStore();
		pendingSkipStore.events.push(...fixture.store.events);
		const pendingSkipRegistry = new PersistentSkillCandidateRegistry({
			version: "1",
			artifacts: fixture.artifacts,
			store: pendingSkipStore,
		});
		expect(await pendingSkipRegistry.skipEvaluation(evaluationStart)).toMatchObject({
			state: "accepted",
			evaluation: null,
			dispositionHistory: [
				...pending.dispositionHistory,
				expect.objectContaining({
					from: "evaluation-pending",
					to: "accepted",
					reasonCodes: ["retrieval-and-behavior-evaluation-skipped"],
				}),
			],
		});
		const configurationDigest = `sha256:${"6".repeat(64)}`;
		const evaluationContent = {
			artifactKind: "skill-evaluation" as const,
			schemaVersion: 1 as const,
			evaluationId: "skill-evaluation-1",
			groupId: group.groupId,
			evaluationIdempotencyKey: pending.evaluationIdempotencyKey,
			proposalRevisionIds: draft.proposalRevisionIds,
			draft: draftReference,
			validation: validationReference,
			evaluatorVersion: "skill-evaluator-v1",
			assurance: "retrieval-and-deterministic-behavior-gates" as const,
			disposition: "accepted" as const,
			harnessVersion: secondInput.expectedHarnessBaseVersion,
			candidateSkill: {
				skillId: draft.draftId,
				name: draft.proposedName,
				description: "Run a focused check after repository changes.",
				source: "candidate" as const,
				version: computeHarnessSkillPackageVersion({ content: draft.content, files: draft.files }),
				contentDigest: computeEvolutionTextDigest(draft.content),
				content: draft.content,
				files: draft.files,
			},
			neighboringSkills: [],
			configuration: {
				model: { provider: "faux", model: "fixture", configurationDigest },
				runtime: { name: "node", version: "24", configurationDigest },
				retriever: { name: "fixture", version: "1", configurationDigest },
				executor: { name: "fixture", version: "1", configurationDigest },
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
			metadata: metadata(
				evaluationContent.evaluationId,
				[draft.draftId, validation.validationId],
				evaluationContent,
			),
			...evaluationContent,
		};
		const evaluationReference = await fixture.artifacts.put(evaluation);
		const evaluationRequest = { ...evaluationStart, evaluation: evaluationReference };
		store.interruptNextMultiAppend = true;
		await expect(fixture.registry.recordEvaluation(evaluationRequest)).rejects.toThrow(
			"interrupted draft registry append",
		);
		const accepted = await fixture.registry.recordEvaluation(evaluationRequest);
		const acceptedRetry = await fixture.registry.recordEvaluation(evaluationRequest);
		expect(accepted).toMatchObject({ state: "accepted", evaluation: evaluationReference });
		expect(acceptedRetry).toMatchObject({ state: "accepted", evaluation: evaluationReference });
		expect(accepted.dispositionHistory.at(-1)).toMatchObject({
			from: "evaluation-pending",
			to: "accepted",
			reasonCodes: ["retrieval-and-behavior-gates-passed"],
		});
		await expect(fixture.registry.recordDraft(request)).resolves.toMatchObject({ state: "accepted" });
		await expect(fixture.registry.recordValidation(validationRequest)).resolves.toMatchObject({ state: "accepted" });
		await expect(fixture.registry.startEvaluation(evaluationStart)).resolves.toMatchObject({ state: "accepted" });

		const thirdInput = input([evidence("support-c", "task-c", 0)], "trace-c");
		const thirdCandidate = candidate({
			candidateId: "candidate-c",
			input: thirdInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-c"],
			taskLineageIds: ["task-c"],
		});
		const revised = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-c",
			input: thirdInput,
			candidates: [thirdCandidate],
			idempotencyKey: "job-c:registry",
			createdAt: "2026-08-27T12:00:00.000Z",
		});

		expect(revised.groups[0]).toMatchObject({
			state: "evidence-qualified",
			draft: null,
			validation: null,
			evaluation: null,
		});
		expect(revised.groups[0]?.synthesisIdempotencyKey).not.toBe(recorded.synthesisIdempotencyKey);
		expect(revised.groups[0]?.evaluationIdempotencyKey).not.toBe(accepted.evaluationIdempotencyKey);
		expect(revised.groups[0]?.dispositionHistory.at(-1)).toMatchObject({
			from: "accepted",
			to: "evidence-qualified",
			reasonCodes: ["proposal-revision-set-changed"],
		});
	});

	it("does not count retries or repeated lineage citations as recurrence", async () => {
		const fixture = registryFixture();
		const firstInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const firstCandidate = candidate({
			candidateId: "candidate-a",
			input: firstInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-a"],
			taskLineageIds: ["task-a"],
		});
		const request = {
			sourceEvolutionJobId: "job-a",
			input: firstInput,
			candidates: [firstCandidate],
			idempotencyKey: "job-a:registry",
			createdAt,
		};
		await fixture.registry.consolidate(request);
		const retried = await fixture.registry.consolidate(request);
		expect(retried.changedGroupIds).toEqual([]);

		const repeatedInput = input([evidence("support-b", "task-a", 0)], "trace-b");
		const repeatedCandidate = candidate({
			candidateId: "candidate-b",
			input: repeatedInput,
			proposedName: "focused-check-revised",
			supportingEvidenceIds: ["support-b"],
			taskLineageIds: ["task-a"],
		});
		const result = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-b",
			input: repeatedInput,
			candidates: [repeatedCandidate],
			idempotencyKey: "job-b:registry",
			createdAt: "2026-08-26T12:00:00.000Z",
		});

		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]).toMatchObject({
			state: "proposed",
			evidence: {
				supportingEvidenceIds: ["support-a", "support-b"],
				supportingTaskLineageIds: ["task-a"],
			},
		});
	});

	it("resumes a partially appended proposal without duplicating its immutable revision", async () => {
		const store = new PartialCommitRegistryStore();
		const fixture = registryFixture(store);
		const sourceInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const sourceCandidate = candidate({
			candidateId: "candidate-a",
			input: sourceInput,
			proposedName: "focused-check",
			supportingEvidenceIds: ["support-a"],
			taskLineageIds: ["task-a"],
		});
		const request = {
			sourceEvolutionJobId: "job-a",
			input: sourceInput,
			candidates: [sourceCandidate],
			idempotencyKey: "job-a:registry",
			createdAt,
		};

		await expect(fixture.registry.consolidate(request)).rejects.toThrow("interrupted registry append");
		const resumed = await fixture.registry.consolidate(request);

		expect(resumed.groups).toHaveLength(1);
		expect(resumed.groups[0]?.proposalRevisions).toHaveLength(1);
		expect(resumed.groups[0]).toMatchObject({
			state: "proposed",
			priorityScore: { artifactId: expect.stringMatching(/^skill-candidate-score-/) },
		});
		expect(store.events.map((event) => event.registrySequence)).toEqual(
			store.events.map((_event, index) => index + 1),
		);
	});

	it("keeps same-named procedures separate when trigger and intent are incompatible", async () => {
		const fixture = registryFixture();
		const verificationInput = input([evidence("support-a", "task-a", 0)], "trace-a");
		const deploymentInput = input([evidence("support-b", "task-b", 0)], "trace-b");
		await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-a",
			input: verificationInput,
			candidates: [
				candidate({
					candidateId: "candidate-a",
					input: verificationInput,
					proposedName: "safe-workflow",
					supportingEvidenceIds: ["support-a"],
					taskLineageIds: ["task-a"],
				}),
			],
			idempotencyKey: "job-a:registry",
			createdAt,
		});
		const result = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-b",
			input: deploymentInput,
			candidates: [
				candidate({
					candidateId: "candidate-b",
					input: deploymentInput,
					proposedName: "safe-workflow",
					supportingEvidenceIds: ["support-b"],
					taskLineageIds: ["task-b"],
					trigger: "A production release requires a staged deployment and rollback plan.",
					action: "Deploy a canary, inspect service health, then expand or roll back the release.",
				}),
			],
			idempotencyKey: "job-b:registry",
			createdAt: "2026-08-26T12:00:00.000Z",
		});

		expect(result.groups).toHaveLength(2);
		expect(result.groups.every((group) => group.state === "proposed")).toBe(true);
	});

	it("quarantines counterevidence without treating the priority score as acceptance", async () => {
		const fixture = registryFixture();
		const mixedInput = input([evidence("support-a", "task-a", 0), evidence("counter-b", "task-b", 1)], "trace-mixed");
		const result = await fixture.registry.consolidate({
			sourceEvolutionJobId: "job-mixed",
			input: mixedInput,
			candidates: [
				candidate({
					candidateId: "candidate-mixed",
					input: mixedInput,
					proposedName: "focused-check",
					supportingEvidenceIds: ["support-a"],
					contradictingEvidenceIds: ["counter-b"],
					taskLineageIds: ["task-a", "task-b"],
				}),
			],
			idempotencyKey: "job-mixed:registry",
			createdAt,
		});

		expect(result.groups[0]?.state).toBe("quarantined");
		const scoreReference = result.groups[0]?.priorityScore;
		if (scoreReference === null || scoreReference === undefined) throw new Error("Expected priority score");
		expect(fixture.artifacts.artifacts.get(scoreReference.contentDigest)).toMatchObject({
			artifactKind: "skill-candidate-priority-score",
			evidencePriorityScore: expect.any(Number),
		});
		expect(result.groups[0]?.dispositionHistory.some((record) => record.to === "accepted")).toBe(false);
	});
});
