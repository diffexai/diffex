import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	createEvolutionArtifactMetadata,
	createSkillCuratorOutputSchema,
	type EvidenceCorpusManifest,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionInputSnapshot,
	type EvolutionLedgerEvent,
	type EvolutionMemoryProposal,
	type EvolutionModelRequest,
	type EvolutionSkillContentArtifact,
	type JsonObject,
	type Lesson,
	type ReflectionResult,
	type ScoredProposal,
	type SkillCuratorInput,
	StructuredSkillCurator,
} from "../src/index.ts";
import { findUnsupportedCodexSchemaKeywords } from "./structured-output-schema.ts";

const FIRST_HARNESS_VERSION = `sha256:${"1".repeat(64)}`;
const SECOND_HARNESS_VERSION = `sha256:${"2".repeat(64)}`;
const MODEL_CONFIGURATION_DIGEST = `sha256:${"4".repeat(64)}`;
const createdAt = "2026-08-25T12:00:00.000Z";
const scope = { repositoryId: "diffex", scopeId: "repository" } as const;
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1",
	promptVersion: null,
	model: null,
};

function metadata(artifactId: string, sourceIds: readonly string[], content: unknown) {
	return createEvolutionArtifactMetadata({ artifactId, producer, sourceIds, scope, createdAt, content });
}

function sessionEvidence(
	evidenceId: string,
	position: number,
	role: "assistant" | "toolResult" | "user",
): MaterializedEvidence {
	const payload =
		role === "toolResult"
			? {
					type: "message" as const,
					id: `entry-${position}`,
					message: {
						role: "toolResult" as const,
						toolCallId: "call-1",
						toolName: "test",
						content: [{ type: "text" as const, text: evidenceId }],
						isError: false,
						timestamp: Date.parse(createdAt) + position,
					},
				}
			: {
					type: "message" as const,
					id: `entry-${position}`,
					message: { role, content: evidenceId },
				};
	return {
		kind: "session_item",
		evidenceId,
		itemType: "message",
		payload,
		order: {
			traceSequence: position + 1,
			timestamp: new Date(Date.parse(createdAt) + position).toISOString(),
			sessionPosition: position,
			parentSpanId: null,
			causalIdentifiers: [{ name: "diffex.task.lineage.id", value: "task-lineage-1" }],
			ambiguity: [],
		},
		traceSources: [],
		sessionSource: {
			bindingId: "binding-1",
			sessionId: "session-1",
			path: "/private/session.jsonl",
			sessionFormat: "coding-agent-v3",
			formatVersion: 3,
			segmentTraceSequences: [position + 1],
			entryId: `entry-${position}`,
			entryOrdinal: position,
		},
	};
}

function invocation(): MaterializedInvocation {
	return {
		version: 1,
		tracePath: "/private/trace.jsonl",
		traceId: "trace-1",
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
		evidence: [sessionEvidence("support-1", 0, "assistant"), sessionEvidence("failure-1", 1, "toolResult")],
		diagnostics: [],
	};
}

function skillArtifact(): {
	readonly artifact: EvolutionSkillContentArtifact;
	readonly reference: EvolutionArtifactReference;
} {
	const content = "---\nname: existing-skill\ndescription: Existing workflow\n---\n\nRun the existing workflow.\n";
	const skill = {
		skillId: "installed:workspace:existing-skill",
		name: "existing-skill",
		description: "Existing workflow",
		sourceKind: "installed" as const,
		scope: "workspace" as const,
		source: "project-resource",
		version: computeEvolutionTextDigest(content),
		contentDigest: computeEvolutionTextDigest(content),
		workspace: { repositoryId: "diffex", directoryId: "directory-1" },
		location: "/repo/.agents/skills/existing-skill/SKILL.md",
		baseDir: "/repo/.agents/skills/existing-skill",
		disableModelInvocation: false,
		content,
	};
	const artifactContent = { artifactKind: "skill-content" as const, skill };
	const artifact: EvolutionSkillContentArtifact = {
		metadata: metadata("skill-content-1", [], artifactContent),
		...artifactContent,
	};
	return {
		artifact,
		reference: { artifactId: artifact.metadata.artifactId, contentDigest: computeEvolutionContentDigest(artifact) },
	};
}

class FixtureArtifactStore implements EvolutionArtifactStore {
	readonly #artifacts: ReadonlyMap<string, EvolutionArtifact>;

	constructor(
		entries: readonly { readonly reference: EvolutionArtifactReference; readonly artifact: EvolutionArtifact }[],
	) {
		this.#artifacts = new Map(entries.map((entry) => [entry.reference.contentDigest, entry.artifact]));
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		return { artifactId: artifact.metadata.artifactId, contentDigest: computeEvolutionContentDigest(artifact) };
	}

	async get(reference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.#artifacts.get(reference.contentDigest);
		if (artifact === undefined || artifact.metadata.artifactId !== reference.artifactId) {
			throw new Error("Unknown artifact");
		}
		return artifact;
	}
}

function fixtureInput(skillReference: EvolutionArtifactReference): EvolutionInputSnapshot {
	const materialized = invocation();
	const source = {
		sourceId: "source-1",
		materializationId: "materialization-1",
		ingestionCursor: 1,
		origin: "product-runtime" as const,
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
	const memory = "# Evolution memory\n\n- Verify repository changes.\n";
	const skill = skillArtifact().artifact.skill;
	return {
		metadata: metadata("input-1", [source.sourceId, skillReference.artifactId], { sourceId: source.sourceId }),
		trigger: "manual",
		repository: {
			repositoryId: "diffex",
			directoryId: "directory-1",
			rootPath: "/repo",
			revision: "current-revision",
		},
		harness: {
			harnessVersion: SECOND_HARNESS_VERSION,
			baseVersion: FIRST_HARNESS_VERSION,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [],
		},
		expectedHarnessBaseVersion: SECOND_HARNESS_VERSION,
		ingestionHighWaterCursor: 1,
		instructions: [],
		skillCatalog: [
			{
				skillId: skill.skillId,
				name: skill.name,
				description: skill.description,
				sourceKind: skill.sourceKind,
				scope: skill.scope,
				source: skill.source,
				version: skill.version,
				contentDigest: skill.contentDigest,
				workspace: skill.workspace,
				disableModelInvocation: skill.disableModelInvocation,
				contentArtifact: skillReference,
			},
		],
		modelConfiguration: {
			provider: "faux",
			model: "fixture",
			configurationDigest: MODEL_CONFIGURATION_DIGEST,
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

function lesson(): Lesson {
	const content = { lessonId: "lesson-final", summary: "Recover after a failed verification command" };
	return {
		metadata: metadata("lesson-final", ["support-1", "failure-1"], content),
		lessonId: "lesson-final",
		kind: "failure-workaround",
		summary: "Recover after a failed verification command",
		preconditions: ["The repository has a focused verification command"],
		observedOutcome: "The corrected command verified the change",
		evidenceIds: ["support-1"],
		counterevidenceIds: ["failure-1"],
		scope,
		applicabilityBoundaries: ["Repositories with deterministic verification"],
		uncertainty: null,
		actionableTakeaway: "Inspect the failure signal, correct the command, and rerun verification",
	};
}

function reflection(): ReflectionResult {
	const finalLesson = lesson();
	return {
		nodes: [],
		lessons: [finalLesson],
		coverage: {
			metadata: metadata("coverage-1", ["source-1"], { finalLessonIds: [finalLesson.lessonId] }),
			manifestDigest: "corpus-digest",
			entries: [],
			rootNodeIds: [],
			finalLessonIds: [finalLesson.lessonId],
		},
		finalLessonIds: [finalLesson.lessonId],
	};
}

function corpus(): EvidenceCorpusManifest {
	return {
		metadata: metadata("corpus-1", ["source-1"], { documents: ["document-1"] }),
		documents: [
			{
				documentId: "document-1",
				sourceId: "source-1",
				materializationId: "materialization-1",
				contentDigest: "source-digest",
				materializedInvocationVersion: 1,
				traceId: "trace-1",
				integrity: "complete",
				terminationStatus: "completed",
				evidenceIds: ["support-1", "failure-1"],
				semanticUnits: [],
				diagnostics: [],
				orderingAmbiguity: [],
			},
		],
		excludedSources: [],
	};
}

function selectedMemoryProposal(input: EvolutionInputSnapshot): ScoredProposal {
	const proposalContent = { proposalId: "proposal-1", action: "ADD" };
	const proposal: EvolutionMemoryProposal = {
		metadata: metadata("proposal-1", ["lesson-final"], proposalContent),
		proposalId: "proposal-1",
		scope: {
			repository: scope,
			repositoryRevision: input.repository.revision,
			materializationIds: ["materialization-1"],
			traceIds: ["trace-1"],
			sessionIds: ["session-1"],
			taskLineageIds: ["task-lineage-1"],
			runtimeKinds: ["node"],
			runtimeVersions: ["24.0.0"],
			sourceRevisions: ["revision-1"],
			harnessVersions: [],
			applicabilityBoundaries: ["Repositories with deterministic verification"],
		},
		lessonIds: ["lesson-final"],
		supportingEvidenceIds: ["support-1"],
		contradictingEvidenceIds: ["failure-1"],
		supportingTraceIds: ["trace-1"],
		contradictingTraceIds: ["trace-1"],
		expectedBenefit: "Make verification explicit",
		acceptanceCriterion: "The memory names the verification requirement",
		risk: "Low",
		rollbackDescription: "Select the parent harness",
		curatorConfidence: 0.9,
		uncertainty: null,
		counterexamples: [],
		conflictingProposalIds: [],
		instructionRelationship: { classification: "novel", relevantEntries: [], strengthening: null },
		disposition: "actionable",
		target: { kind: "evolution-memory", expectedHarnessVersion: input.expectedHarnessBaseVersion },
		action: "ADD",
		exactDelta: {
			operation: "ADD",
			destination: { section: null, anchor: null },
			content: "Verify repository changes.",
			intendedScope: ["Repository changes"],
		},
		expectedBaseDigest: input.harness.memoryContentDigest,
	};
	return {
		metadata: metadata("scored-1", [proposal.proposalId], { proposalId: proposal.proposalId }),
		proposal,
		scorerVersion: "ranker-v1",
		evidenceRankingScore: 0.9,
		scoreComponents: {
			recurrence: 1,
			provenanceIntegrity: 1,
			sourceSignalStrength: 1,
			scopeCoverage: 1,
			curatorConfidence: 0.9,
			proposalCompleteness: 1,
			contradictionPenalty: 0,
		},
		disposition: "selected",
		reasonCodes: [],
	};
}

function candidateOutput(): JsonObject {
	return {
		decisions: [
			{
				decisionKey: "verification-recovery",
				lessonRefs: ["L1"],
				existingSkillRefs: ["K1"],
				skillability: {
					classification: "troubleshooting-recovery",
					rationale: "The evidence connects an observable failure to a repeatable recovery and check.",
				},
				memoryRelationship: {
					classification: "complements",
					memoryProposalRefs: ["P1"],
					rationale: "Memory keeps the invariant while the skill preserves the recovery procedure.",
				},
				disposition: "candidate",
				candidate: {
					operation: "UPDATE",
					proposedName: "verification-recovery",
					triggerDescription: "A repository verification command fails or produces an ambiguous result.",
					positiveTriggers: ["A focused test command exits nonzero after a code change."],
					negativeTriggers: ["The task only asks for an explanation and changes no files."],
					preconditions: ["A deterministic verification command is available."],
					procedureSteps: [
						{ action: "Run the focused verification command.", condition: null },
						{ action: "Inspect the first actionable failure signal.", condition: "The command fails." },
						{ action: "Apply the evidence-supported correction and rerun verification.", condition: null },
					],
					requiredTools: ["shell"],
					environment: ["Repository checkout"],
					failureHandling: [
						{
							signal: "The focused command exits nonzero.",
							mitigation: "Use the first deterministic diagnostic instead of guessing.",
							recovery: "Correct the failing command or implementation and rerun it.",
						},
					],
					applicabilityBoundaries: ["Only use deterministic project verification commands."],
					verificationChecks: ["The focused command exits successfully."],
					completionCondition: "The original verification command passes without suppressing failures.",
				},
				deferredReason: null,
			},
		],
		proceduralInformationLosses: [],
	};
}

function curatorInput(
	execute: SkillCuratorInput["model"]["execute"],
	input: EvolutionInputSnapshot,
): SkillCuratorInput {
	return {
		jobId: "job-1",
		input,
		corpus: corpus(),
		reflection: reflection(),
		selectedMemoryProposals: [selectedMemoryProposal(input)],
		model: { maxProviderCallsPerExecution: 20, execute },
		idempotencyKey: "job-1:skill-curating",
	};
}

describe("StructuredSkillCurator", () => {
	it("emits a frozen non-executable candidate after bounded evidence and skill inspection", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const ledger: EvolutionLedgerEvent[] = [];
		let requestInput: JsonObject | null = null;
		const curator = new StructuredSkillCurator({
			version: "1",
			artifacts,
			ledger: { append: async (event) => void ledger.push(event), read: async () => ledger },
		});
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async (request: EvolutionModelRequest) => {
				requestInput = request.input;
				expect(request.stage).toBe("skill-curator");
				expect(request.idempotencyKey).toBe("job-1:skill-curating");
				const evidenceTool = request.tools.find((tool) => tool.name === "inspect_source_evidence");
				const skillTool = request.tools.find((tool) => tool.name === "inspect_skills");
				expect(await evidenceTool?.execute({ evidenceRefs: ["E1"], contextAfter: 1 })).toMatchObject({
					evidence: [
						{ evidenceRef: "E1", traceId: "trace-1" },
						{ evidenceRef: "E2", traceId: "trace-1" },
					],
				});
				expect(await skillTool?.execute({ skillRefs: ["K1"] })).toMatchObject({
					skills: [
						{ skillId: "installed:workspace:existing-skill", content: expect.stringContaining("workflow") },
					],
				});
				const output = candidateOutput();
				expect(Check(request.outputSchema as TSchema, output)).toBe(true);
				request.validateOutput?.(output);
				return {
					output,
					submissionMethod: "response-tool",
					model: { provider: "faux", model: "fixture" },
				};
			}, input),
		);

		expect(requestInput).toMatchObject({
			control: { globalEvolvedSkillTargetPermitted: false, candidateContainsNoExecutableWriterPayload: true },
			lessons: [{ lessonRef: "L1", evidenceRefs: ["E1"], counterevidenceRefs: ["E2"] }],
			selectedMemoryProposals: [{ memoryProposalRef: "P1", proposalId: "proposal-1" }],
			frozenEvolutionMemory: { content: input.harness.memory },
			skillCatalog: [{ skillRef: "K1", skillId: "installed:workspace:existing-skill" }],
		});
		expect(result.deferredFindings).toEqual([]);
		expect(result.proceduralInformationLossFindings).toEqual([]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			artifactKind: "skill-candidate",
			operation: "UPDATE",
			workspace: {
				repositoryId: "diffex",
				directoryId: "directory-1",
				rootPath: "/repo",
				repositoryRevision: "current-revision",
				evolutionScope: scope,
			},
			existingSkillIds: ["installed:workspace:existing-skill"],
			sourceLessonIds: ["lesson-final"],
			sourceProceduralObservationIds: [],
			supportingEvidenceIds: ["support-1"],
			contradictingEvidenceIds: ["failure-1"],
			supportingTraceIds: ["trace-1"],
			contradictingTraceIds: ["trace-1"],
			taskLineageIds: ["task-lineage-1"],
			memoryRelationship: { classification: "complements", memoryProposalIds: ["proposal-1"] },
		});
		expect(JSON.stringify(result.candidates[0])).not.toContain("exactDelta");
		expect(ledger.map((event) => event.type)).toEqual(["skill-curator-tool-call", "skill-curator-tool-call"]);
	});

	it("preserves redundant guidance as a deferred finding", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator({ version: "1", artifacts });
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async (request) => {
				const output: JsonObject = {
					decisions: [
						{
							decisionKey: "memory-already-covers-guidance",
							lessonRefs: ["L1"],
							existingSkillRefs: [],
							skillability: {
								classification: "verification-routine",
								rationale: "The lesson describes a repeatable verification routine.",
							},
							memoryRelationship: {
								classification: "redundant",
								memoryProposalRefs: ["P1"],
								rationale: "The selected memory proposal already contains the complete routine.",
							},
							disposition: "deferred",
							candidate: null,
							deferredReason: "No distinct procedural content remains for a skill.",
						},
					],
					proceduralInformationLosses: [],
				};
				request.validateOutput?.(output);
				return { output, model: { provider: "faux", model: "fixture" } };
			}, input),
		);

		expect(result.candidates).toEqual([]);
		expect(result.deferredFindings).toMatchObject([
			{
				artifactKind: "skill-candidate-finding",
				disposition: "deferred",
				sourceLessonIds: ["lesson-final"],
				skillability: { classification: "verification-routine" },
				memoryRelationship: { classification: "redundant", memoryProposalIds: ["proposal-1"] },
			},
		]);
	});

	it("persists evidence-grounded procedural information loss without emitting a candidate", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator({ version: "1", artifacts });
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async (request) => {
				const evidenceTool = request.tools.find((tool) => tool.name === "inspect_source_evidence");
				await evidenceTool?.execute({ evidenceRefs: ["E1"], contextAfter: 1 });
				const output: JsonObject = {
					decisions: [],
					proceduralInformationLosses: [
						{
							lossKey: "missing-recovery-order",
							lessonRefs: ["L1"],
							missing: ["action-order", "mitigation-or-recovery"],
							supportingEvidenceRefs: ["E1"],
							explanation:
								"The evidence contains the recovery order, but the final lesson retains only the conclusion.",
						},
					],
				};
				request.validateOutput?.(output);
				return { output, model: { provider: "faux", model: "fixture" } };
			}, input),
		);

		expect(result.candidates).toEqual([]);
		expect(result.proceduralInformationLossFindings).toMatchObject([
			{
				artifactKind: "procedural-information-loss",
				detectedBy: "skill-curator",
				sourceLessonIds: ["lesson-final"],
				loss: {
					missing: ["action-order", "mitigation-or-recovery"],
					supportingEvidenceIds: ["support-1"],
				},
			},
		]);
		expect(result.proceduralInformationLossFindings[0]?.metadata.sourceIds).toEqual(["lesson-final", "support-1"]);
	});

	it("rejects references to skill content that was not inspected", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator({ version: "1", artifacts }, { maxResponseAttempts: 1 });
		const input = fixtureInput(storedSkill.reference);

		await expect(
			curator.curate(
				curatorInput(
					async () => ({ output: candidateOutput(), model: { provider: "faux", model: "fixture" } }),
					input,
				),
			),
		).rejects.toMatchObject({
			name: "EvolutionExecutionError",
			reasonCode: "skill-curation-invalid-response",
			retryable: false,
		});
	});

	it("uses a strict Codex-compatible output schema", () => {
		const schema = createSkillCuratorOutputSchema({
			evidenceRefs: ["E1"],
			lessonRefs: ["L1"],
			memoryProposalRefs: ["P1"],
			skillRefs: ["K1"],
		});
		expect(findUnsupportedCodexSchemaKeywords(schema)).toEqual([]);
		expect(Check(schema as TSchema, candidateOutput())).toBe(true);
	});
});
