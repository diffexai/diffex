import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	createEvolutionArtifactMetadata,
	createSkillCandidateProcedureDraftOutputSchema,
	createSkillCuratorOutputSchema,
	type EvidenceCorpusManifest,
	type EvolutionArtifact,
	type EvolutionArtifactProducer,
	type EvolutionArtifactReference,
	type EvolutionArtifactStore,
	type EvolutionInputSnapshot,
	type EvolutionLedger,
	type EvolutionLedgerEvent,
	type EvolutionMemoryProposal,
	type EvolutionModelRequest,
	type EvolutionScope,
	type EvolutionSkillContentArtifact,
	type JsonObject,
	type Lesson,
	measureEvolutionValue,
	PersistentSkillCandidateRegistry,
	type ReflectionResult,
	type ScoredProposal,
	SKILL_CANDIDATE_CAPSULE_MAX_ESTIMATED_TOKENS,
	SKILL_CANDIDATE_CAPSULE_MAX_SERIALIZED_BYTES,
	type SkillCandidateExpansionFailed,
	type SkillCandidateExpansionOutcome,
	type SkillCandidateOutline,
	type SkillCandidateProcedureDraft,
	type SkillCandidateRegistry,
	type SkillCandidateRegistryAppendResult,
	type SkillCandidateRegistryConsolidationInput,
	type SkillCandidateRegistryEvent,
	type SkillCandidateRegistrySnapshot,
	type SkillCandidateRegistryStore,
	type SkillCurationResult,
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
	readonly #artifacts: Map<string, EvolutionArtifact>;

	constructor(
		entries: readonly { readonly reference: EvolutionArtifactReference; readonly artifact: EvolutionArtifact }[],
	) {
		this.#artifacts = new Map(entries.map((entry) => [entry.reference.contentDigest, entry.artifact]));
	}

	async put(artifact: EvolutionArtifact): Promise<EvolutionArtifactReference> {
		const reference = {
			artifactId: artifact.metadata.artifactId,
			contentDigest: computeEvolutionContentDigest(artifact),
		};
		this.#artifacts.set(reference.contentDigest, artifact);
		return reference;
	}

	async get(reference: EvolutionArtifactReference): Promise<EvolutionArtifact> {
		const artifact = this.#artifacts.get(reference.contentDigest);
		if (artifact === undefined || artifact.metadata.artifactId !== reference.artifactId) {
			throw new Error("Unknown artifact");
		}
		return artifact;
	}
}

function memoryLedger(events: EvolutionLedgerEvent[] = []): EvolutionLedger {
	return {
		async append(event) {
			const existing = events.find((candidate) => candidate.eventId === event.eventId);
			if (existing === undefined) events.push(event);
			else if (computeEvolutionContentDigest(existing) !== computeEvolutionContentDigest(event)) {
				throw new Error("Ledger event identity conflict");
			}
		},
		async read() {
			return events;
		},
	};
}

class MemoryCandidateRegistryStore implements SkillCandidateRegistryStore {
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

function candidateRegistry(
	registrations: SkillCandidateRegistryConsolidationInput[] = [],
): Pick<SkillCandidateRegistry, "consolidate"> {
	return {
		async consolidate(input) {
			registrations.push(input);
			return { groups: [], changedGroupIds: [] };
		},
	};
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
		tokenMeasurement: { counterVersion: "fixture", inputTokens: 80, outputTokens: 20, totalTokens: 100 },
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

function outlineOutput(): JsonObject {
	return {
		outlines: [
			{
				outlineKey: "verification-recovery",
				lessonRefs: ["L1"],
				operation: "UPDATE",
				proposedName: "verification-recovery",
				existingSkillRefs: ["K1"],
				skillability: { classification: "troubleshooting-recovery" },
				memoryRelationship: { classification: "complements", memoryProposalRefs: ["P1"] },
			},
		],
	};
}

function procedureOutput(positiveTrigger = "A focused test command exits nonzero after a code change."): JsonObject {
	return {
		trigger: {
			description: "A repository verification command fails or produces an ambiguous result.",
			positiveExamples: [positiveTrigger],
			negativeExamples: ["The task only asks for an explanation and changes no files."],
		},
		steps: [
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
		additionalPreconditions: ["A deterministic verification command is available."],
		additionalApplicabilityBoundaries: ["Only use deterministic project verification commands."],
		verificationChecks: ["The focused command exits successfully."],
		completionCondition: "The original verification command passes without suppressing failures.",
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
		const registrations: SkillCandidateRegistryConsolidationInput[] = [];
		let discoveryInput: JsonObject | null = null;
		let procedureInput: JsonObject | null = null;
		const curator = new StructuredSkillCurator({
			version: "1",
			artifacts,
			ledger: memoryLedger(ledger),
			registry: candidateRegistry(registrations),
		});
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async (request: EvolutionModelRequest) => {
				expect(request.stage).toBe("skill-curator");
				const phase = (request.input.control as JsonObject).phase;
				if (phase === "outline-discovery") {
					discoveryInput = request.input;
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
					const output = outlineOutput();
					expect(Check(request.outputSchema as TSchema, output)).toBe(true);
					request.validateOutput?.(output);
					return {
						output,
						submissionMethod: "response-tool",
						model: { provider: "faux", model: "fixture" },
					};
				}
				procedureInput = request.input;
				expect(request.idempotencyKey).toMatch(/^skill-candidate-expansion-/);
				const output = procedureOutput();
				expect(Check(request.outputSchema as TSchema, output)).toBe(true);
				request.validateOutput?.(output);
				return { output, submissionMethod: "response-tool", model: { provider: "faux", model: "fixture" } };
			}, input),
		);

		expect(discoveryInput).toMatchObject({
			control: {
				phase: "outline-discovery",
				globalEvolvedSkillTargetPermitted: false,
				doNotAuthorProcedureMaterial: true,
				omitDeferredDecisions: true,
				omitProceduralInformationLossDiagnostics: true,
				proceduralWorkflowsBelongInSkills: ["ordered-setup", "tool-use", "debugging", "recovery", "verification"],
				doNotProposeMemoryPointersToSkills: true,
				memoryRemovalOrReplacementRequiresExplicitProposal: true,
				memoryRelationshipSemantics: {
					complements: expect.stringContaining("independently useful"),
					"fallback-until-activation": expect.stringContaining("explicit memory proposal"),
					supersedes: expect.stringContaining("memory remains unchanged"),
				},
			},
			lessons: [{ lessonRef: "L1", evidenceRefs: ["E1"], counterevidenceRefs: ["E2"] }],
			selectedMemoryProposals: [{ memoryProposalRef: "P1", proposalId: "proposal-1" }],
			frozenEvolutionMemory: { content: input.harness.memory },
			skillCatalog: [{ skillRef: "K1", skillId: "installed:workspace:existing-skill" }],
		});
		expect(procedureInput).toMatchObject({
			control: {
				phase: "procedure-generation",
				returnOnlyNonDerivableProcedureMaterial: true,
				doNotRepeatIdentityScopeEvidenceProvenanceOrLessonMaterial: true,
			},
			acceptedOutline: {
				outlineKey: "verification-recovery",
				lessonRefs: ["L1"],
			},
		});
		expect(result.outlineSet).toMatchObject({
			artifactKind: "skill-candidate-outline-set",
			sourceEvolutionJobId: "job-1",
			discoveryIdempotencyKey: "job-1:skill-curating",
			inputSnapshotId: "input-1",
			inputSnapshotContentDigest: input.metadata.contentDigest,
			outlines: [
				{
					outlineId: expect.stringMatching(/^skill-candidate-outline-/),
					outlineKey: "verification-recovery",
					sourceLessonIds: ["lesson-final"],
					existingSkillIds: ["installed:workspace:existing-skill"],
					memoryRelationship: { classification: "complements", memoryProposalIds: ["proposal-1"] },
				},
			],
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
			provenanceBindings: [
				{
					sourceLessonId: "lesson-final",
					supportingEvidenceIds: ["support-1"],
					contradictingEvidenceIds: ["failure-1"],
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
					],
				},
			],
			supportingEvidenceIds: ["support-1"],
			contradictingEvidenceIds: ["failure-1"],
			supportingTraceIds: ["trace-1"],
			contradictingTraceIds: ["trace-1"],
			taskLineageIds: ["task-lineage-1"],
			memoryRelationship: { classification: "complements", memoryProposalIds: ["proposal-1"] },
		});
		const candidate = result.candidates[0];
		expect(candidate).toBeDefined();
		if (candidate === undefined) throw new Error("Expected a candidate");
		const { metadata: _metadata, ...capsule } = candidate;
		expect(measureEvolutionValue(capsule)).toEqual({
			serializedBytes: candidate.capsuleSize.serializedBytes,
			estimatedTokens: candidate.capsuleSize.estimatedTokens,
		});
		expect(candidate.capsuleSize.serializedBytes).toBeLessThanOrEqual(SKILL_CANDIDATE_CAPSULE_MAX_SERIALIZED_BYTES);
		expect(candidate.capsuleSize.estimatedTokens).toBeLessThanOrEqual(SKILL_CANDIDATE_CAPSULE_MAX_ESTIMATED_TOKENS);
		expect(JSON.stringify(candidate)).not.toContain("exactDelta");
		expect(JSON.stringify(candidate)).not.toContain("sourceProceduralObservationIds");
		expect(result.status).toBe("completed");
		expect(result.failedExpansions).toEqual([]);

		const outline = {
			outlineId: "skill-candidate-outline-1",
			outlineKey: "verification-recovery",
			sourceLessonIds: ["lesson-final"],
			operation: "UPDATE",
			proposedName: "verification-recovery",
			existingSkillIds: ["installed:workspace:existing-skill"],
			skillability: { classification: "troubleshooting-recovery" },
			memoryRelationship: { classification: "complements", memoryProposalIds: ["proposal-1"] },
		} satisfies SkillCandidateOutline;
		const procedureDraft = {
			trigger: candidate.trigger,
			steps: candidate.procedure.steps.map(({ action, condition }) => ({ action, condition })),
			requiredTools: candidate.procedure.requiredTools,
			environment: candidate.procedure.environment,
			failureHandling: candidate.failureHandling,
			additionalPreconditions: ["A deterministic verification command is available."],
			additionalApplicabilityBoundaries: ["Only use deterministic project verification commands."],
			verificationChecks: candidate.verificationContract.checks,
			completionCondition: candidate.verificationContract.completionCondition,
		} satisfies SkillCandidateProcedureDraft;
		const failedExpansion = {
			status: "failed",
			outlineId: outline.outlineId,
			outlineKey: outline.outlineKey,
			diagnostic: {
				reasonCode: "procedure-draft-invalid",
				message: "Procedure draft validation failed after two attempts.",
				attempts: [
					{
						attempt: 1,
						modelRounds: 1,
						reasonCode: "procedure-draft-invalid",
						message: "Missing completion condition.",
						inspectedReferences: { evidenceIds: ["support-1"], skillIds: [] },
						invalidFieldPaths: ["verificationContract.completionCondition"],
					},
					{
						attempt: 2,
						modelRounds: 1,
						reasonCode: "procedure-draft-invalid",
						message: "Missing verification checks.",
						inspectedReferences: { evidenceIds: ["support-1"], skillIds: [] },
						invalidFieldPaths: ["verificationContract.checks"],
					},
				],
			},
		} satisfies SkillCandidateExpansionFailed;
		const expansionOutcomes: readonly SkillCandidateExpansionOutcome[] = [
			{
				status: "succeeded",
				outlineId: outline.outlineId,
				outlineKey: outline.outlineKey,
				attemptCount: 1,
				candidate,
			},
			failedExpansion,
		];
		const partialResult = {
			status: "completed-with-some-failures",
			outlineSet: result.outlineSet,
			candidates: [candidate],
			failedExpansions: [failedExpansion],
			deferredFindings: [],
			proceduralInformationLossFindings: [],
		} satisfies SkillCurationResult;
		expect({ outline, procedureDraft, expansionOutcomes, partialResult }).toMatchObject({
			expansionOutcomes: [{ status: "succeeded" }, { status: "failed" }],
			partialResult: { status: "completed-with-some-failures" },
		});
		expect(registrations).toMatchObject([
			{
				sourceEvolutionJobId: "job-1",
				candidates: [{ candidate: { candidateId: candidate.candidateId } }],
			},
		]);
		expect(ledger.map((event) => event.type)).toEqual([
			"skill-curator-tool-call",
			"skill-curator-tool-call",
			"skill-candidate-outlines-checkpointed",
			"skill-candidate-expansion-succeeded",
		]);
	});

	it("expands outlines independently with bounded concurrency and one fresh retry", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const ledger: EvolutionLedgerEvent[] = [];
		const registrations: SkillCandidateRegistryConsolidationInput[] = [];
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(ledger),
				registry: candidateRegistry(registrations),
			},
			{ maxConcurrentExpansions: 2 },
		);
		const fixture = fixtureInput(storedSkill.reference);
		const input: EvolutionInputSnapshot = {
			...fixture,
			instructions: [
				{
					path: "/repo/AGENTS.md",
					precedence: 1,
					content: "Run focused verification after source changes.",
					contentDigest: computeEvolutionTextDigest("Run focused verification after source changes."),
				},
			],
		};
		const baseOutline = (outlineOutput().outlines as readonly JsonObject[])[0];
		if (baseOutline === undefined) throw new Error("Expected an outline fixture");
		const outlines = {
			outlines: [
				{ ...baseOutline, outlineKey: "alpha", proposedName: "alpha-verification" },
				{ ...baseOutline, outlineKey: "beta", proposedName: "beta-verification" },
				{ ...baseOutline, outlineKey: "gamma", proposedName: "gamma-verification" },
			],
		};
		const calls = new Map<string, number>();
		const requestInputs = new Map<string, JsonObject[]>();
		const idempotencyKeys = new Map<string, string[]>();
		let active = 0;
		let maxActive = 0;
		const result = await curator.curate(
			curatorInput(async (request) => {
				if ((request.input.control as JsonObject).phase === "outline-discovery") {
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output: outlines, model: { provider: "faux", model: "fixture" } };
				}
				if (request.stage !== "skill-curator") throw new Error("Expected a skill curator request");
				const acceptedOutline = request.input.acceptedOutline as JsonObject;
				const outlineKey = acceptedOutline.outlineKey as string;
				const attempt = (calls.get(outlineKey) ?? 0) + 1;
				calls.set(outlineKey, attempt);
				requestInputs.set(outlineKey, [...(requestInputs.get(outlineKey) ?? []), request.input]);
				idempotencyKeys.set(outlineKey, [...(idempotencyKeys.get(outlineKey) ?? []), request.idempotencyKey]);
				active += 1;
				maxActive = Math.max(maxActive, active);
				try {
					request.onModelRound?.();
					if (outlineKey === "gamma" && attempt === 2) request.onModelRound?.();
					await request.tools
						.find((tool) => tool.name === "inspect_source_evidence")
						?.execute({ evidenceRefs: ["E1"] });
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					await new Promise((resolve) => setTimeout(resolve, 5));
					return {
						output: outlineKey === "alpha" || (outlineKey === "beta" && attempt === 2) ? procedureOutput() : {},
						model: { provider: "faux", model: "fixture" },
					};
				} finally {
					active -= 1;
				}
			}, input),
		);

		expect(maxActive).toBe(2);
		expect(Object.fromEntries(calls)).toEqual({ alpha: 1, beta: 2, gamma: 2 });
		expect(result.status).toBe("completed-with-some-failures");
		expect(result.candidates.map((candidate) => candidate.proposedName)).toEqual([
			"alpha-verification",
			"beta-verification",
		]);
		expect(result.candidates[1]?.preconditions).toEqual([
			"The repository has a focused verification command",
			"A deterministic verification command is available.",
		]);
		expect(result.failedExpansions).toMatchObject([
			{
				status: "failed",
				outlineKey: "gamma",
				diagnostic: {
					reasonCode: "procedure-draft-invalid",
					attempts: [
						{
							attempt: 1,
							modelRounds: 1,
							inspectedReferences: {
								evidenceIds: ["support-1"],
								skillIds: ["installed:workspace:existing-skill"],
							},
						},
						{
							attempt: 2,
							modelRounds: 2,
							inspectedReferences: {
								evidenceIds: ["support-1"],
								skillIds: ["installed:workspace:existing-skill"],
							},
						},
					],
				},
			},
		]);
		const expansionInputs = [...requestInputs.values()].flat();
		expect(expansionInputs).toHaveLength(5);
		for (const expansionInput of expansionInputs) {
			expect(expansionInput).toMatchObject({
				acceptedOutline: { lessonRefs: ["L1"] },
				lessons: [{ lessonRef: "L1" }],
				selectedMemoryProposals: [{ memoryProposalRef: "P1", proposalId: "proposal-1" }],
				repositoryInstructions: [{ path: "/repo/AGENTS.md", content: expect.stringContaining("verification") }],
				skillCatalog: [{ skillRef: "K1", skillId: "installed:workspace:existing-skill" }],
			});
			expect(expansionInput).not.toHaveProperty("acceptedOutlines");
			expect(expansionInput).not.toHaveProperty("frozenEvolutionMemory");
		}
		expect((requestInputs.get("alpha")?.[0]?.control as JsonObject).responseCorrection).toBeUndefined();
		expect((requestInputs.get("beta")?.[1]?.control as JsonObject).responseCorrection).toMatchObject({
			reason: expect.stringContaining("trigger must be an object"),
		});
		expect((requestInputs.get("gamma")?.[0]?.control as JsonObject).responseCorrection).toBeUndefined();
		expect((requestInputs.get("gamma")?.[1]?.control as JsonObject).responseCorrection).toMatchObject({
			reason: expect.stringContaining("trigger must be an object"),
		});
		const expansionKeys = [...idempotencyKeys.values()].flat();
		expect(new Set(expansionKeys).size).toBe(5);
		expect(expansionKeys.every((key) => /^skill-candidate-expansion-/.test(key))).toBe(true);
		expect(registrations.map((registration) => registration.candidates[0]?.candidate.proposedName).sort()).toEqual([
			"alpha-verification",
			"beta-verification",
		]);
		expect(
			ledger.filter(
				(event) =>
					event.type === "skill-candidate-expansion-succeeded" ||
					event.type === "skill-candidate-expansion-failed",
			),
		).toHaveLength(3);
	});

	it("registers assembled successes into one qualified canonical group despite a failed sibling", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const registryStore = new MemoryCandidateRegistryStore();
		const registry = new PersistentSkillCandidateRegistry({ version: "1", artifacts, store: registryStore });
		const baseInput = fixtureInput(storedSkill.reference);
		const source = baseInput.evidenceSources[0];
		if (source === undefined) throw new Error("Expected an evidence source");
		const secondSupport = sessionEvidence("support-2", 2, "assistant");
		const recurringEvidence = [
			source.invocation.evidence[0]!,
			{
				...secondSupport,
				order: {
					...secondSupport.order,
					causalIdentifiers: [{ name: "diffex.task.lineage.id", value: "task-lineage-2" }],
				},
			},
		];
		const recurringInvocation = { ...source.invocation, evidence: recurringEvidence };
		const input: EvolutionInputSnapshot = {
			...baseInput,
			evidenceSources: [
				{
					...source,
					contentDigest: computeEvolutionContentDigest(recurringInvocation),
					invocation: recurringInvocation,
				},
			],
		};
		const recurringLesson: Lesson = {
			...lesson(),
			evidenceIds: ["support-1", "support-2"],
			counterevidenceIds: [],
		};
		const recurringReflection: ReflectionResult = {
			...reflection(),
			lessons: [recurringLesson],
		};
		const recurringCorpus: EvidenceCorpusManifest = {
			...corpus(),
			documents: corpus().documents.map((document) => ({
				...document,
				evidenceIds: ["support-1", "support-2"],
			})),
		};
		const baseOutline = (outlineOutput().outlines as readonly JsonObject[])[0];
		if (baseOutline === undefined) throw new Error("Expected an outline fixture");
		const outlines = {
			outlines: [
				{ ...baseOutline, outlineKey: "alpha", proposedName: "alpha-verification" },
				{ ...baseOutline, outlineKey: "beta", proposedName: "beta-verification" },
				{ ...baseOutline, outlineKey: "gamma", proposedName: "gamma-verification" },
			],
		};
		const result = await new StructuredSkillCurator({
			version: "1",
			artifacts,
			ledger: memoryLedger(),
			registry,
		}).curate({
			...curatorInput(async (request) => {
				if ((request.input.control as JsonObject).phase === "outline-discovery") {
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output: outlines, model: { provider: "faux", model: "fixture" } };
				}
				const outline = request.input.acceptedOutline as JsonObject;
				return {
					output: outline.outlineKey === "gamma" ? {} : procedureOutput(),
					model: { provider: "faux", model: "fixture" },
				};
			}, input),
			corpus: recurringCorpus,
			reflection: recurringReflection,
		});

		expect(result).toMatchObject({
			status: "completed-with-some-failures",
			candidates: [{ proposedName: "alpha-verification" }, { proposedName: "beta-verification" }],
			failedExpansions: [{ outlineKey: "gamma" }],
		});
		const groups = await registry.list(scope);
		expect(groups).toHaveLength(1);
		const group = groups[0];
		if (group?.canonicalCapsule === null || group === undefined) throw new Error("Expected a canonical group");
		expect(group).toMatchObject({
			state: "evidence-qualified",
			evidence: {
				supportingEvidenceIds: ["support-1", "support-2"],
				supportingTaskLineageIds: ["task-lineage-1", "task-lineage-2"],
				contradictingTaskLineageIds: [],
			},
		});
		expect(group.proposalRevisions).toHaveLength(2);
		const capsule = await artifacts.get(group.canonicalCapsule);
		if (!("artifactKind" in capsule) || capsule.artifactKind !== "skill-candidate-group-capsule") {
			throw new Error("Expected a canonical group capsule");
		}
		const baseRevision = group.proposalRevisions.find(
			(revision) => revision.revisionId === capsule.baseProposalRevisionId,
		);
		const baseCandidate = result.candidates.find((candidate) => candidate.candidateId === baseRevision?.candidateId);
		if (baseCandidate === undefined) throw new Error("Expected the capsule base candidate");
		expect(capsule.proposalRevisionIds).toEqual(group.proposalRevisions.map((revision) => revision.revisionId));
		expect(capsule.contract).toEqual({
			operation: baseCandidate.operation,
			proposedName: baseCandidate.proposedName,
			workspace: baseCandidate.workspace,
			existingSkillIds: baseCandidate.existingSkillIds,
			skillability: baseCandidate.skillability,
			trigger: baseCandidate.trigger,
			preconditions: baseCandidate.preconditions,
			procedure: baseCandidate.procedure,
			failureHandling: baseCandidate.failureHandling,
			applicabilityBoundaries: baseCandidate.applicabilityBoundaries,
			verificationContract: baseCandidate.verificationContract,
			memoryRelationship: baseCandidate.memoryRelationship,
		});
		expect(capsule.conflicts).toEqual([
			expect.objectContaining({
				field: "proposedName",
				alternatives: [expect.objectContaining({ supportCount: 1 })],
			}),
		]);
	});

	it("truncates oversized inspection requests and tells the model how to fetch the remainder", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const ledger: EvolutionLedgerEvent[] = [];
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(ledger),
				registry: candidateRegistry(),
			},
			{ maxReferencesPerToolCall: 1 },
		);
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async (request) => {
				const evidenceTool = request.tools.find((tool) => tool.name === "inspect_source_evidence");
				expect(JSON.stringify(evidenceTool?.inputSchema)).not.toContain('"maxItems"');
				expect(await evidenceTool?.execute({ evidenceRefs: ["E1", "E2"] })).toMatchObject({
					evidence: [{ evidenceRef: "E1" }],
					note: "Only the first 1 of 2 requested references were fetched. Fetch at most 1 per call to inspect the remainder.",
				});
				return { output: { outlines: [] }, model: { provider: "faux", model: "fixture" } };
			}, input),
		);

		expect(result).toMatchObject({
			status: "completed",
			outlineSet: { artifactKind: "skill-candidate-outline-set", outlines: [] },
			candidates: [],
			failedExpansions: [],
			deferredFindings: [],
			proceduralInformationLossFindings: [],
		});
		expect(ledger).toMatchObject([
			{
				type: "skill-curator-tool-call",
				requestedReferences: ["E1", "E2"],
				resolvedEvidenceIds: ["support-1"],
				denialCode: null,
			},
			{ type: "skill-candidate-outlines-checkpointed" },
		]);
	});

	it("returns a finalization result when the inspection budget is exhausted", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const ledger: EvolutionLedgerEvent[] = [];
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(ledger),
				registry: candidateRegistry(),
			},
			{ maxToolCalls: 1 },
		);
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async (request) => {
				const evidenceTool = request.tools.find((tool) => tool.name === "inspect_source_evidence");
				expect(await evidenceTool?.execute({ evidenceRefs: ["E1"] })).toMatchObject({
					evidence: [{ evidenceRef: "E1" }],
				});
				expect(await evidenceTool?.execute({ evidenceRefs: ["E2"] })).toEqual({
					inspectionFinished: true,
					note: "Inspection is finished because the Skill Curator tool budget is exhausted. Submit a best-effort response now using the information already inspected.",
				});
				return { output: { outlines: [] }, model: { provider: "faux", model: "fixture" } };
			}, input),
		);

		expect(result).toMatchObject({
			status: "completed",
			outlineSet: { artifactKind: "skill-candidate-outline-set", outlines: [] },
			candidates: [],
			failedExpansions: [],
			deferredFindings: [],
			proceduralInformationLossFindings: [],
		});
		expect(ledger).toMatchObject([
			{ type: "skill-curator-tool-call", denialCode: null, resolvedEvidenceIds: ["support-1"] },
			{
				type: "skill-curator-tool-call",
				denialCode: "tool-budget-exhausted",
				requestedReferences: ["E2"],
				resolvedEvidenceIds: [],
			},
			{ type: "skill-candidate-outlines-checkpointed" },
		]);
	});

	it("rejects a candidate whose canonical capsule exceeds the fixed ceiling", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(),
				registry: candidateRegistry(),
			},
			{ maxResponseAttempts: 1 },
		);
		const input = fixtureInput(storedSkill.reference);

		const result = await curator.curate(
			curatorInput(async (request) => {
				if ((request.input.control as JsonObject).phase === "outline-discovery") {
					await request.tools
						.find((tool) => tool.name === "inspect_source_evidence")
						?.execute({ evidenceRefs: ["E1"], contextAfter: 1 });
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output: outlineOutput(), model: { provider: "faux", model: "fixture" } };
				}
				return {
					output: procedureOutput("x".repeat(SKILL_CANDIDATE_CAPSULE_MAX_SERIALIZED_BYTES)),
					model: { provider: "faux", model: "fixture" },
				};
			}, input),
		);

		expect(result).toMatchObject({
			status: "completed",
			candidates: [],
			failedExpansions: [
				{
					status: "failed",
					diagnostic: {
						reasonCode: "candidate-assembly-invalid",
						attempts: [
							{ attempt: 1, reasonCode: "candidate-assembly-invalid" },
							{ attempt: 2, reasonCode: "candidate-assembly-invalid" },
						],
					},
				},
			],
		});
	});

	it("omits deferred decisions and procedural information loss from discovery", () => {
		const schema = createSkillCuratorOutputSchema({
			lessonRefs: ["L1"],
			memoryProposalRefs: ["P1"],
			skillRefs: ["K1"],
		});
		const serialized = JSON.stringify(schema);
		expect(serialized).not.toContain("deferred");
		expect(serialized).not.toContain("proceduralInformationLoss");
		expect(serialized).not.toContain("triggerDescription");
		expect(serialized).not.toContain("procedureSteps");
		expect(Check(schema as TSchema, outlineOutput())).toBe(true);
	});

	it("keeps optional procedural information loss diagnostics off the candidate success path", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		let diagnosticCalls = 0;
		const curator = new StructuredSkillCurator({
			version: "1",
			artifacts,
			ledger: memoryLedger(),
			registry: candidateRegistry(),
			proceduralInformationLossAnalyzer: {
				async analyze({ outlineSet }) {
					diagnosticCalls += 1;
					expect(outlineSet.outlines).toEqual([]);
					throw new Error("diagnostic unavailable");
				},
			},
		});
		const input = fixtureInput(storedSkill.reference);
		const result = await curator.curate(
			curatorInput(async () => ({ output: { outlines: [] }, model: { provider: "faux", model: "fixture" } }), input),
		);

		expect(diagnosticCalls).toBe(1);
		expect(result).toMatchObject({
			status: "completed",
			candidates: [],
			proceduralInformationLossFindings: [],
		});
	});

	it("does not rerun a terminal expansion after restart", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const ledger: EvolutionLedgerEvent[] = [];
		const registrations: SkillCandidateRegistryConsolidationInput[] = [];
		const dependencies = {
			version: "1",
			artifacts,
			ledger: memoryLedger(ledger),
			registry: candidateRegistry(registrations),
		};
		const input = fixtureInput(storedSkill.reference);
		let discoveryCalls = 0;
		let expansionCalls = 0;
		const initial = await new StructuredSkillCurator(dependencies).curate(
			curatorInput(async (request) => {
				if ((request.input.control as JsonObject).phase === "outline-discovery") {
					discoveryCalls += 1;
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output: outlineOutput(), model: { provider: "faux", model: "fixture" } };
				}
				expansionCalls += 1;
				throw new Error("procedure generation unavailable");
			}, input),
		);
		expect(initial.failedExpansions).toHaveLength(1);
		expect(expansionCalls).toBe(2);

		const resumed = await new StructuredSkillCurator(dependencies).curate(
			curatorInput(async () => {
				throw new Error("checkpointed terminal expansion must not execute again");
			}, input),
		);

		expect(discoveryCalls).toBe(1);
		expect(expansionCalls).toBe(2);
		expect(resumed).toMatchObject({ status: "completed", candidates: [], failedExpansions: [{ status: "failed" }] });
		expect(registrations).toEqual([]);
		expect(ledger.filter((event) => event.type === "skill-candidate-outlines-checkpointed")).toHaveLength(1);
		expect(ledger.filter((event) => event.type === "skill-candidate-expansion-failed")).toHaveLength(1);
	});

	it("resumes an interrupted expansion without resetting its retry budget", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const events: EvolutionLedgerEvent[] = [];
		const durableLedger = memoryLedger(events);
		let interruptAttemptCheckpoint = true;
		const interruptedLedger: EvolutionLedger = {
			async append(event) {
				await durableLedger.append(event);
				if (interruptAttemptCheckpoint && event.type === "skill-candidate-expansion-attempt-failed") {
					interruptAttemptCheckpoint = false;
					throw new Error("attempt checkpoint acknowledgement lost");
				}
			},
			read: (jobId) => durableLedger.read(jobId),
		};
		const input = fixtureInput(storedSkill.reference);
		let discoveryCalls = 0;
		let expansionCalls = 0;
		const execute: SkillCuratorInput["model"]["execute"] = async (request) => {
			if ((request.input.control as JsonObject).phase === "outline-discovery") {
				discoveryCalls += 1;
				await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
				return { output: outlineOutput(), model: { provider: "faux", model: "fixture" } };
			}
			expansionCalls += 1;
			return { output: {}, model: { provider: "faux", model: "fixture" } };
		};

		await expect(
			new StructuredSkillCurator({
				version: "1",
				artifacts,
				ledger: interruptedLedger,
				registry: candidateRegistry(),
			}).curate(curatorInput(execute, input)),
		).rejects.toThrow("attempt checkpoint acknowledgement lost");
		expect(expansionCalls).toBe(1);

		const resumed = await new StructuredSkillCurator({
			version: "1",
			artifacts,
			ledger: durableLedger,
			registry: candidateRegistry(),
		}).curate(curatorInput(execute, input));

		expect(discoveryCalls).toBe(1);
		expect(expansionCalls).toBe(2);
		expect(resumed).toMatchObject({
			status: "completed",
			candidates: [],
			failedExpansions: [
				{
					status: "failed",
					diagnostic: { attempts: [{ attempt: 1 }, { attempt: 2 }] },
				},
			],
		});
		expect(events.filter((event) => event.type === "skill-candidate-expansion-attempt-failed")).toHaveLength(2);
		expect(events.filter((event) => event.type === "skill-candidate-expansion-failed")).toHaveLength(1);
	});

	it("restores a successful expansion and idempotently registers it after restart", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const ledger: EvolutionLedgerEvent[] = [];
		const registrations: SkillCandidateRegistryConsolidationInput[] = [];
		const dependencies = {
			version: "1",
			artifacts,
			ledger: memoryLedger(ledger),
			registry: candidateRegistry(registrations),
		};
		const input = fixtureInput(storedSkill.reference);
		let modelCalls = 0;
		const initial = await new StructuredSkillCurator(dependencies).curate(
			curatorInput(async (request) => {
				modelCalls += 1;
				if ((request.input.control as JsonObject).phase === "outline-discovery") {
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output: outlineOutput(), model: { provider: "faux", model: "fixture" } };
				}
				return { output: procedureOutput(), model: { provider: "faux", model: "fixture" } };
			}, input),
		);
		expect(initial.candidates).toHaveLength(1);
		expect(modelCalls).toBe(2);

		const resumed = await new StructuredSkillCurator(dependencies).curate(
			curatorInput(async () => {
				throw new Error("checkpointed successful expansion must not execute again");
			}, input),
		);

		expect(modelCalls).toBe(2);
		expect(resumed.candidates).toEqual(initial.candidates);
		expect(registrations).toHaveLength(2);
		expect([...new Set(registrations.map((registration) => registration.idempotencyKey))]).toHaveLength(1);
		expect(ledger.filter((event) => event.type === "skill-candidate-expansion-succeeded")).toHaveLength(1);
	});

	it("rejects references to skill content that was not inspected", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(),
				registry: candidateRegistry(),
			},
			{ maxResponseAttempts: 1 },
		);
		const input = fixtureInput(storedSkill.reference);

		await expect(
			curator.curate(
				curatorInput(
					async () => ({ output: outlineOutput(), model: { provider: "faux", model: "fixture" } }),
					input,
				),
			),
		).rejects.toMatchObject({
			name: "EvolutionExecutionError",
			reasonCode: "skill-curation-invalid-response",
			retryable: false,
		});
	});

	it.each([
		{
			name: "CREATE outline with an existing skill",
			output: {
				outlines: [{ ...(outlineOutput().outlines as readonly JsonObject[])[0], operation: "CREATE" }],
			},
			error: "CREATE outlines cannot cite existing skills",
		},
		{
			name: "UPDATE outline without exactly one existing skill",
			output: {
				outlines: [{ ...(outlineOutput().outlines as readonly JsonObject[])[0], existingSkillRefs: [] }],
			},
			error: "UPDATE outlines must cite exactly one existing skill",
		},
		{
			name: "independent outline with a memory proposal",
			output: {
				outlines: [
					{
						...(outlineOutput().outlines as readonly JsonObject[])[0],
						memoryRelationship: { classification: "independent", memoryProposalRefs: ["P1"] },
					},
				],
			},
			error: "An independent candidate cannot cite a selected memory proposal",
		},
		{
			name: "duplicate outline keys",
			output: {
				outlines: [
					(outlineOutput().outlines as readonly JsonObject[])[0]!,
					{
						...(outlineOutput().outlines as readonly JsonObject[])[0],
						proposedName: "other-name",
					},
				],
			},
			error: 'Duplicate outline key "verification-recovery"',
		},
	])("rejects $name deterministically", async ({ output, error }) => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(),
				registry: candidateRegistry(),
			},
			{ maxResponseAttempts: 1 },
		);
		const input = fixtureInput(storedSkill.reference);

		await expect(
			curator.curate(
				curatorInput(async (request) => {
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output, model: { provider: "faux", model: "fixture" } };
				}, input),
			),
		).rejects.toMatchObject({
			reasonCode: "skill-curation-invalid-response",
			diagnostics: { attemptDetails: [{ validationError: error }] },
		});
	});

	it("rejects an existing skill outside the candidate workspace", async () => {
		const storedSkill = skillArtifact();
		const artifacts = new FixtureArtifactStore([storedSkill]);
		const curator = new StructuredSkillCurator(
			{
				version: "1",
				artifacts,
				ledger: memoryLedger(),
				registry: candidateRegistry(),
			},
			{ maxResponseAttempts: 1 },
		);
		const fixture = fixtureInput(storedSkill.reference);
		const input = { ...fixture, repository: { ...fixture.repository, directoryId: "other-directory" } };

		await expect(
			curator.curate(
				curatorInput(async (request) => {
					await request.tools.find((tool) => tool.name === "inspect_skills")?.execute({ skillRefs: ["K1"] });
					return { output: outlineOutput(), model: { provider: "faux", model: "fixture" } };
				}, input),
			),
		).rejects.toMatchObject({
			reasonCode: "skill-curation-invalid-response",
			diagnostics: {
				attemptDetails: [
					{
						validationError:
							'Existing skill "installed:workspace:existing-skill" is outside the candidate workspace',
					},
				],
			},
		});
	});

	it("uses a strict Codex-compatible output schema", () => {
		const schema = createSkillCuratorOutputSchema({
			lessonRefs: ["L1"],
			memoryProposalRefs: ["P1"],
			skillRefs: ["K1"],
		});
		const procedureSchema = createSkillCandidateProcedureDraftOutputSchema();
		expect(findUnsupportedCodexSchemaKeywords(schema)).toEqual([]);
		expect(findUnsupportedCodexSchemaKeywords(procedureSchema)).toEqual([]);
		expect(JSON.stringify(schema)).not.toContain('"rationale"');
		expect(Check(schema as TSchema, outlineOutput())).toBe(true);
		expect(Check(procedureSchema as TSchema, procedureOutput())).toBe(true);
	});
});
