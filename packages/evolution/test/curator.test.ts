import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import {
	type CuratorInput,
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvidenceCorpusManifest,
	type EvolutionArtifactProducer,
	type EvolutionInputSnapshot,
	type EvolutionLedgerEvent,
	type EvolutionMemoryItem,
	type EvolutionModelResponse,
	type InstructionSnapshot,
	type JsonObject,
	type Lesson,
	type ReflectionResult,
	StructuredDeltaCurator,
} from "../src/index.ts";
import { findUnsupportedCodexSchemaKeywords } from "./structured-output-schema.ts";

const FIRST_HARNESS_VERSION = `sha256:${"1".repeat(64)}`;
const SECOND_HARNESS_VERSION = `sha256:${"2".repeat(64)}`;
const MEMORY_ITEM_DIGEST = computeEvolutionContentDigest("- Keep focused changes.");
const MODEL_CONFIGURATION_DIGEST = `sha256:${"4".repeat(64)}`;
const createdAt = "2026-08-19T12:00:00.000Z";
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

function sessionEvidence(evidenceId: string, position: number, sessionId: string): MaterializedEvidence {
	return {
		kind: "session_item",
		evidenceId,
		itemType: "message",
		payload: { type: "message", id: `entry-${position}`, message: { role: "assistant", content: evidenceId } },
		order: {
			traceSequence: position + 2,
			timestamp: new Date(Date.parse(createdAt) + position).toISOString(),
			sessionPosition: position,
			parentSpanId: null,
			causalIdentifiers: [{ name: "diffex.task.lineage", value: "task-lineage-1" }],
			ambiguity: [],
		},
		traceSources: [],
		sessionSource: {
			bindingId: "binding-1",
			sessionId,
			path: "/private/session.jsonl",
			sessionFormat: "coding-agent-v3",
			formatVersion: 3,
			segmentTraceSequences: [position + 2],
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
		evidence: [
			{
				kind: "trace_record",
				evidenceId: "activation-1",
				payload: {
					type: "harness_activate",
					sequence: 1,
					timestamp: createdAt,
					harnessVersion: FIRST_HARNESS_VERSION,
					reason: "initial",
				},
				order: {
					traceSequence: 1,
					timestamp: createdAt,
					causalIdentifiers: [],
					ambiguity: [],
				},
				traceSources: [],
			},
			sessionEvidence("support-1", 0, "session-1"),
			sessionEvidence("counter-1", 1, "session-1"),
		],
		diagnostics: [],
	};
}

function memoryItem(memoryItemId = "memory-1"): EvolutionMemoryItem {
	return {
		schemaVersion: 1,
		memoryItemId,
		contentDigest: MEMORY_ITEM_DIGEST,
		creationRevision: FIRST_HARNESS_VERSION,
		supersessionRevision: null,
		ledger: { origin: "evolution", creationEventId: "event-1", supersessionEventId: null },
	};
}

function fixtureInput(): EvolutionInputSnapshot {
	const materialized = invocation();
	const source = {
		sourceId: "source-1",
		materializationId: "materialization-1",
		ingestionCursor: 1,
		origin: "product-runtime" as const,
		contentDigest: computeEvolutionContentDigest(materialized),
		invocation: materialized,
	};
	const memory = "# Evolution memory\n\n- Keep focused changes.\n";
	const firstInstruction = "Repository guidance.\n";
	const secondInstruction = "Nested guidance.\n";
	return {
		metadata: metadata("input-1", [source.sourceId], { sourceId: source.sourceId }),
		trigger: "manual",
		repository: { repositoryId: "diffex", rootPath: "/repo", revision: "current-revision" },
		harness: {
			harnessVersion: SECOND_HARNESS_VERSION,
			baseVersion: FIRST_HARNESS_VERSION,
			memory,
			memoryContentDigest: computeEvolutionContentDigest(memory),
			activeMemoryItems: [memoryItem()],
		},
		expectedHarnessBaseVersion: SECOND_HARNESS_VERSION,
		ingestionHighWaterCursor: 1,
		instructions: [
			{
				path: "/repo/AGENTS.md",
				precedence: 10,
				content: firstInstruction,
				contentDigest: computeEvolutionContentDigest(firstInstruction),
			},
			{
				path: "/repo/CLAUDE.md",
				precedence: 20,
				content: secondInstruction,
				contentDigest: computeEvolutionContentDigest(secondInstruction),
			},
		],
		skillCatalog: [],
		modelConfiguration: {
			provider: "faux",
			model: "fixture",
			configurationDigest: MODEL_CONFIGURATION_DIGEST,
		},
		pipelineVersion: "pipeline-v1",
		promptVersions: {
			reflector: "reflector-v1",
			curator: "curator-v1",
			validator: "validator-v1",
			writer: "writer-v1",
		},
		tokenMeasurement: { estimatorVersion: "fixture", estimatedTokens: 100 },
		evidenceSources: [source],
	};
}

function lesson(lessonId: string, summary: string): Lesson {
	const content = { lessonId, summary };
	return {
		metadata: metadata(lessonId, ["support-1", "counter-1"], content),
		lessonId,
		kind: "successful-strategy",
		summary,
		preconditions: ["The task changes repository code"],
		observedOutcome: "The result remained focused",
		evidenceIds: ["support-1"],
		counterevidenceIds: ["counter-1"],
		scope,
		applicabilityBoundaries: ["Repository code changes"],
		uncertainty: null,
		actionableTakeaway: "Keep changes focused",
	};
}

function reflection(): ReflectionResult {
	const finalLesson = lesson("lesson-final", "Keep changes focused");
	const intermediateLesson = lesson("lesson-intermediate", "Intermediate observation");
	return {
		nodes: [],
		lessons: [intermediateLesson, finalLesson],
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
				evidenceIds: ["activation-1", "support-1", "counter-1"],
				semanticUnits: [],
				diagnostics: [],
				orderingAmbiguity: [],
			},
		],
		excludedSources: [],
	};
}

function instructions(input: EvolutionInputSnapshot): InstructionSnapshot {
	return {
		metadata: metadata("instructions-1", [input.metadata.artifactId], input.instructions),
		documents: input.instructions,
	};
}

function curatorInput(execute: CuratorInput["model"]["execute"]): CuratorInput {
	const input = fixtureInput();
	return {
		jobId: "job-1",
		input,
		corpus: corpus(),
		instructions: instructions(input),
		reflection: reflection(),
		model: { maxProviderCallsPerExecution: 20, execute },
		idempotencyKey: "job-1:curating",
	};
}

function novelRelationship(): JsonObject {
	return { classification: "novel", instructionRefs: [], memoryRefs: [], strengthening: null };
}

function proposal(
	action: "ADD" | "DEFER" | "REMOVE" | "REPLACE",
	target: JsonObject,
	exactDelta: JsonObject | null,
	overrides: Readonly<Record<string, unknown>> = {},
) {
	return {
		target,
		action,
		exactDelta,
		expectedBenefit: "Future changes remain focused",
		acceptanceCriterion: "The guidance is independently addressable",
		risk: "The guidance could be applied too broadly",
		rollbackDescription: "Reverse this exact delta",
		curatorConfidence: 0.85,
		uncertainty: null,
		counterexamples: ["Generated files require broad mechanical updates"],
		conflictingDecisionKeys: [],
		finding: null,
		...overrides,
	};
}

function response(decisions: readonly JsonObject[]): EvolutionModelResponse {
	return { output: { decisions }, model: { provider: "faux", model: "curator-fixture" } };
}

function decision(
	decisionKey: string,
	proposalValue: JsonObject | null,
	relationship: JsonObject = novelRelationship(),
) {
	return {
		decisionKey,
		lessonRefs: ["L1"],
		relevance: {
			userTaskOrFailure: "A repository task required a focused change",
			causalAgentBehavior: "The agent kept the change scoped",
			futureBehaviorChange: "Keep future changes focused",
			verifiableExpectedResult: "The resulting diff contains only task-required files",
			observerDocumentationOnly: false,
			telemetryFormatOnly: false,
		},
		relationship,
		proposal: proposalValue,
	};
}

describe("structured delta curator", () => {
	it("publishes a Codex-compatible response schema", async () => {
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });

		await curator.curate(
			curatorInput((request) => {
				expect(findUnsupportedCodexSchemaKeywords(request.outputSchema)).toEqual([]);
				expect(request.outputSchema).toMatchObject({
					$defs: { destination: { properties: { anchor: { enum: [null, "M1"] } } } },
				});
				return Promise.resolve(response([]));
			}),
		);
	});

	it("emits a provenance-rich ADD from final lessons and ordered snapshots", async () => {
		const capturedInputs: JsonObject[] = [];
		const toolOutputs: JsonObject[] = [];
		const ledgerEvents: EvolutionLedgerEvent[] = [];
		const curator = new StructuredDeltaCurator({
			version: "1.2.3",
			ledger: {
				append(event) {
					ledgerEvents.push(event);
					return Promise.resolve();
				},
				read() {
					return Promise.resolve([]);
				},
			},
		});
		const input = curatorInput(async (request) => {
			if (request.stage !== "curator") throw new Error("Unexpected Reflector request");
			capturedInputs.push(request.input);
			expect(request.outputSchema).toMatchObject({ type: "object" });
			expect(request.tools.map((tool) => tool.name)).toEqual(["inspect_lessons", "inspect_existing_guidance"]);
			const lessonOutput = await request.tools
				.find((tool) => tool.name === "inspect_lessons")
				?.execute({ lessonRefs: ["L1"] });
			const guidanceOutput = await request.tools
				.find((tool) => tool.name === "inspect_existing_guidance")
				?.execute({ instructionRefs: ["I1"], memoryRefs: ["M0", "M1"] });
			for (const output of [lessonOutput, guidanceOutput]) {
				if (output !== undefined) toolOutputs.push(output);
			}
			return response([
				decision(
					"focused-add",
					proposal(
						"ADD",
						{ kind: "evolution-memory" },
						{
							operation: "ADD",
							destination: { section: "Evolution memory", anchor: "M1" },
							content: "Keep repository changes focused.",
							intendedScope: ["Repository code changes"],
						},
					),
				),
			]);
		});

		const first = await curator.curate(input);
		const second = await curator.curate(input);

		expect(capturedInputs[0]?.jobId).toBe("job-1");
		expect(capturedInputs[0]?.lessons).toEqual([
			expect.objectContaining({ lessonRef: "L1", summary: "Keep changes focused" }),
		]);
		expect(capturedInputs[0]?.instructions).toEqual([
			expect.objectContaining({ instructionRef: "I1", label: "Instruction 1" }),
			expect.objectContaining({ instructionRef: "I2", label: "Instruction 2" }),
		]);
		expect(capturedInputs[0]?.memory).toEqual([
			expect.objectContaining({ memoryRef: "M0" }),
			expect.objectContaining({ memoryRef: "M1" }),
		]);
		expect(capturedInputs[0]?.control).toMatchObject({
			additionAnchorReferences: ["M1"],
			additionAnchorRule: expect.stringContaining("Sentinels such as end are invalid"),
			consolidateOverlappingLessons: true,
			emitOnlyBehaviorChangingProposals: true,
			maxEvolutionMemoryLessonSentences: 3,
			omitObserverDocumentation: true,
			omitEvolutionMemoryLessonNumber: true,
			omitTelemetryFormatFacts: true,
			routeUsefulTelemetryFactsToDebuggingDocumentation: true,
		});
		expect(JSON.stringify(capturedInputs[0])).not.toContain("memory-1");
		expect(JSON.stringify(capturedInputs[0])).not.toContain("lesson-final");
		expect(JSON.stringify(capturedInputs[0])).not.toContain("/repo/AGENTS.md");
		expect(JSON.stringify(toolOutputs)).not.toContain("memory-1");
		expect(JSON.stringify(toolOutputs)).not.toContain("lesson-final");
		expect(JSON.stringify(toolOutputs)).not.toContain("/repo/AGENTS.md");
		expect(ledgerEvents.filter((event) => event.type === "curator-tool-call")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ toolName: "inspect_lessons", resolvedLessonIds: ["lesson-final"] }),
				expect.objectContaining({
					toolName: "inspect_existing_guidance",
					resolvedInstructionPaths: ["/repo/AGENTS.md"],
					resolvedMemoryItemIds: ["memory-1"],
				}),
			]),
		);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({
			disposition: "actionable",
			target: { kind: "evolution-memory", expectedHarnessVersion: SECOND_HARNESS_VERSION },
			action: "ADD",
			expectedBaseDigest: input.input.harness.memoryContentDigest,
			exactDelta: {
				destination: { section: "Evolution memory", anchor: "- Keep focused changes." },
			},
			lessonIds: ["lesson-final"],
			supportingEvidenceIds: ["support-1"],
			contradictingEvidenceIds: ["counter-1"],
			supportingTraceIds: ["trace-1"],
			contradictingTraceIds: ["trace-1"],
			scope: {
				repository: scope,
				repositoryRevision: "current-revision",
				materializationIds: ["materialization-1"],
				traceIds: ["trace-1"],
				sessionIds: ["session-1"],
				taskLineageIds: ["task-lineage-1"],
				runtimeKinds: ["node"],
				runtimeVersions: ["24.0.0"],
				sourceRevisions: ["revision-1"],
				harnessVersions: [FIRST_HARNESS_VERSION],
				applicabilityBoundaries: ["Repository code changes"],
			},
			metadata: {
				producer: {
					name: "diffex-evolution-curator",
					version: "1.2.3",
					promptVersion: "curator-v1",
					model: {
						provider: "faux",
						model: "curator-fixture",
						configurationDigest: MODEL_CONFIGURATION_DIGEST,
					},
				},
			},
		});
		expect(second[0]?.proposalId).toBe(first[0]?.proposalId);
		expect(second[0]?.metadata.contentDigest).toBe(first[0]?.metadata.contentDigest);
	});

	it("emits exact removal and atomic replacement deltas", async () => {
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });
		const proposals = await curator.curate(
			curatorInput(() =>
				Promise.resolve(
					response([
						decision(
							"remove-rule",
							proposal(
								"REMOVE",
								{ kind: "evolution-memory" },
								{
									operation: "REMOVE",
									memoryRef: "M1",
									reason: "Counterevidence shows the rule is harmful",
								},
							),
						),
						decision(
							"replace-rule",
							proposal(
								"REPLACE",
								{ kind: "evolution-memory" },
								{
									operation: "REPLACE",
									removal: {
										memoryRef: "M1",
										reason: "Narrow the existing rule",
									},
									addition: {
										destination: { section: "Evolution memory", anchor: null },
										content: "Keep repository code changes focused.",
										intendedScope: ["Repository code changes"],
									},
								},
							),
						),
					]),
				),
			),
		);

		expect(proposals[0]).toMatchObject({
			action: "REMOVE",
			exactDelta: { memoryItemId: "memory-1", expectedContentDigest: MEMORY_ITEM_DIGEST },
		});
		expect(proposals[1]).toMatchObject({
			action: "REPLACE",
			exactDelta: {
				operation: "REPLACE",
				removal: { memoryItemId: "memory-1", expectedContentDigest: MEMORY_ITEM_DIGEST },
				addition: {
					destination: { section: "Evolution memory", anchor: null },
					content: "Keep repository code changes focused.",
				},
			},
		});
	});

	it("rejects replacement additions anchored to the item being removed", async () => {
		const curator = new StructuredDeltaCurator({ version: "1.2.3" }, { maxResponseAttempts: 1 });
		const input = curatorInput(() =>
			Promise.resolve(
				response([
					decision(
						"replace-in-place",
						proposal(
							"REPLACE",
							{ kind: "evolution-memory" },
							{
								operation: "REPLACE",
								removal: { memoryRef: "M1", reason: "Narrow the existing rule" },
								addition: {
									destination: { section: null, anchor: "M1" },
									content: "Keep repository code changes focused.",
									intendedScope: ["Repository code changes"],
								},
							},
						),
					),
				]),
			),
		);

		await expect(curator.curate(input)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
			cause: expect.objectContaining({
				message: "REPLACE addition cannot anchor to the memory item being removed",
			}),
		});
	});

	it("preserves skill and source findings as non-executable deferred proposals", async () => {
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });
		const proposals = await curator.curate(
			curatorInput(() =>
				Promise.resolve(
					response([
						decision(
							"defer-skill",
							proposal("DEFER", { kind: "skill", skillName: "review" }, null, {
								finding: "The review skill needs a narrower verification contract",
							}),
						),
						decision(
							"defer-source",
							proposal("DEFER", { kind: "orchestration-source", sourcePath: "src/runner.ts" }, null, {
								finding: "The runner should isolate retries",
							}),
						),
					]),
				),
			),
		);

		expect(proposals).toEqual([
			expect.objectContaining({
				disposition: "deferred",
				target: { kind: "skill", skillName: "review" },
				action: "DEFER",
				exactDelta: null,
				expectedBaseDigest: null,
			}),
			expect.objectContaining({
				disposition: "deferred",
				target: { kind: "orchestration-source", sourcePath: "src/runner.ts" },
				action: "DEFER",
				exactDelta: null,
			}),
		]);
	});

	it("resolves model decision conflicts to stable proposal IDs", async () => {
		const addDelta = {
			operation: "ADD",
			destination: { section: "Engineering", anchor: null },
			content: "Keep changes focused.",
			intendedScope: ["Repository code changes"],
		};
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });
		const proposals = await curator.curate(
			curatorInput(() =>
				Promise.resolve(
					response([
						decision(
							"broad-rule",
							proposal("ADD", { kind: "evolution-memory" }, addDelta, {
								conflictingDecisionKeys: ["narrow-rule"],
							}),
						),
						decision("narrow-rule", proposal("ADD", { kind: "evolution-memory" }, addDelta)),
					]),
				),
			),
		);

		expect(proposals[0]?.conflictingProposalIds).toEqual([proposals[1]?.proposalId]);
	});

	it("suppresses duplicate and conflicting decisions and retains strengthening references", async () => {
		const input = curatorInput(() =>
			Promise.resolve(
				response([
					decision("duplicate-whole-memory", null, {
						classification: "duplicate",
						instructionRefs: [],
						memoryRefs: ["M0"],
						strengthening: null,
					}),
					decision("duplicate-rule", null, {
						classification: "duplicate",
						instructionRefs: ["I1"],
						memoryRefs: [],
						strengthening: null,
					}),
					decision("conflicting-rule", null, {
						classification: "conflicts",
						instructionRefs: ["I1", "I2"],
						memoryRefs: [],
						strengthening: null,
					}),
					decision(
						"strengthen-rule",
						proposal(
							"ADD",
							{ kind: "evolution-memory" },
							{
								operation: "ADD",
								destination: { section: "Engineering", anchor: null },
								content: "Run focused verification after repository changes.",
								intendedScope: ["Repository code changes"],
							},
						),
						{
							classification: "strengthens",
							instructionRefs: ["I2"],
							memoryRefs: [],
							strengthening: { kind: "enforcement", description: "Adds a verification requirement" },
						},
					),
				]),
			),
		);
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });

		const proposals = await curator.curate(input);

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			instructionRelationship: {
				classification: "strengthens",
				relevantEntries: [
					{
						kind: "applicable-instruction",
						path: "/repo/CLAUDE.md",
						precedence: 20,
						contentDigest: input.instructions.documents[1]?.contentDigest,
					},
				],
				strengthening: { kind: "enforcement" },
			},
		});
	});

	it("retries invalid structured output without changing the idempotency key", async () => {
		const keys: string[] = [];
		const inputs: JsonObject[] = [];
		let calls = 0;
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });
		const proposals = await curator.curate(
			curatorInput((request) => {
				keys.push(request.idempotencyKey);
				inputs.push(request.input);
				calls += 1;
				if (calls === 1) {
					return Promise.resolve(response([{ ...decision("invalid", null), lessonRefs: ["L2"], proposal: null }]));
				}
				return Promise.resolve(
					response([
						decision(
							"valid",
							proposal(
								"ADD",
								{ kind: "evolution-memory" },
								{
									operation: "ADD",
									destination: { section: "Engineering", anchor: null },
									content: "Keep changes focused.",
									intendedScope: ["Repository code changes"],
								},
							),
						),
					]),
				);
			}),
		);

		expect(proposals).toHaveLength(1);
		expect(keys).toEqual(["job-1:curating", "job-1:curating"]);
		expect(inputs[1]?.lessons).toEqual(inputs[0]?.lessons);
		expect(inputs[1]?.instructions).toEqual(inputs[0]?.instructions);
		expect(inputs[1]?.memory).toEqual(inputs[0]?.memory);
		expect(JSON.stringify(inputs[1]?.control)).not.toContain("L2");
		expect(JSON.stringify(inputs[1]?.control)).toContain("L1");
	});

	it("rejects sentinel addition anchors and reports permitted memory references", async () => {
		let calls = 0;
		const curator = new StructuredDeltaCurator({ version: "1.2.3" }, { maxResponseAttempts: 1 });
		const input = curatorInput(() => {
			calls += 1;
			return Promise.resolve(
				response([
					decision(
						"invalid-anchor",
						proposal(
							"ADD",
							{ kind: "evolution-memory" },
							{
								operation: "ADD",
								destination: { section: null, anchor: "end" },
								content: "Keep changes focused.",
								intendedScope: ["Repository code changes"],
							},
						),
					),
				]),
			);
		});

		await expect(curator.curate(input)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
			retryable: false,
			cause: expect.objectContaining({ message: expect.stringContaining("Permitted references: M1") }),
			diagnostics: {
				invalidAliases: ["end"],
				permittedAliases: ["M1"],
			},
		});
		expect(calls).toBe(1);
	});

	it("retries model-authored lessons longer than three sentences", async () => {
		const inputs: JsonObject[] = [];
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });
		const proposals = await curator.curate(
			curatorInput((request) => {
				inputs.push(request.input);
				const content =
					inputs.length === 1
						? "First sentence. Second sentence. Third sentence. Fourth sentence."
						: "First sentence. Second sentence. Third sentence.";
				return Promise.resolve(
					response([
						decision(
							"bounded-lesson",
							proposal(
								"ADD",
								{ kind: "evolution-memory" },
								{
									operation: "ADD",
									destination: { section: "Engineering", anchor: null },
									content,
									intendedScope: ["Repository code changes"],
								},
							),
						),
					]),
				);
			}),
		);

		expect(proposals).toHaveLength(1);
		expect(inputs).toHaveLength(2);
		expect(JSON.stringify(inputs[1]?.control)).toContain("at most 3 sentences");
	});

	it("rejects unsupported writer routes after bounded attempts", async () => {
		let calls = 0;
		const curator = new StructuredDeltaCurator({ version: "1.2.3" });
		const input = curatorInput(() => {
			calls += 1;
			return Promise.resolve(
				response([
					decision(
						"invalid-skill-write",
						proposal(
							"ADD",
							{ kind: "skill", skillName: "review" },
							{
								operation: "ADD",
								destination: { section: "Review", anchor: null },
								content: "Write directly to the skill.",
								intendedScope: ["review"],
							},
						),
					),
				]),
			);
		});

		await expect(curator.curate(input)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
			retryable: false,
		});
		expect(calls).toBe(2);
	});

	it("rejects unknown instruction, memory-item, and evidence references", async () => {
		const curator = new StructuredDeltaCurator({ version: "1.2.3" }, { maxResponseAttempts: 1 });
		const addProposal = proposal(
			"ADD",
			{ kind: "evolution-memory" },
			{
				operation: "ADD",
				destination: { section: "Engineering", anchor: null },
				content: "Keep changes focused.",
				intendedScope: ["Repository code changes"],
			},
		);
		const unknownInstruction = curatorInput(() =>
			Promise.resolve(
				response([
					decision("unknown-instruction", addProposal, {
						classification: "strengthens",
						instructionRefs: ["I99"],
						memoryRefs: [],
						strengthening: { kind: "precision", description: "Adds exact guidance" },
					}),
				]),
			),
		);
		const unknownMemoryItem = curatorInput(() =>
			Promise.resolve(
				response([
					decision(
						"unknown-memory",
						proposal(
							"REMOVE",
							{ kind: "evolution-memory" },
							{
								operation: "REMOVE",
								memoryRef: "M99",
								reason: "Remove stale guidance",
							},
						),
					),
				]),
			),
		);
		const wholeMemoryRemoval = curatorInput(() =>
			Promise.resolve(
				response([
					decision(
						"whole-memory-removal",
						proposal(
							"REMOVE",
							{ kind: "evolution-memory" },
							{
								operation: "REMOVE",
								memoryRef: "M0",
								reason: "Invalid whole-memory removal",
							},
						),
					),
				]),
			),
		);
		const unknownEvidenceBase = curatorInput(() =>
			Promise.resolve(response([decision("unknown-evidence", addProposal)])),
		);
		const unknownEvidence: CuratorInput = {
			...unknownEvidenceBase,
			reflection: {
				...unknownEvidenceBase.reflection,
				lessons: unknownEvidenceBase.reflection.lessons.map((item) =>
					item.lessonId === "lesson-final" ? { ...item, evidenceIds: ["missing-evidence"] } : item,
				),
			},
		};

		await expect(curator.curate(unknownInstruction)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
		});
		await expect(curator.curate(unknownMemoryItem)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
		});
		await expect(curator.curate(wholeMemoryRemoval)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
		});
		await expect(curator.curate(unknownEvidence)).rejects.toMatchObject({
			reasonCode: "artifact-corrupt",
		});
	});

	it("rejects observer documentation as evolution memory", async () => {
		const curator = new StructuredDeltaCurator({ version: "1.2.3" }, { maxResponseAttempts: 1 });
		const candidate = decision(
			"observer-fact",
			proposal(
				"ADD",
				{ kind: "evolution-memory" },
				{
					operation: "ADD",
					destination: { section: "Diagnostics", anchor: null },
					content: "Completed spans include a status field.",
					intendedScope: ["Trace inspection"],
				},
			),
		);
		const input = curatorInput(() =>
			Promise.resolve(
				response([
					{
						...candidate,
						relevance: { ...candidate.relevance, observerDocumentationOnly: true, telemetryFormatOnly: true },
					},
				]),
			),
		);

		await expect(curator.curate(input)).rejects.toMatchObject({
			reasonCode: "curation-invalid-response",
			cause: expect.objectContaining({
				message: "Observer documentation and telemetry-format facts are not actionable evolution memory",
			}),
		});
	});
});
