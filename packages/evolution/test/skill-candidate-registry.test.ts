import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
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
		sourceProceduralObservationIds: [],
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
			positiveExamples: ["A focused code change needs a deterministic check."],
			negativeExamples: ["No repository files changed."],
		},
		preconditions: ["A focused verification command is available."],
		procedure: {
			steps: [
				{
					sequence: 1,
					action: options.action ?? "Run the focused verification command and inspect its result.",
					condition: null,
				},
			],
			requiredTools: ["shell"],
			environment: ["Repository checkout"],
		},
		failureHandling: [
			{
				signal: "The focused command fails.",
				mitigation: "Inspect the deterministic diagnostic.",
				recovery: "Correct the issue and rerun the focused command.",
			},
		],
		applicabilityBoundaries: ["Repositories with deterministic verification"],
		verificationContract: {
			checks: ["The focused verification command exits successfully."],
			completionCondition: "The focused verification command passes.",
		},
		memoryRelationship: {
			classification: "independent" as const,
			memoryProposalIds: [],
			rationale: "The procedure is distinct from selected memory guidance.",
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
	it("consolidates compatible cross-round proposals independently of their names", async () => {
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
