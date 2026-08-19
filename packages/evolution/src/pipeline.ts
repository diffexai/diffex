import type {
	ActiveEvolutionStage,
	CheckpointSavedLedgerEvent,
	EvidenceCorpusManifest,
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionCheckpoint,
	EvolutionInputSnapshot,
	EvolutionJob,
	EvolutionLedgerEvent,
	EvolutionMemoryProposal,
	EvolutionProposal,
	EvolutionProposalLedgerDisposition,
	EvolutionScope,
	FailedCheckpoint,
	InstructionSnapshot,
	JobCompletedLedgerEvent,
	JobCreatedLedgerEvent,
	JobFailedLedgerEvent,
	MutationBatch,
	MutationWriteResult,
	MutationWrittenLedgerEvent,
	ProposalDispositionLedgerEvent,
	ReflectionNode,
	ScoredProposal,
	ValidationReport,
} from "./contracts.ts";
import { EVOLUTION_SCHEMA_VERSION } from "./contracts.ts";
import type {
	Curator,
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionClock,
	EvolutionEventSink,
	EvolutionIdGenerator,
	EvolutionJobStore,
	EvolutionLedger,
	EvolutionModelExecutor,
	InstructionLoader,
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
	readonly clock: EvolutionClock;
	readonly ids: EvolutionIdGenerator;
	readonly model: EvolutionModelExecutor;
	readonly instructions: InstructionLoader;
	readonly reflector: Reflector;
	readonly curator: Curator;
	readonly validator: ProposalValidator;
	readonly scorer: ProposalScorer;
	readonly artifacts: EvolutionArtifactStore;
	readonly jobs: EvolutionJobStore;
	readonly ledger: EvolutionLedger;
	readonly events: EvolutionEventSink;
	readonly targets: EvolutionTargetAdapterRegistry;
}

export interface EvolutionRunResult {
	readonly job: EvolutionJob;
	readonly corpus: EvidenceCorpusManifest;
	readonly instructions: InstructionSnapshot;
	readonly reflection: ReflectionResult;
	readonly proposals: readonly EvolutionProposal[];
	readonly validation: ValidationReport;
	readonly scoredProposals: readonly ScoredProposal[];
	readonly mutationBatch: MutationBatch | null;
	readonly writeResult: MutationWriteResult | null;
}

function proposalDisposition(scored: ScoredProposal): EvolutionProposalLedgerDisposition | null {
	switch (scored.disposition) {
		case "deferred":
		case "rejected":
		case "superseded":
			return scored.disposition;
		case "selected":
			return null;
	}
}

function assertUniqueIds(values: readonly string[], description: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) throw new Error(`Duplicate ${description} "${value}"`);
		seen.add(value);
	}
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
		if (proposal === undefined) {
			throw new Error(`Scorer returned unknown proposal "${scored.proposal.proposalId}"`);
		}
		if (proposal !== scored.proposal) {
			throw new Error(`Scorer replaced proposal "${scored.proposal.proposalId}"`);
		}
		if (scored.disposition === "selected" && proposal.disposition !== "actionable") {
			throw new Error(`Deferred proposal "${proposal.proposalId}" cannot be selected`);
		}
	}
	if (scoredProposals.length !== proposals.length) {
		throw new Error("Scorer must return exactly one result for every proposal");
	}
}

export class EvolutionPipeline {
	readonly #dependencies: EvolutionPipelineDependencies;
	readonly #producer: EvolutionArtifactProducer;

	constructor(dependencies: EvolutionPipelineDependencies) {
		this.#dependencies = dependencies;
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

	#ledgerMetadata(eventId: string, job: EvolutionJob, createdAt: string, content: unknown): EvolutionArtifactMetadata {
		return this.#metadata(eventId, [job.jobId], job.metadata.scope, createdAt, content);
	}

	async #appendLedger(event: EvolutionLedgerEvent): Promise<void> {
		await this.#dependencies.ledger.append(event);
	}

	async #saveCheckpoint(job: EvolutionJob, checkpoint: EvolutionCheckpoint): Promise<EvolutionJob> {
		const updatedAt = this.#dependencies.clock.now();
		const status =
			checkpoint.stage === "completed" ? "completed" : checkpoint.stage === "failed" ? "failed" : "running";
		const content = {
			jobId: job.jobId,
			inputSnapshotId: job.inputSnapshotId,
			status,
			checkpoint,
			updatedAt,
		};
		const updated: EvolutionJob = {
			...job,
			metadata: this.#metadata(
				job.jobId,
				[job.inputSnapshotId],
				job.metadata.scope,
				job.metadata.createdAt,
				content,
			),
			status,
			checkpoint,
			updatedAt,
		};
		await this.#dependencies.jobs.save(updated);
		const eventId = this.#dependencies.ids.nextId("ledger-event");
		const event: CheckpointSavedLedgerEvent = {
			metadata: this.#ledgerMetadata(eventId, updated, updatedAt, checkpoint),
			eventId,
			jobId: updated.jobId,
			type: "checkpoint-saved",
			checkpoint,
		};
		await this.#appendLedger(event);
		await this.#dependencies.events.emit({
			jobId: updated.jobId,
			emittedAt: updatedAt,
			type: checkpoint.stage === "failed" ? "failed" : "checkpoint",
			checkpoint,
		});
		return updated;
	}

	async #putArtifacts(artifacts: readonly EvolutionArtifact[]): Promise<void> {
		for (const artifact of artifacts) await this.#dependencies.artifacts.put(artifact);
	}

	#createCorpus(input: EvolutionInputSnapshot): EvidenceCorpusManifest {
		assertUniqueIds(
			input.evidenceSources.map((source) => source.sourceId),
			"evidence source ID",
		);
		const documents = input.evidenceSources
			.filter((source) => source.origin === "product-runtime")
			.map((source) => {
				const actualDigest = computeEvolutionContentDigest(source.invocation);
				if (source.contentDigest !== actualDigest) {
					throw new Error(`Evidence source "${source.sourceId}" content digest does not match its invocation`);
				}
				return {
					documentId: this.#dependencies.ids.nextId("corpus-document"),
					sourceId: source.sourceId,
					contentDigest: source.contentDigest,
					materializedInvocationVersion: source.invocation.version,
					traceId: source.invocation.traceId,
					integrity: source.invocation.integrity,
					terminationStatus: source.invocation.terminationStatus,
					evidenceIds: source.invocation.evidence.map((evidence) => evidence.evidenceId),
				};
			});
		const excludedSources = input.evidenceSources
			.filter((source) => source.origin === "evolution-pipeline")
			.map((source) => ({ sourceId: source.sourceId, reason: "evolution-pipeline-origin" as const }));
		const artifactId = this.#dependencies.ids.nextId("corpus-manifest");
		const createdAt = this.#dependencies.clock.now();
		return {
			metadata: this.#metadata(
				artifactId,
				[input.metadata.artifactId, ...documents.map((document) => document.sourceId)],
				input.metadata.scope,
				createdAt,
				{ documents, excludedSources },
			),
			documents,
			excludedSources,
		};
	}

	#createMutationBatch(job: EvolutionJob, selected: readonly ScoredProposal[]): MutationBatch | null {
		if (selected.length === 0) return null;
		const proposals = selected.map((scored) => scored.proposal as EvolutionMemoryProposal);
		const expectedHarnessVersion = proposals[0]?.target.expectedHarnessVersion;
		if (expectedHarnessVersion === undefined) return null;
		if (proposals.some((proposal) => proposal.target.expectedHarnessVersion !== expectedHarnessVersion)) {
			throw new Error("Selected proposals do not share one expected harness version");
		}
		const mutations = proposals.map((proposal) => ({
			mutationId: this.#dependencies.ids.nextId("mutation"),
			proposalId: proposal.proposalId,
			target: proposal.target,
			payload: proposal.executablePayload,
		}));
		const batchId = this.#dependencies.ids.nextId("mutation-batch");
		const createdAt = this.#dependencies.clock.now();
		return {
			metadata: this.#metadata(
				batchId,
				[job.jobId, ...selected.map((scored) => scored.metadata.artifactId)],
				job.metadata.scope,
				createdAt,
				{ batchId, targetKind: "evolution-memory", mutations },
			),
			batchId,
			targetKind: "evolution-memory",
			mutations,
		};
	}

	async #recordProposalDisposition(
		job: EvolutionJob,
		scored: ScoredProposal,
		disposition: EvolutionProposalLedgerDisposition,
		reasonCodes: readonly string[] = scored.reasonCodes,
	): Promise<void> {
		const eventId = this.#dependencies.ids.nextId("ledger-event");
		const createdAt = this.#dependencies.clock.now();
		const content = { proposalId: scored.proposal.proposalId, disposition, reasonCodes };
		const event: ProposalDispositionLedgerEvent = {
			metadata: this.#ledgerMetadata(eventId, job, createdAt, content),
			eventId,
			jobId: job.jobId,
			type: "proposal-disposition",
			proposalId: scored.proposal.proposalId,
			disposition,
			reasonCodes,
		};
		await this.#appendLedger(event);
	}

	async run(input: EvolutionInputSnapshot): Promise<EvolutionRunResult> {
		const jobId = this.#dependencies.ids.nextId("job");
		const createdAt = this.#dependencies.clock.now();
		const initialCheckpoint = { schemaVersion: EVOLUTION_SCHEMA_VERSION, stage: "created" } as const;
		const initialContent = {
			jobId,
			inputSnapshotId: input.metadata.artifactId,
			status: "running",
			checkpoint: initialCheckpoint,
			updatedAt: createdAt,
		};
		let job: EvolutionJob = {
			metadata: this.#metadata(jobId, [input.metadata.artifactId], input.metadata.scope, createdAt, initialContent),
			jobId,
			inputSnapshotId: input.metadata.artifactId,
			status: "running",
			checkpoint: initialCheckpoint,
			updatedAt: createdAt,
		};
		await this.#dependencies.artifacts.put(input);
		await this.#dependencies.jobs.create(job);
		const createdEventId = this.#dependencies.ids.nextId("ledger-event");
		const createdEvent: JobCreatedLedgerEvent = {
			metadata: this.#ledgerMetadata(createdEventId, job, createdAt, initialContent),
			eventId: createdEventId,
			jobId,
			type: "job-created",
			inputSnapshotId: input.metadata.artifactId,
		};
		await this.#appendLedger(createdEvent);
		await this.#dependencies.events.emit({
			jobId,
			emittedAt: createdAt,
			type: "started",
			checkpoint: initialCheckpoint,
		});

		let activeStage: ActiveEvolutionStage = "created";
		try {
			const corpus = this.#createCorpus(input);
			const instructions = await this.#dependencies.instructions.load(input);
			await this.#putArtifacts([corpus, instructions]);
			activeStage = "corpus-prepared";
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: activeStage,
				corpusManifestId: corpus.metadata.artifactId,
				instructionSnapshotId: instructions.metadata.artifactId,
			});

			const reflection = await this.#dependencies.reflector.reflect({
				input,
				corpus,
				instructions,
				model: this.#dependencies.model,
			});
			await this.#putArtifacts([...reflection.nodes, ...reflection.lessons]);
			activeStage = "reflected";
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: activeStage,
				reflectionNodeIds: reflection.nodes.map((node: ReflectionNode) => node.nodeId),
				lessonIds: reflection.lessons.map((lesson) => lesson.lessonId),
			});

			const proposals = await this.#dependencies.curator.curate({
				input,
				corpus,
				instructions,
				reflection,
				model: this.#dependencies.model,
			});
			assertUniqueIds(
				proposals.map((proposal) => proposal.proposalId),
				"proposal ID",
			);
			await this.#putArtifacts(proposals);
			activeStage = "curated";
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: activeStage,
				proposalIds: proposals.map((proposal) => proposal.proposalId),
			});

			const validationInput = { input, corpus, instructions, reflection, proposals };
			const validation = await this.#dependencies.validator.validate(validationInput);
			await this.#dependencies.artifacts.put(validation);
			activeStage = "validated";
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: activeStage,
				validationReportId: validation.metadata.artifactId,
			});

			const scoredProposals = await this.#dependencies.scorer.score({ ...validationInput, validation });
			assertScoredProposals(proposals, scoredProposals);
			await this.#putArtifacts(scoredProposals);
			activeStage = "scored";
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: activeStage,
				scoredProposalIds: scoredProposals.map((scored) => scored.metadata.artifactId),
			});
			for (const scored of scoredProposals) {
				const disposition = proposalDisposition(scored);
				if (disposition !== null) await this.#recordProposalDisposition(job, scored, disposition);
			}

			const selected = scoredProposals.filter((scored) => scored.disposition === "selected");
			const mutationBatch = this.#createMutationBatch(job, selected);
			let writeResult: MutationWriteResult | null = null;
			if (mutationBatch !== null) {
				await this.#dependencies.artifacts.put(mutationBatch);
				const writer = this.#dependencies.targets.writerFor(mutationBatch.targetKind);
				if (writer === undefined) {
					throw new Error(`No enabled writer for evolution target "${mutationBatch.targetKind}"`);
				}
				writeResult = await writer.write(mutationBatch);
				const writeEventId = this.#dependencies.ids.nextId("ledger-event");
				const writeEvent: MutationWrittenLedgerEvent = {
					metadata: this.#ledgerMetadata(writeEventId, job, this.#dependencies.clock.now(), writeResult),
					eventId: writeEventId,
					jobId,
					type: "mutation-written",
					batchId: mutationBatch.batchId,
					writeResult,
				};
				await this.#appendLedger(writeEvent);
				for (const scored of selected) {
					await this.#recordProposalDisposition(
						job,
						scored,
						writeResult.status === "applied" ? "applied" : "failed",
						writeResult.status === "applied" ? scored.reasonCodes : ["writer-failed"],
					);
				}
			}
			activeStage = "written";
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: activeStage,
				mutationBatchId: mutationBatch?.batchId ?? null,
				writeResult,
			});
			if (writeResult?.status === "failed") {
				throw new Error(writeResult.message ?? `Mutation batch "${writeResult.batchId}" failed`);
			}

			const resultingHarnessVersion = writeResult?.resultingHarnessVersion ?? null;
			job = await this.#saveCheckpoint(job, {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: "completed",
				resultingHarnessVersion,
			});
			const completedEventId = this.#dependencies.ids.nextId("ledger-event");
			const completedEvent: JobCompletedLedgerEvent = {
				metadata: this.#ledgerMetadata(completedEventId, job, this.#dependencies.clock.now(), {
					resultingHarnessVersion,
				}),
				eventId: completedEventId,
				jobId,
				type: "job-completed",
				resultingHarnessVersion,
			};
			await this.#appendLedger(completedEvent);
			return {
				job,
				corpus,
				instructions,
				reflection,
				proposals,
				validation,
				scoredProposals,
				mutationBatch,
				writeResult,
			};
		} catch (error) {
			const failedCheckpoint: FailedCheckpoint = {
				schemaVersion: EVOLUTION_SCHEMA_VERSION,
				stage: "failed",
				failedStage: activeStage,
				message: error instanceof Error ? error.message : String(error),
			};
			job = await this.#saveCheckpoint(job, failedCheckpoint);
			const failedEventId = this.#dependencies.ids.nextId("ledger-event");
			const failedEvent: JobFailedLedgerEvent = {
				metadata: this.#ledgerMetadata(failedEventId, job, this.#dependencies.clock.now(), failedCheckpoint),
				eventId: failedEventId,
				jobId,
				type: "job-failed",
				failedStage: activeStage,
				message: failedCheckpoint.message,
			};
			await this.#appendLedger(failedEvent);
			throw error;
		}
	}
}
