import type {
	CounterReport,
	EvidenceCorpusManifest,
	EvidenceCoverageMap,
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionInputSnapshot,
	EvolutionLedgerEvent,
	EvolutionMemoryProposal,
	EvolutionProposal,
	EvolutionProposalLedgerDisposition,
	EvolutionScope,
	HarnessActivationReceipt,
	InstructionSnapshot,
	Lesson,
	MutationBatch,
	MutationWriteReceipt,
	ProposalDispositionLedgerEvent,
	ReflectionNode,
	ScoredProposal,
	ValidationReport,
} from "./contracts.ts";
import { DisabledPreReflectionStage } from "./counter.ts";
import { EvolutionExecutionError } from "./errors.ts";
import { buildEvidenceCorpusDocument } from "./evidence-corpus.ts";
import type {
	Curator,
	EvolutionArtifact,
	EvolutionModelExecutor,
	EvolutionStageExecutionContext,
	EvolutionStageExecutionResult,
	EvolutionStageExecutor,
	PreReflectionStage,
	ProposalScorer,
	ProposalValidator,
	ReflectionResult,
	Reflector,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";
import type { EvolutionTargetAdapterRegistry } from "./targets.ts";

const PIPELINE_PRODUCER_NAME = "diffex-evolution";

export interface EvolutionPipelineDependencies {
	readonly version: string;
	readonly model: EvolutionModelExecutor;
	readonly reflector: Reflector;
	readonly curator: Curator;
	readonly validator: ProposalValidator;
	readonly scorer: ProposalScorer;
	readonly targets: EvolutionTargetAdapterRegistry;
	readonly preReflectionStage?: PreReflectionStage;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCorpus(artifact: EvolutionArtifact): artifact is EvidenceCorpusManifest {
	return "excludedSources" in artifact;
}

function isCounterReport(artifact: EvolutionArtifact): artifact is CounterReport {
	return "artifactKind" in artifact && artifact.artifactKind === "counter-report";
}

function isCoverageMap(artifact: EvolutionArtifact): artifact is EvidenceCoverageMap {
	return "manifestDigest" in artifact && "entries" in artifact && "finalLessonIds" in artifact;
}

function isInstructionSnapshot(artifact: EvolutionArtifact): artifact is InstructionSnapshot {
	return "documents" in artifact && !("excludedSources" in artifact);
}

function isReflectionNode(artifact: EvolutionArtifact): artifact is ReflectionNode {
	return "nodeId" in artifact;
}

function isLesson(artifact: EvolutionArtifact): artifact is Lesson {
	return "lessonId" in artifact;
}

function isProposal(artifact: EvolutionArtifact): artifact is EvolutionProposal {
	return "proposalId" in artifact && "disposition" in artifact;
}

function isScoredProposal(artifact: EvolutionArtifact): artifact is ScoredProposal {
	return "proposal" in artifact && "evidenceRankingScore" in artifact;
}

function isMutationBatch(artifact: EvolutionArtifact): artifact is MutationBatch {
	return "mutations" in artifact && "batchId" in artifact;
}

function isMutationWriteReceipt(artifact: EvolutionArtifact): artifact is MutationWriteReceipt {
	return (
		"result" in artifact &&
		isRecord(artifact.result) &&
		(artifact.result.status === "written" || artifact.result.status === "failed")
	);
}

function assertUniqueIds(values: readonly string[], description: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value))
			throw new EvolutionExecutionError(`Duplicate ${description} "${value}"`, {
				reasonCode: "pipeline-invariant",
				retryable: false,
			});
		seen.add(value);
	}
}

function requireOne<T>(values: readonly T[], description: string): T {
	if (values.length !== 1) {
		throw new EvolutionExecutionError(`Expected exactly one ${description}, found ${values.length}`, {
			reasonCode: "artifact-corrupt",
			retryable: false,
		});
	}
	return values[0] as T;
}

function optionalOne<T>(values: readonly T[], description: string): T | null {
	if (values.length > 1) {
		throw new EvolutionExecutionError(`Expected at most one ${description}, found ${values.length}`, {
			reasonCode: "artifact-corrupt",
			retryable: false,
		});
	}
	return values[0] ?? null;
}

function assertScoredProposals(
	proposals: readonly EvolutionProposal[],
	scoredProposals: readonly ScoredProposal[],
): void {
	assertUniqueIds(
		scoredProposals.map((scored) => scored.proposal.proposalId),
		"scored proposal ID",
	);
	const proposalsById = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
	for (const scored of scoredProposals) {
		const proposal = proposalsById.get(scored.proposal.proposalId);
		if (proposal === undefined || proposal !== scored.proposal) {
			throw new EvolutionExecutionError(
				`Scorer replaced or returned unknown proposal "${scored.proposal.proposalId}"`,
				{
					reasonCode: "pipeline-invariant",
					retryable: false,
				},
			);
		}
		if (scored.disposition === "selected" && proposal.disposition !== "actionable") {
			throw new EvolutionExecutionError(`Deferred proposal "${proposal.proposalId}" cannot be selected`, {
				reasonCode: "pipeline-invariant",
				retryable: false,
			});
		}
	}
	if (scoredProposals.length !== proposals.length) {
		throw new EvolutionExecutionError("Scorer must return exactly one result for every proposal", {
			reasonCode: "pipeline-invariant",
			retryable: false,
		});
	}
}

function assertValidationReport(
	proposals: readonly EvolutionProposal[],
	validation: ValidationReport,
	scoredProposals: readonly ScoredProposal[],
): void {
	assertUniqueIds(
		validation.proposalResults.map((result) => result.proposalId),
		"validation proposal ID",
	);
	const proposalIds = new Set(proposals.map((proposal) => proposal.proposalId));
	if (
		validation.proposalResults.length !== proposals.length ||
		validation.proposalResults.some((result) => !proposalIds.has(result.proposalId))
	) {
		throw new EvolutionExecutionError("Validator must return exactly one result for every proposal", {
			reasonCode: "pipeline-invariant",
			retryable: false,
		});
	}
	const accepted = new Set(
		validation.proposalResults
			.filter((result) => result.disposition === "accepted")
			.map((result) => result.proposalId),
	);
	if (
		scoredProposals.some((scored) => scored.disposition === "selected" && !accepted.has(scored.proposal.proposalId))
	) {
		throw new EvolutionExecutionError("Scorer selected a proposal that deterministic validation did not accept", {
			reasonCode: "pipeline-invariant",
			retryable: false,
		});
	}
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function stageFailure(
	error: unknown,
	message: string,
	reasonCode: "model-call-failed" | "validation-rejected" | "writer-failed",
	retryable: boolean,
): never {
	if (error instanceof EvolutionExecutionError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw error;
	throw new EvolutionExecutionError(message, { reasonCode, retryable, cause: error });
}

export class EvolutionPipeline implements EvolutionStageExecutor {
	readonly #dependencies: EvolutionPipelineDependencies;
	readonly #preReflectionStage: PreReflectionStage;
	readonly #producer: EvolutionArtifactProducer;

	constructor(dependencies: EvolutionPipelineDependencies) {
		this.#dependencies = dependencies;
		this.#preReflectionStage = dependencies.preReflectionStage ?? new DisabledPreReflectionStage();
		this.#producer = {
			name: PIPELINE_PRODUCER_NAME,
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
	}

	#metadata(
		artifactId: string,
		sourceIds: readonly string[],
		scope: EvolutionScope,
		createdAt: string,
		content: unknown,
	): EvolutionArtifactMetadata {
		return createEvolutionArtifactMetadata({
			artifactId,
			producer: this.#producer,
			sourceIds,
			scope,
			createdAt,
			content,
		});
	}

	#ledgerMetadata(
		eventId: string,
		context: EvolutionStageExecutionContext,
		content: unknown,
	): EvolutionArtifactMetadata {
		return this.#metadata(
			eventId,
			[context.job.jobId],
			context.job.metadata.scope,
			context.input.metadata.createdAt,
			content,
		);
	}

	#proposalDispositionEvent(
		context: EvolutionStageExecutionContext,
		scored: ScoredProposal,
		disposition: EvolutionProposalLedgerDisposition,
		reasonCodes: readonly string[] = scored.reasonCodes,
	): ProposalDispositionLedgerEvent {
		const content = { proposalId: scored.proposal.proposalId, disposition, reasonCodes };
		const eventId = stableId("ledger-event", { idempotencyKey: context.idempotencyKey, ...content });
		return {
			metadata: this.#ledgerMetadata(eventId, context, content),
			eventId,
			jobId: context.job.jobId,
			type: "proposal-disposition",
			proposalId: scored.proposal.proposalId,
			disposition,
			reasonCodes,
		};
	}

	#createCorpus(input: EvolutionInputSnapshot, idempotencyKey: string): EvidenceCorpusManifest {
		assertUniqueIds(
			input.evidenceSources.map((source) => source.sourceId),
			"evidence source ID",
		);
		const documents = input.evidenceSources.map((source) => {
			if (source.origin !== "product-runtime") {
				throw new EvolutionExecutionError("Frozen evolution snapshots may contain only product runtime evidence", {
					reasonCode: "snapshot-invalid",
					retryable: false,
				});
			}
			const actualDigest = computeEvolutionContentDigest(source.invocation);
			if (source.contentDigest !== actualDigest) {
				throw new EvolutionExecutionError(
					`Evidence source "${source.sourceId}" content digest does not match its invocation`,
					{ reasonCode: "snapshot-invalid", retryable: false },
				);
			}
			if (source.ingestionCursor > input.ingestionHighWaterCursor) {
				throw new EvolutionExecutionError(
					`Evidence source "${source.sourceId}" is after the frozen high-water cursor`,
					{
						reasonCode: "snapshot-invalid",
						retryable: false,
					},
				);
			}
			const documentId = stableId("corpus-document", {
				idempotencyKey,
				materializationId: source.materializationId,
				contentDigest: source.contentDigest,
			});
			return buildEvidenceCorpusDocument(documentId, source);
		});
		const artifactId = stableId("corpus-manifest", { idempotencyKey, documents });
		return {
			metadata: this.#metadata(
				artifactId,
				[input.metadata.artifactId, ...documents.map((document) => document.sourceId)],
				input.metadata.scope,
				input.metadata.createdAt,
				{ documents, excludedSources: [] },
			),
			documents,
			excludedSources: [],
		};
	}

	#createInstructionSnapshot(input: EvolutionInputSnapshot, idempotencyKey: string): InstructionSnapshot {
		for (const document of input.instructions) {
			if (computeEvolutionContentDigest(document.content) !== document.contentDigest) {
				throw new EvolutionExecutionError(`Instruction snapshot "${document.path}" has an invalid content digest`, {
					reasonCode: "snapshot-invalid",
					retryable: false,
				});
			}
		}
		const artifactId = stableId("instruction-snapshot", { idempotencyKey, documents: input.instructions });
		return {
			metadata: this.#metadata(
				artifactId,
				[input.metadata.artifactId],
				input.metadata.scope,
				input.metadata.createdAt,
				input.instructions,
			),
			documents: input.instructions,
		};
	}

	#pipelineInputs(context: EvolutionStageExecutionContext): {
		readonly corpus: EvidenceCorpusManifest;
		readonly counterReport: CounterReport | null;
		readonly instructions: InstructionSnapshot;
		readonly reflection: ReflectionResult | null;
		readonly proposals: readonly EvolutionProposal[];
	} {
		const coverage = optionalOne(context.priorArtifacts.filter(isCoverageMap), "evidence coverage map");
		return {
			corpus: requireOne(context.priorArtifacts.filter(isCorpus), "corpus manifest"),
			counterReport: optionalOne(context.priorArtifacts.filter(isCounterReport), "Counter report"),
			instructions: requireOne(context.priorArtifacts.filter(isInstructionSnapshot), "instruction snapshot"),
			reflection:
				coverage === null
					? null
					: {
							nodes: context.priorArtifacts.filter(isReflectionNode),
							lessons: context.priorArtifacts.filter(isLesson),
							coverage,
							finalLessonIds: coverage.finalLessonIds,
						},
			proposals: context.priorArtifacts.filter(isProposal),
		};
	}

	#createMutationBatch(context: EvolutionStageExecutionContext, selected: readonly ScoredProposal[]): MutationBatch {
		const proposals = selected.map((scored) => scored.proposal as EvolutionMemoryProposal);
		if (
			proposals.length === 0 ||
			proposals.some(
				(proposal) => proposal.target.expectedHarnessVersion !== context.input.expectedHarnessBaseVersion,
			)
		) {
			throw new EvolutionExecutionError("Selected proposals do not share the frozen harness base version", {
				reasonCode: "harness-base-conflict",
				retryable: false,
			});
		}
		const mutations = proposals.map((proposal) => ({
			mutationId: stableId("mutation", { idempotencyKey: context.idempotencyKey, proposalId: proposal.proposalId }),
			proposalId: proposal.proposalId,
			target: proposal.target,
			payload: proposal.exactDelta,
		}));
		const batchId = stableId("mutation-batch", { idempotencyKey: context.idempotencyKey, mutations });
		return {
			metadata: this.#metadata(
				batchId,
				[context.job.jobId, ...selected.map((scored) => scored.metadata.artifactId)],
				context.job.metadata.scope,
				context.input.metadata.createdAt,
				{ batchId, targetKind: "evolution-memory", mutations },
			),
			batchId,
			targetKind: "evolution-memory",
			mutations,
		};
	}

	async execute(context: EvolutionStageExecutionContext): Promise<EvolutionStageExecutionResult> {
		context.signal?.throwIfAborted();
		switch (context.job.stage) {
			case "snapshotting": {
				const corpus = this.#createCorpus(context.input, context.idempotencyKey);
				const instructions = this.#createInstructionSnapshot(context.input, context.idempotencyKey);
				return {
					artifacts: [corpus, instructions],
					state: {
						corpusManifestId: corpus.metadata.artifactId,
						instructionSnapshotId: instructions.metadata.artifactId,
					},
					directive: "continue",
				};
			}
			case "counter-slot": {
				const corpus = requireOne(context.priorArtifacts.filter(isCorpus), "corpus manifest");
				const counterReport = await this.#preReflectionStage.run({
					input: context.input,
					corpus,
					activeMemoryItems: context.input.harness.activeMemoryItems,
					idempotencyKey: context.idempotencyKey,
					signal: context.signal,
				});
				if (counterReport === null) return { artifacts: [], state: {}, directive: "continue" };
				return {
					artifacts: [counterReport],
					state: { counterReportId: counterReport.metadata.artifactId },
					directive: "continue",
				};
			}
			case "reflecting": {
				const { corpus, counterReport, instructions } = this.#pipelineInputs(context);
				let reflection: ReflectionResult;
				try {
					reflection = await this.#dependencies.reflector.reflect({
						jobId: context.job.jobId,
						input: context.input,
						corpus,
						counterReport,
						instructions,
						model: this.#dependencies.model,
						idempotencyKey: context.idempotencyKey,
						signal: context.signal,
					});
				} catch (error) {
					stageFailure(error, "Reflector model stage failed", "model-call-failed", true);
				}
				assertUniqueIds(
					reflection.nodes.map((node) => node.nodeId),
					"reflection node ID",
				);
				assertUniqueIds(
					reflection.lessons.map((lesson) => lesson.lessonId),
					"lesson ID",
				);
				return {
					artifacts: [...reflection.nodes, ...reflection.lessons, reflection.coverage],
					state: {
						reflectionNodeIds: reflection.nodes.map((node) => node.nodeId),
						lessonIds: reflection.lessons.map((lesson) => lesson.lessonId),
						coverageMapId: reflection.coverage.metadata.artifactId,
						finalLessonIds: reflection.finalLessonIds,
					},
					directive: "continue",
				};
			}
			case "curating": {
				const { corpus, instructions, reflection } = this.#pipelineInputs(context);
				if (reflection === null) {
					throw new EvolutionExecutionError("Evidence coverage is missing from reflection output", {
						reasonCode: "artifact-corrupt",
						retryable: false,
					});
				}
				let proposals: readonly EvolutionProposal[];
				try {
					proposals = await this.#dependencies.curator.curate({
						input: context.input,
						corpus,
						instructions,
						reflection,
						model: this.#dependencies.model,
						idempotencyKey: context.idempotencyKey,
						signal: context.signal,
					});
				} catch (error) {
					stageFailure(error, "Curator model stage failed", "model-call-failed", true);
				}
				assertUniqueIds(
					proposals.map((proposal) => proposal.proposalId),
					"proposal ID",
				);
				return {
					artifacts: proposals,
					state: { proposalIds: proposals.map((proposal) => proposal.proposalId) },
					directive: "continue",
				};
			}
			case "validating": {
				const { corpus, instructions, reflection, proposals } = this.#pipelineInputs(context);
				if (reflection === null) {
					throw new EvolutionExecutionError("Evidence coverage is missing from reflection output", {
						reasonCode: "artifact-corrupt",
						retryable: false,
					});
				}
				const validationInput = {
					input: context.input,
					corpus,
					instructions,
					reflection,
					proposals,
					signal: context.signal,
				};
				let validation: ValidationReport;
				let scoredProposals: readonly ScoredProposal[];
				try {
					validation = await this.#dependencies.validator.validate(validationInput);
					scoredProposals = await this.#dependencies.scorer.score({ ...validationInput, validation });
				} catch (error) {
					stageFailure(error, "Deterministic proposal validation failed", "validation-rejected", false);
				}
				assertScoredProposals(proposals, scoredProposals);
				assertValidationReport(proposals, validation, scoredProposals);
				const acceptedProposalIds = validation.proposalResults
					.filter((result) => result.disposition === "accepted")
					.map((result) => result.proposalId);
				const selectedProposalIds = scoredProposals
					.filter((scored) => scored.disposition === "selected")
					.map((scored) => scored.proposal.proposalId);
				if (acceptedProposalIds.length > 0 && selectedProposalIds.length === 0) {
					throw new EvolutionExecutionError("Accepted proposals produced no writable selection", {
						reasonCode: "validation-rejected",
						retryable: false,
					});
				}
				const ledgerEvents = scoredProposals.flatMap((scored): EvolutionLedgerEvent[] => {
					const disposition: EvolutionProposalLedgerDisposition | null =
						scored.disposition === "selected" ? null : scored.disposition;
					return disposition === null ? [] : [this.#proposalDispositionEvent(context, scored, disposition)];
				});
				return {
					artifacts: [validation, ...scoredProposals],
					ledgerEvents,
					state: {
						validationReportId: validation.metadata.artifactId,
						scoredProposalIds: scoredProposals.map((scored) => scored.metadata.artifactId),
						acceptedProposalIds,
						selectedProposalIds,
					},
					directive: acceptedProposalIds.length === 0 ? "complete-no-op" : "continue",
				};
			}
			case "writing": {
				const selected = context.priorArtifacts
					.filter(isScoredProposal)
					.filter((item) => item.disposition === "selected");
				const batch = this.#createMutationBatch(context, selected);
				const writer = this.#dependencies.targets.writerFor(batch.targetKind);
				if (writer === undefined || context.writerLease === null) {
					throw new EvolutionExecutionError("Evolution memory writer or writer lease is unavailable", {
						reasonCode: "writer-failed",
						retryable: true,
					});
				}
				let result: Awaited<ReturnType<typeof writer.write>>;
				try {
					result = await writer.write(batch, {
						idempotencyKey: context.idempotencyKey,
						lease: context.writerLease,
						signal: context.signal,
					});
				} catch (error) {
					stageFailure(error, `Mutation batch "${batch.batchId}" write failed`, "writer-failed", true);
				}
				if (result.status === "failed") {
					throw new EvolutionExecutionError(result.message ?? `Mutation batch "${batch.batchId}" failed`, {
						reasonCode: "writer-failed",
						retryable: true,
					});
				}
				const receiptId = stableId("write-receipt", { idempotencyKey: context.idempotencyKey, result });
				const receipt: MutationWriteReceipt = {
					metadata: this.#metadata(
						receiptId,
						[batch.metadata.artifactId],
						context.job.metadata.scope,
						context.input.metadata.createdAt,
						{ idempotencyKey: context.idempotencyKey, result },
					),
					batchId: batch.batchId,
					idempotencyKey: context.idempotencyKey,
					result,
				};
				return {
					artifacts: [batch, receipt],
					state: { mutationBatchId: batch.batchId, writeReceiptId: receiptId },
					directive: "continue",
				};
			}
			case "activating": {
				const batch = requireOne(context.priorArtifacts.filter(isMutationBatch), "mutation batch");
				const receipt = requireOne(context.priorArtifacts.filter(isMutationWriteReceipt), "mutation write receipt");
				const writer = this.#dependencies.targets.writerFor(batch.targetKind);
				if (writer === undefined || context.writerLease === null) {
					throw new EvolutionExecutionError("Evolution memory activator or writer lease is unavailable", {
						reasonCode: "writer-failed",
						retryable: true,
					});
				}
				let result: Awaited<ReturnType<typeof writer.activate>>;
				try {
					result = await writer.activate(batch, receipt.result, {
						idempotencyKey: context.idempotencyKey,
						lease: context.writerLease,
						signal: context.signal,
					});
				} catch (error) {
					stageFailure(error, `Mutation batch "${batch.batchId}" activation failed`, "writer-failed", true);
				}
				if (result.status === "failed" || result.resultingHarnessVersion === null) {
					throw new EvolutionExecutionError(
						result.message ?? `Mutation batch "${batch.batchId}" activation failed`,
						{
							reasonCode: "writer-failed",
							retryable: true,
						},
					);
				}
				const receiptId = stableId("activation-receipt", { idempotencyKey: context.idempotencyKey, result });
				const activationReceipt: HarnessActivationReceipt = {
					metadata: this.#metadata(
						receiptId,
						[receipt.metadata.artifactId],
						context.job.metadata.scope,
						context.input.metadata.createdAt,
						{ idempotencyKey: context.idempotencyKey, result },
					),
					batchId: batch.batchId,
					idempotencyKey: context.idempotencyKey,
					result,
				};
				const appliedEvents = context.priorArtifacts
					.filter(isScoredProposal)
					.filter((scored) => scored.disposition === "selected")
					.map((scored) => this.#proposalDispositionEvent(context, scored, "applied"));
				return {
					artifacts: [activationReceipt],
					ledgerEvents: appliedEvents,
					state: { activationReceiptId: receiptId },
					directive: "complete-activated",
					resultingHarnessVersion: result.resultingHarnessVersion,
				};
			}
			case "queued":
			case "completed":
				throw new EvolutionExecutionError(`Evolution stage "${context.job.stage}" is not executable`, {
					reasonCode: "pipeline-invariant",
					retryable: false,
				});
		}
	}
}
