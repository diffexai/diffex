import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	DeterministicProposalRanker,
	EVIDENCE_RANKING_ASSURANCE,
	EVIDENCE_RANKING_SCORER_VERSION,
	type EvidenceCorpusManifest,
	type EvolutionArtifactProducer,
	type EvolutionInputSnapshot,
	type EvolutionMemoryProposal,
	type InstructionSnapshot,
	type Lesson,
	type ProposalScoringInput,
	type ProposalValidationInput,
	type ReflectionResult,
} from "../src/index.ts";

const HARNESS_VERSION = `sha256:${"1".repeat(64)}`;
const MODEL_DIGEST = `sha256:${"2".repeat(64)}`;
const createdAt = "2026-08-19T12:10:00.000Z";
const scope = { repositoryId: "diffex", scopeId: "repository" } as const;
const producer: EvolutionArtifactProducer = { name: "fixture", version: "1", promptVersion: null, model: null };

interface EvidenceFixture {
	readonly evidenceId: string;
	readonly lineageId: string;
	readonly role?: "assistant" | "toolResult" | "user";
	readonly integrity?: MaterializedInvocation["integrity"];
	readonly diagnostics?: MaterializedInvocation["diagnostics"];
}

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt, content });
}

function evidence(fixture: EvidenceFixture, index: number): MaterializedEvidence {
	return {
		kind: "session_item",
		evidenceId: fixture.evidenceId,
		itemType: fixture.role === "toolResult" ? "tool_result" : "message",
		payload: {
			type: "message",
			id: `entry-${fixture.evidenceId}`,
			message: { role: fixture.role ?? "toolResult", content: fixture.evidenceId },
		},
		order: {
			traceSequence: index + 2,
			timestamp: new Date(Date.parse(createdAt) - 60_000 + index).toISOString(),
			sessionPosition: index,
			parentSpanId: null,
			causalIdentifiers: [{ name: "diffex.task.lineage", value: fixture.lineageId }],
			ambiguity: [],
		},
		traceSources: [],
		sessionSource: {
			bindingId: `binding-${fixture.evidenceId}`,
			sessionId: `session-${fixture.evidenceId}`,
			path: `/private/${fixture.evidenceId}.jsonl`,
			sessionFormat: "coding-agent-v3",
			formatVersion: 3,
			segmentTraceSequences: [index + 2],
			entryId: `entry-${fixture.evidenceId}`,
			entryOrdinal: index,
		},
	};
}

function invocation(fixture: EvidenceFixture, index: number): MaterializedInvocation {
	return {
		version: 1,
		tracePath: `/private/trace-${fixture.evidenceId}.jsonl`,
		traceId: `trace-${fixture.evidenceId}`,
		producer: {
			diffexVersion: "0.2.0",
			sourceRevision: "revision-1",
			runtime: { kind: "node", version: "24.0.0" },
			telemetrySchemaVersions: {},
			metadata: {},
		},
		integrity: fixture.integrity ?? "complete",
		terminationStatus: fixture.integrity === "partial" ? "crashed" : "completed",
		health: null,
		ordering: {
			criteria: ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"],
			ambiguity: [],
		},
		evidence: [evidence(fixture, index)],
		diagnostics: fixture.diagnostics ?? [],
	};
}

function lesson(lessonId: string, supportIds: readonly string[], counterIds: readonly string[] = []): Lesson {
	const content = {
		lessonId,
		kind: "successful-strategy" as const,
		summary: `Lesson ${lessonId}`,
		preconditions: ["Repository work"],
		observedOutcome: "The behavior was observed",
		evidenceIds: supportIds,
		counterevidenceIds: counterIds,
		scope,
		applicabilityBoundaries: ["Repository work"],
		uncertainty: null,
		actionableTakeaway: "Keep the verified behavior",
	};
	return { metadata: metadata(lessonId, [...supportIds, ...counterIds], content), ...content };
}

function proposal(
	proposalId: string,
	input: EvolutionInputSnapshot,
	lessons: readonly Lesson[],
	content = `Rule ${proposalId}`,
	overrides: Partial<EvolutionMemoryProposal> = {},
): EvolutionMemoryProposal {
	const supportIds = [...new Set(lessons.flatMap((item) => item.evidenceIds))];
	const counterIds = [...new Set(lessons.flatMap((item) => item.counterevidenceIds))];
	const contexts = input.evidenceSources.flatMap((source) =>
		source.invocation.evidence
			.filter((item) => supportIds.includes(item.evidenceId) || counterIds.includes(item.evidenceId))
			.map((item) => ({ source, item })),
	);
	const exactDelta = {
		operation: "ADD" as const,
		destination: { section: "Engineering", anchor: null },
		content,
		intendedScope: ["Repository work"],
	};
	const body = {
		proposalId,
		summary: `Add ${content}`,
		scope: {
			repository: scope,
			repositoryRevision: input.repository.revision,
			materializationIds: [...new Set(contexts.map(({ source }) => source.materializationId))],
			traceIds: [...new Set(contexts.flatMap(({ source }) => source.invocation.traceId ?? []))],
			sessionIds: [...new Set(contexts.flatMap(({ item }) => item.sessionSource?.sessionId ?? []))],
			taskLineageIds: [
				...new Set(
					contexts.flatMap(({ item }) =>
						item.order.causalIdentifiers
							.filter((identifier) => identifier.name === "diffex.task.lineage")
							.map((identifier) => identifier.value),
					),
				),
			],
			runtimeKinds: ["node"],
			runtimeVersions: ["24.0.0"],
			sourceRevisions: ["revision-1"],
			harnessVersions: [],
			applicabilityBoundaries: ["Repository work"],
		},
		lessonIds: lessons.map((item) => item.lessonId),
		supportingEvidenceIds: supportIds,
		contradictingEvidenceIds: counterIds,
		supportingTraceIds: [
			...new Set(
				contexts
					.filter(({ item }) => supportIds.includes(item.evidenceId))
					.flatMap(({ source }) => source.invocation.traceId ?? []),
			),
		],
		contradictingTraceIds: [
			...new Set(
				contexts
					.filter(({ item }) => counterIds.includes(item.evidenceId))
					.flatMap(({ source }) => source.invocation.traceId ?? []),
			),
		],
		expectedBenefit: "Future behavior is more reliable",
		acceptanceCriterion: "The exact rule appears once",
		risk: "The scope may be too broad",
		rollbackDescription: "Remove the exact rule",
		curatorConfidence: 0.8,
		uncertainty: null,
		counterexamples: [],
		conflictingProposalIds: [],
		instructionRelationship: { classification: "novel" as const, relevantEntries: [], strengthening: null },
		disposition: "actionable" as const,
		target: { kind: "evolution-memory" as const, expectedHarnessVersion: input.expectedHarnessBaseVersion },
		action: "ADD" as const,
		exactDelta,
		expectedBaseDigest: input.harness.memoryContentDigest,
	};
	const merged = { ...body, ...overrides };
	return {
		metadata: createEvolutionArtifactMetadata({
			artifactId: proposalId,
			producer,
			sourceIds: [...merged.lessonIds, ...merged.supportingEvidenceIds, ...merged.contradictingEvidenceIds],
			scope,
			createdAt,
			content: merged,
		}),
		...merged,
	};
}

function fixture(evidenceFixtures: readonly EvidenceFixture[]) {
	const evidenceSources = evidenceFixtures.map((item, index) => {
		const materialized = invocation(item, index);
		return {
			sourceId: `source-${item.evidenceId}`,
			materializationId: `materialization-${item.evidenceId}`,
			ingestionCursor: index + 1,
			origin: "product-runtime" as const,
			contentDigest: computeEvolutionContentDigest(materialized),
			invocation: materialized,
		};
	});
	const memory = "# Evolution memory\n";
	const instructionContent = "Repository guidance.\n";
	const input: EvolutionInputSnapshot = {
		metadata: metadata(
			"input-1",
			evidenceSources.map((source) => source.sourceId),
			{ evidenceSources: evidenceSources.map((source) => source.sourceId) },
		),
		trigger: "manual",
		repository: { repositoryId: "diffex", rootPath: "/repo", revision: "revision-current" },
		harness: {
			harnessVersion: HARNESS_VERSION,
			baseVersion: null,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [],
		},
		expectedHarnessBaseVersion: HARNESS_VERSION,
		ingestionHighWaterCursor: evidenceSources.length,
		instructions: [
			{
				path: "/repo/AGENTS.md",
				precedence: 10,
				content: instructionContent,
				contentDigest: computeEvolutionContentDigest(instructionContent),
			},
		],
		modelConfiguration: { provider: "faux", model: "fixture", configurationDigest: MODEL_DIGEST },
		pipelineVersion: "pipeline-v1",
		promptVersions: {
			reflector: "reflector-v1",
			curator: "curator-v1",
			validator: "validator-v1",
			writer: "writer-v1",
		},
		tokenMeasurement: { estimatorVersion: "fixture", estimatedTokens: 100 },
		evidenceSources,
	};
	const documents = evidenceSources.map((source) => ({
		documentId: `document-${source.materializationId}`,
		sourceId: source.sourceId,
		materializationId: source.materializationId,
		contentDigest: source.contentDigest,
		materializedInvocationVersion: source.invocation.version,
		traceId: source.invocation.traceId,
		integrity: source.invocation.integrity,
		terminationStatus: source.invocation.terminationStatus,
		evidenceIds: source.invocation.evidence.map((item) => item.evidenceId),
		semanticUnits: [],
		diagnostics: source.invocation.diagnostics.map((diagnostic) => ({
			code: diagnostic.code,
			message: diagnostic.message,
			recoverable: diagnostic.recoverable,
			traceSequence: diagnostic.traceSequence ?? null,
			bindingId: diagnostic.bindingId ?? null,
			sourceCode: diagnostic.sourceCode ?? null,
		})),
		orderingAmbiguity: [],
	}));
	const corpus: EvidenceCorpusManifest = {
		metadata: metadata(
			"corpus-1",
			evidenceSources.map((source) => source.sourceId),
			{ documents, excludedSources: [] },
		),
		documents,
		excludedSources: [],
	};
	const instructions: InstructionSnapshot = {
		metadata: metadata("instructions-1", [input.metadata.artifactId], input.instructions),
		documents: input.instructions,
	};
	return { input, corpus, instructions };
}

function validationInput(
	fixtureValue: ReturnType<typeof fixture>,
	lessons: readonly Lesson[],
	proposals: readonly EvolutionMemoryProposal[],
): ProposalValidationInput {
	const reflection: ReflectionResult = {
		nodes: [],
		lessons,
		coverage: {
			metadata: metadata(
				"coverage-1",
				fixtureValue.corpus.documents.map((document) => document.documentId),
				{ lessons: lessons.map((item) => item.lessonId) },
			),
			manifestDigest: fixtureValue.corpus.metadata.contentDigest,
			entries: [],
			rootNodeIds: [],
			finalLessonIds: lessons.map((item) => item.lessonId),
		},
		finalLessonIds: lessons.map((item) => item.lessonId),
	};
	return { ...fixtureValue, reflection, proposals };
}

async function validateAndScore(ranker: DeterministicProposalRanker, input: ProposalValidationInput) {
	const validation = await ranker.validate(input);
	const scoringInput: ProposalScoringInput = { ...input, validation };
	return { validation, scored: await ranker.score(scoringInput) };
}

describe("deterministic proposal evidence ranking", () => {
	it("reproduces identical validation, component scores, and selection", async () => {
		const data = fixture([
			{ evidenceId: "support-a", lineageId: "task-a" },
			{ evidenceId: "support-b", lineageId: "task-b" },
		]);
		const lessons = [lesson("lesson-1", ["support-a", "support-b"])];
		const proposals = [proposal("proposal-a", data.input, lessons)];
		const input = validationInput(data, lessons, proposals);
		const ranker = new DeterministicProposalRanker({ version: "1.2.3" });

		const first = await validateAndScore(ranker, input);
		const second = await validateAndScore(ranker, input);

		expect(first).toEqual(second);
		expect(first.validation).toMatchObject({
			validatorVersion: EVIDENCE_RANKING_SCORER_VERSION,
			assurance: EVIDENCE_RANKING_ASSURANCE,
			proposalResults: [{ proposalId: "proposal-a", disposition: "accepted" }],
		});
		expect(first.scored[0]).toMatchObject({
			disposition: "selected",
			scorerVersion: EVIDENCE_RANKING_SCORER_VERSION,
			scoreComponents: {
				recurrence: 20,
				provenanceIntegrity: 20,
				sourceSignalStrength: 9,
				curatorConfidence: 8,
				proposalCompleteness: 10,
				contradictionPenalty: 0,
			},
		});
		expect(first.scored[0]?.evidenceRankingScore).toBeGreaterThanOrEqual(40);
	});

	it("rejects invented evidence and quarantines evidence outside a verified prefix", async () => {
		const data = fixture([
			{ evidenceId: "support-a", lineageId: "task-a", integrity: "partial" },
			{
				evidenceId: "support-b",
				lineageId: "task-b",
				integrity: "partial",
				diagnostics: [
					{
						code: "session_changed",
						message: "Session changed",
						recoverable: false,
						bindingId: "binding-support-b",
					},
				],
			},
		]);
		const validPrefixLesson = lesson("lesson-prefix", ["support-a", "support-a"]);
		const quarantinedLesson = lesson("lesson-quarantine", ["support-a", "support-b"]);
		const validPrefixProposal = proposal("proposal-prefix", data.input, [validPrefixLesson]);
		const quarantinedProposal = proposal("proposal-quarantine", data.input, [quarantinedLesson]);
		const inventedProposal = proposal("proposal-invented", data.input, [validPrefixLesson], "Invented rule", {
			supportingEvidenceIds: ["invented-evidence"],
		});
		const input = validationInput(
			data,
			[validPrefixLesson, quarantinedLesson],
			[validPrefixProposal, quarantinedProposal, inventedProposal],
		);
		const report = await new DeterministicProposalRanker({ version: "1" }, { minimumIndependentTasks: 1 }).validate(
			input,
		);

		expect(report.proposalResults).toEqual([
			expect.objectContaining({ proposalId: "proposal-prefix", disposition: "accepted" }),
			expect.objectContaining({
				proposalId: "proposal-quarantine",
				disposition: "quarantined",
				reasonCodes: expect.arrayContaining(["evidence-quarantined"]),
			}),
			expect.objectContaining({
				proposalId: "proposal-invented",
				disposition: "rejected",
				reasonCodes: expect.arrayContaining(["evidence-closure-invalid", "evidence-unverifiable"]),
			}),
		]);
	});

	it("deduplicates task lineages and allows one direct user instruction", async () => {
		const data = fixture([
			{ evidenceId: "repeat-a", lineageId: "same-task" },
			{ evidenceId: "repeat-b", lineageId: "same-task" },
			{ evidenceId: "user-direct", lineageId: "direct-task", role: "user" },
		]);
		const repeatedLesson = lesson("lesson-repeat", ["repeat-a", "repeat-b"]);
		const directLesson = lesson("lesson-direct", ["user-direct"]);
		const proposals = [
			proposal("proposal-repeat", data.input, [repeatedLesson]),
			proposal("proposal-direct", data.input, [directLesson]),
		];
		const report = await new DeterministicProposalRanker({ version: "1" }).validate(
			validationInput(data, [repeatedLesson, directLesson], proposals),
		);

		expect(report.proposalResults).toEqual([
			expect.objectContaining({
				proposalId: "proposal-repeat",
				disposition: "rejected",
				reasonCodes: expect.arrayContaining(["insufficient-independent-support"]),
			}),
			expect.objectContaining({ proposalId: "proposal-direct", disposition: "accepted" }),
		]);
	});

	it("rejects stale instructions, duplicate text, and unresolved strong counterevidence", async () => {
		const data = fixture([
			{ evidenceId: "support-a", lineageId: "task-a", role: "assistant" },
			{ evidenceId: "support-b", lineageId: "task-b", role: "assistant" },
			{ evidenceId: "counter-a", lineageId: "counter-task", role: "user" },
		]);
		const contradictoryLesson = lesson("lesson-1", ["support-a", "support-b"], ["counter-a"]);
		const duplicate = proposal("proposal-duplicate", data.input, [contradictoryLesson], "evolution   MEMORY");
		const staleInstructions: InstructionSnapshot = {
			...data.instructions,
			documents: data.instructions.documents.map((document) => ({ ...document, content: "Changed guidance.\n" })),
		};
		const input = validationInput({ ...data, instructions: staleInstructions }, [contradictoryLesson], [duplicate]);
		const report = await new DeterministicProposalRanker({ version: "1" }).validate(input);

		expect(report.proposalResults[0]).toMatchObject({
			disposition: "rejected",
			reasonCodes: expect.arrayContaining([
				"instruction-snapshot-stale",
				"duplicate-content-normalized",
				"counterevidence-not-resolved",
			]),
		});
	});

	it("selects at most five compatible eligible fingerprints without filling below threshold", async () => {
		const data = fixture([
			{ evidenceId: "support-a", lineageId: "task-a" },
			{ evidenceId: "support-b", lineageId: "task-b" },
		]);
		const lessons = [lesson("lesson-1", ["support-a", "support-b"])];
		const proposals = Array.from({ length: 7 }, (_, index) =>
			proposal(`proposal-${String(index).padStart(2, "0")}`, data.input, lessons, `Distinct rule ${index}`),
		);
		const duplicate = proposal("proposal-duplicate", data.input, lessons, "Distinct rule 0");
		const ranker = new DeterministicProposalRanker({ version: "1" });
		const result = await validateAndScore(ranker, validationInput(data, lessons, [...proposals, duplicate]));

		expect(result.scored.filter((item) => item.disposition === "selected")).toHaveLength(5);
		expect(result.scored.find((item) => item.proposal.proposalId === "proposal-duplicate")).toMatchObject({
			disposition: "superseded",
			reasonCodes: ["exact-proposal-fingerprint-collapsed"],
		});
		expect(result.scored.filter((item) => item.disposition === "unselected")).toHaveLength(2);

		const strict = new DeterministicProposalRanker({ version: "1" }, { eligibilityThreshold: 100 });
		const belowThreshold = await validateAndScore(
			strict,
			validationInput(data, lessons, [proposals[0] as EvolutionMemoryProposal]),
		);
		expect(belowThreshold.scored[0]).toMatchObject({
			disposition: "unselected",
			reasonCodes: ["below-eligibility-threshold"],
		});
	});
});
