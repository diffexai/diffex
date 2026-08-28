import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	computeHarnessSkillId,
	type HarnessSkill,
	type HarnessSkillInput,
	type HarnessStateStore,
	type HarnessVersionBundle,
	type HarnessWorkspaceIdentity,
	validateHarnessSkillContent,
} from "@earendil-works/diffex-harness-state";
import type {
	EvolutionArtifactProducer,
	EvolutionArtifactReference,
	EvolutionLeaseToken,
	EvolutionScope,
	HarnessActivationReceipt,
	HarnessActivationResult,
	MutationWriteReceipt,
	MutationWriteResult,
	SkillCandidateGroup,
	SkillDraft,
	SkillDraftValidationReport,
	SkillEvaluationReport,
	SkillMutation,
	SkillMutationBatch,
	SkillMutationExactDiff,
	SkillMutationWriteOutput,
} from "./contracts.ts";
import { EvolutionExecutionError } from "./errors.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionClock,
	EvolutionLeaseStore,
	SkillCandidateRegistry,
} from "./ports.ts";
import {
	computeEvolutionContentDigest,
	computeEvolutionTextDigest,
	createEvolutionArtifactMetadata,
	serializeEvolutionValue,
} from "./provenance.ts";

const CANDIDATE_SCHEMA_VERSION = 1 as const;
const ACTIVATION_SCHEMA_VERSION = 1 as const;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

interface StoredSkillWriterCandidate {
	readonly schemaVersion: typeof CANDIDATE_SCHEMA_VERSION;
	readonly writerVersion: string;
	readonly writtenAt: string;
	readonly writeIdempotencyKey: string;
	readonly candidateId: string;
	readonly candidateDigest: string;
	readonly batchId: string;
	readonly batchHash: string;
	readonly expectedBaseVersion: string;
	readonly resultingHarnessVersion: string;
	readonly operationIds: readonly string[];
	readonly afterSkills: readonly HarnessSkillInput[];
	readonly diff: SkillMutationExactDiff;
}

interface StoredSkillWriterActivation {
	readonly schemaVersion: typeof ACTIVATION_SCHEMA_VERSION;
	readonly batchId: string;
	readonly batchHash: string;
	readonly writeReceiptDigest: string;
	readonly activationIdempotencyKey: string;
	readonly receipt: HarnessActivationReceipt;
}

interface AcceptedSkillMutationSource {
	readonly group: SkillCandidateGroup;
	readonly draft: SkillDraft;
	readonly validation: SkillDraftValidationReport;
	readonly evaluation: SkillEvaluationReport;
}

export interface SkillWriterBuildInput {
	readonly scope: EvolutionScope;
	readonly groupId: string;
	readonly createdAt: string;
	readonly signal?: AbortSignal;
}

export interface SkillWriterContext {
	readonly idempotencyKey: string;
	readonly lease: EvolutionLeaseToken;
	readonly signal?: AbortSignal;
}

export interface SkillWriterDependencies {
	readonly version: string;
	readonly workspace: HarnessWorkspaceIdentity;
	readonly harnessState: HarnessStateStore;
	readonly artifacts: EvolutionArtifactStore;
	readonly registry: SkillCandidateRegistry;
	readonly leases: EvolutionLeaseStore;
	readonly clock: EvolutionClock;
	readonly statePath: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentWithoutMetadata<T extends { readonly metadata: unknown }>(value: T): Omit<T, "metadata"> {
	const { metadata: _metadata, ...content } = value;
	return content;
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = [...new Set(left)].sort((a, b) => a.localeCompare(b));
	const normalizedRight = [...new Set(right)].sort((a, b) => a.localeCompare(b));
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((value, index) => value === normalizedRight[index])
	);
}

function sameReference(left: EvolutionArtifactReference | null, right: EvolutionArtifactReference): boolean {
	return left?.artifactId === right.artifactId && left.contentDigest === right.contentDigest;
}

function sameWorkspace(
	left: { readonly repositoryId: string; readonly directoryId?: string },
	right: { readonly repositoryId: string; readonly directoryId?: string },
): boolean {
	return left.repositoryId === right.repositoryId && left.directoryId === right.directoryId;
}

function isSkillDraft(artifact: EvolutionArtifact): artifact is SkillDraft {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-draft";
}

function isSkillValidation(artifact: EvolutionArtifact): artifact is SkillDraftValidationReport {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-draft-validation";
}

function isSkillEvaluation(artifact: EvolutionArtifact): artifact is SkillEvaluationReport {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-evaluation";
}

function artifactReference(
	artifact: SkillDraft | SkillDraftValidationReport | SkillEvaluationReport,
): EvolutionArtifactReference {
	return {
		artifactId: artifact.metadata.artifactId,
		contentDigest: computeEvolutionContentDigest(artifact),
	};
}

function assertArtifactIdentity(
	artifact: SkillDraft | SkillDraftValidationReport | SkillEvaluationReport,
	reference: EvolutionArtifactReference,
	description: string,
): void {
	if (
		artifact.metadata.artifactId !== reference.artifactId ||
		artifact.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(artifact)) ||
		computeEvolutionContentDigest(artifact) !== reference.contentDigest
	) {
		throw new Error(`${description} immutable identity is invalid`);
	}
}

function assertWriterContext(context: SkillWriterContext): void {
	if (context.idempotencyKey.trim() === "") throw new Error("Skill writer idempotency key must be non-empty");
	if (context.lease.kind !== "writer" || context.lease.key !== "global") {
		throw new Error("Skill mutations require the global writer lease");
	}
}

function assertSafeId(value: string, description: string): void {
	if (!SAFE_ID_PATTERN.test(value)) throw new Error(`Invalid ${description} "${value}"`);
}

function skillInput(skill: HarnessSkill): HarnessSkillInput {
	return {
		path: skill.path,
		content: skill.content,
		workspace: {
			repositoryId: skill.workspace.repositoryId,
			...(skill.workspace.directoryId === undefined ? {} : { directoryId: skill.workspace.directoryId }),
		},
	};
}

function sortSkillInputs(skills: readonly HarnessSkillInput[]): HarnessSkillInput[] {
	return [...skills].sort((left, right) => left.path.localeCompare(right.path));
}

function outputForCandidate(candidate: StoredSkillWriterCandidate): SkillMutationWriteOutput {
	return {
		candidateId: candidate.candidateId,
		candidateDigest: candidate.candidateDigest,
		batchHash: candidate.batchHash,
		expectedBaseVersion: candidate.expectedBaseVersion,
		resultingHarnessVersion: candidate.resultingHarnessVersion,
		operationIds: candidate.operationIds,
		diff: candidate.diff,
	};
}

function parseWriteOutput(result: MutationWriteResult): SkillMutationWriteOutput {
	const output = result.output;
	if (
		result.status !== "written" ||
		!isRecord(output) ||
		typeof output.candidateId !== "string" ||
		typeof output.candidateDigest !== "string" ||
		typeof output.batchHash !== "string" ||
		typeof output.expectedBaseVersion !== "string" ||
		typeof output.resultingHarnessVersion !== "string" ||
		!Array.isArray(output.operationIds) ||
		!isRecord(output.diff) ||
		!Array.isArray(output.diff.removed) ||
		!Array.isArray(output.diff.added)
	) {
		throw new Error("Skill write receipt is invalid");
	}
	return output as SkillMutationWriteOutput;
}

function receiptContent(receipt: MutationWriteReceipt | HarnessActivationReceipt): Omit<typeof receipt, "metadata"> {
	return contentWithoutMetadata(receipt);
}

export class SkillWriter {
	readonly #dependencies: SkillWriterDependencies;
	readonly #producer: EvolutionArtifactProducer;
	readonly #statePath: string;
	readonly #candidatePath: string;
	readonly #activationPath: string;

	constructor(dependencies: SkillWriterDependencies) {
		if (dependencies.version.trim() === "") throw new Error("Skill writer version must be non-empty");
		if (dependencies.workspace.repositoryId.trim() === "") {
			throw new Error("Skill writer workspace repository ID must be non-empty");
		}
		this.#dependencies = dependencies;
		this.#producer = {
			name: "diffex-evolution-skill-writer",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
		this.#statePath = resolve(dependencies.statePath);
		this.#candidatePath = join(this.#statePath, "candidates");
		this.#activationPath = join(this.#statePath, "activations");
	}

	async #ensureDirectories(): Promise<void> {
		await mkdir(this.#candidatePath, { recursive: true, mode: 0o700 });
		await mkdir(this.#activationPath, { recursive: true, mode: 0o700 });
	}

	#candidateFile(batchId: string): string {
		assertSafeId(batchId, "skill mutation batch ID");
		return join(this.#candidatePath, `${batchId}.json`);
	}

	#activationFile(batchId: string): string {
		assertSafeId(batchId, "skill mutation batch ID");
		return join(this.#activationPath, `${batchId}.json`);
	}

	async #readOptional(path: string): Promise<string | null> {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
	}

	async #writeImmutable(path: string, value: unknown): Promise<void> {
		await this.#ensureDirectories();
		const serialized = `${serializeEvolutionValue(value)}\n`;
		const existing = await this.#readOptional(path);
		if (existing !== null) {
			if (existing !== serialized) throw new Error(`Immutable skill writer state at "${path}" changed`);
			return;
		}
		const temporaryDirectory = await mkdtemp(join(dirname(path), `.${basename(path)}.tmp-`));
		try {
			const temporaryFile = join(temporaryDirectory, basename(path));
			await writeFile(temporaryFile, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
			try {
				await link(temporaryFile, path);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
				const raced = await this.#readOptional(path);
				if (raced !== serialized) throw new Error(`Immutable skill writer state race at "${path}" changed`);
			}
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	async #loadCandidate(batchId: string): Promise<StoredSkillWriterCandidate | null> {
		const contents = await this.#readOptional(this.#candidateFile(batchId));
		if (contents === null) return null;
		const parsed: unknown = JSON.parse(contents);
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== CANDIDATE_SCHEMA_VERSION ||
			parsed.batchId !== batchId ||
			typeof parsed.writerVersion !== "string" ||
			typeof parsed.writtenAt !== "string" ||
			typeof parsed.writeIdempotencyKey !== "string" ||
			typeof parsed.candidateId !== "string" ||
			typeof parsed.candidateDigest !== "string" ||
			typeof parsed.batchHash !== "string" ||
			typeof parsed.expectedBaseVersion !== "string" ||
			typeof parsed.resultingHarnessVersion !== "string" ||
			!Array.isArray(parsed.operationIds) ||
			!Array.isArray(parsed.afterSkills) ||
			!isRecord(parsed.diff)
		) {
			throw new Error(`Skill writer candidate for "${batchId}" is invalid`);
		}
		const candidate = parsed as unknown as StoredSkillWriterCandidate;
		const { candidateDigest: _candidateDigest, ...content } = candidate;
		if (candidate.candidateDigest !== computeEvolutionContentDigest(content)) {
			throw new Error(`Skill writer candidate for "${batchId}" has an invalid digest`);
		}
		return candidate;
	}

	async #loadActivation(batchId: string): Promise<StoredSkillWriterActivation | null> {
		const contents = await this.#readOptional(this.#activationFile(batchId));
		if (contents === null) return null;
		const parsed: unknown = JSON.parse(contents);
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== ACTIVATION_SCHEMA_VERSION ||
			parsed.batchId !== batchId ||
			typeof parsed.batchHash !== "string" ||
			typeof parsed.writeReceiptDigest !== "string" ||
			typeof parsed.activationIdempotencyKey !== "string" ||
			!isRecord(parsed.receipt)
		) {
			throw new Error(`Skill writer activation for "${batchId}" is invalid`);
		}
		const activation = parsed as unknown as StoredSkillWriterActivation;
		if (
			activation.receipt.batchId !== batchId ||
			activation.receipt.idempotencyKey !== activation.activationIdempotencyKey ||
			activation.receipt.result.batchId !== batchId ||
			activation.receipt.result.status !== "activated" ||
			activation.receipt.metadata.contentDigest !== computeEvolutionContentDigest(receiptContent(activation.receipt))
		) {
			throw new Error(`Skill writer activation for "${batchId}" has an invalid receipt`);
		}
		return activation;
	}

	async #acceptedSource(scope: EvolutionScope, groupId: string): Promise<AcceptedSkillMutationSource> {
		const group = (await this.#dependencies.registry.list(scope)).find((candidate) => candidate.groupId === groupId);
		if (
			group === undefined ||
			group.state !== "accepted" ||
			group.draft === null ||
			group.validation === null ||
			group.evaluation === null
		) {
			throw new Error(`Candidate group "${groupId}" is not accepted for skill activation`);
		}
		const [draftArtifact, validationArtifact, evaluationArtifact] = await Promise.all([
			this.#dependencies.artifacts.get(group.draft),
			this.#dependencies.artifacts.get(group.validation),
			this.#dependencies.artifacts.get(group.evaluation),
		]);
		if (
			!isSkillDraft(draftArtifact) ||
			!isSkillValidation(validationArtifact) ||
			!isSkillEvaluation(evaluationArtifact)
		) {
			throw new Error(`Candidate group "${groupId}" has invalid writer prerequisites`);
		}
		assertArtifactIdentity(draftArtifact, group.draft, "Skill draft");
		assertArtifactIdentity(validationArtifact, group.validation, "Skill validation");
		assertArtifactIdentity(evaluationArtifact, group.evaluation, "Skill evaluation");
		if (
			group.profile.workspace.evolutionScope.repositoryId !== scope.repositoryId ||
			group.profile.workspace.evolutionScope.scopeId !== scope.scopeId ||
			draftArtifact.metadata.scope.repositoryId !== scope.repositoryId ||
			draftArtifact.metadata.scope.scopeId !== scope.scopeId ||
			validationArtifact.metadata.scope.repositoryId !== scope.repositoryId ||
			validationArtifact.metadata.scope.scopeId !== scope.scopeId ||
			evaluationArtifact.metadata.scope.repositoryId !== scope.repositoryId ||
			evaluationArtifact.metadata.scope.scopeId !== scope.scopeId ||
			draftArtifact.groupId !== group.groupId ||
			validationArtifact.groupId !== group.groupId ||
			evaluationArtifact.groupId !== group.groupId ||
			!sameReference(validationArtifact.draft, group.draft) ||
			!sameReference(evaluationArtifact.draft, group.draft) ||
			!sameReference(evaluationArtifact.validation, group.validation) ||
			validationArtifact.disposition !== "accepted" ||
			evaluationArtifact.disposition !== "accepted" ||
			!evaluationArtifact.gates.suite.passed ||
			!evaluationArtifact.gates.retrieval.passed ||
			!evaluationArtifact.gates.behavior.passed ||
			!sameValues(
				draftArtifact.proposalRevisionIds,
				group.proposalRevisions.map((revision) => revision.revisionId),
			) ||
			!sameValues(evaluationArtifact.proposalRevisionIds, draftArtifact.proposalRevisionIds)
		) {
			throw new Error(`Candidate group "${groupId}" accepted artifacts are stale or incomplete`);
		}
		return { group, draft: draftArtifact, validation: validationArtifact, evaluation: evaluationArtifact };
	}

	#mutationFor(source: AcceptedSkillMutationSource, base: HarnessVersionBundle): SkillMutation {
		const { group, draft, validation, evaluation } = source;
		if (
			!sameWorkspace(group.profile.workspace, this.#dependencies.workspace) ||
			!sameWorkspace(draft.workspace, this.#dependencies.workspace) ||
			!sameValues(group.profile.existingSkillIds, draft.existingSkillIds) ||
			new Set(draft.existingSkillIds).size !== draft.existingSkillIds.length ||
			!sameValues(
				draft.sourceSkillVersions.map((skill) => skill.skillId),
				draft.existingSkillIds,
			) ||
			draft.workspace.evolutionScope.repositoryId !== group.profile.workspace.evolutionScope.repositoryId ||
			draft.workspace.evolutionScope.scopeId !== group.profile.workspace.evolutionScope.scopeId ||
			validation.validatedHarnessVersion !== base.manifest.version ||
			evaluation.harnessVersion !== base.manifest.version
		) {
			throw new EvolutionExecutionError(
				"Accepted skill candidate does not match the active workspace and harness base",
				{
					reasonCode: "harness-base-conflict",
					retryable: false,
				},
			);
		}
		const expectedPath = `skills/${draft.proposedName}/SKILL.md`;
		validateHarnessSkillContent(expectedPath, draft.content);
		if (!sameValues(validation.canonicalInventory, [expectedPath])) {
			throw new Error(`Candidate group "${group.groupId}" has a noncanonical validated inventory`);
		}
		if (
			evaluation.candidateSkill.skillId !== draft.draftId ||
			evaluation.candidateSkill.name !== draft.proposedName ||
			evaluation.candidateSkill.version !== draft.metadata.contentDigest ||
			evaluation.candidateSkill.content !== draft.content ||
			evaluation.candidateSkill.contentDigest !== computeEvolutionContentDigest(draft.content)
		) {
			throw new Error(`Candidate group "${group.groupId}" evaluation does not match its draft`);
		}

		const skillsById = new Map(
			base.state.skills.map((skill) => [computeHarnessSkillId(skill.workspace, skill.path), skill] as const),
		);
		const existingSkills = draft.existingSkillIds.map((skillId) => {
			const skill = skillsById.get(skillId);
			if (skill === undefined || !sameWorkspace(skill.workspace, this.#dependencies.workspace)) {
				throw new Error(`Existing skill "${skillId}" is not an evolved skill in the frozen harness base`);
			}
			const frozenVersions = draft.sourceSkillVersions.filter((version) => version.skillId === skillId);
			if (
				frozenVersions.length === 0 ||
				frozenVersions.some(
					(version) => version.version !== skill.contentHash || version.contentDigest !== skill.contentHash,
				)
			) {
				throw new Error(`Existing skill "${skillId}" no longer matches its frozen digest`);
			}
			return { skillId, path: skill.path, contentDigest: skill.contentHash };
		});
		if (
			(draft.operation === "CREATE" && existingSkills.length !== 0) ||
			((draft.operation === "UPDATE" || draft.operation === "RETIRE") && existingSkills.length !== 1) ||
			(draft.operation === "MERGE" && existingSkills.length < 2)
		) {
			throw new Error(`Candidate group "${group.groupId}" has invalid ${draft.operation} mutation inputs`);
		}
		const draftReference = artifactReference(draft);
		const validationReference = artifactReference(validation);
		const evaluationReference = artifactReference(evaluation);
		return {
			mutationId: stableId("skill-mutation", {
				groupId: group.groupId,
				proposalRevisionIds: draft.proposalRevisionIds,
				draft: draftReference,
				validation: validationReference,
				evaluation: evaluationReference,
			}),
			groupId: group.groupId,
			operation: draft.operation,
			proposedName: draft.proposedName,
			workspace: {
				repositoryId: this.#dependencies.workspace.repositoryId,
				...(this.#dependencies.workspace.directoryId === undefined
					? {}
					: { directoryId: this.#dependencies.workspace.directoryId }),
			},
			proposalRevisionIds: draft.proposalRevisionIds,
			draft: draftReference,
			validation: validationReference,
			evaluation: evaluationReference,
			existingSkills,
			skill:
				draft.operation === "RETIRE"
					? null
					: {
							path: expectedPath,
							content: draft.content,
							contentDigest: computeEvolutionTextDigest(draft.content),
						},
		};
	}

	async buildMutationBatch(input: SkillWriterBuildInput): Promise<SkillMutationBatch> {
		input.signal?.throwIfAborted();
		if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("Skill mutation batch time must be valid");
		const base = await this.#dependencies.harnessState.loadCurrent();
		const source = await this.#acceptedSource(input.scope, input.groupId);
		const mutation = this.#mutationFor(source, base);
		const content = {
			batchId: stableId("skill-mutation-batch", {
				groupId: input.groupId,
				expectedBaseVersion: base.manifest.version,
				mutation,
			}),
			targetKind: "skill" as const,
			expectedBaseVersion: base.manifest.version,
			workspace: mutation.workspace,
			mutations: [mutation],
		};
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId: content.batchId,
				producer: this.#producer,
				sourceIds: [
					input.groupId,
					mutation.draft.artifactId,
					mutation.validation.artifactId,
					mutation.evaluation.artifactId,
				],
				scope: input.scope,
				createdAt: input.createdAt,
				content,
			}),
			...content,
		};
	}

	async #assertBatch(
		batch: SkillMutationBatch,
	): Promise<{ readonly base: HarnessVersionBundle; readonly mutation: SkillMutation }> {
		if (
			batch.targetKind !== "skill" ||
			batch.mutations.length !== 1 ||
			batch.metadata.artifactId !== batch.batchId ||
			batch.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(batch)) ||
			!sameWorkspace(batch.workspace, this.#dependencies.workspace)
		) {
			throw new Error(`Skill mutation batch "${batch.batchId}" is invalid`);
		}
		assertSafeId(batch.batchId, "skill mutation batch ID");
		const mutation = batch.mutations[0] as SkillMutation;
		assertSafeId(mutation.mutationId, "skill mutation ID");
		const base = await this.#dependencies.harnessState.loadVersion(batch.expectedBaseVersion);
		const source = await this.#acceptedSource(batch.metadata.scope, mutation.groupId);
		const expected = this.#mutationFor(source, base);
		if (serializeEvolutionValue(mutation) !== serializeEvolutionValue(expected)) {
			throw new Error(`Skill mutation batch "${batch.batchId}" does not match its accepted candidate`);
		}
		return { base, mutation };
	}

	#applyMutation(base: HarnessVersionBundle, mutation: SkillMutation): HarnessSkillInput[] {
		const removedPaths = new Set(mutation.existingSkills.map((skill) => skill.path));
		const after = base.state.skills.filter((skill) => !removedPaths.has(skill.path)).map(skillInput);
		if (mutation.skill !== null) {
			if (after.some((skill) => skill.path === mutation.skill?.path)) {
				throw new Error(`Skill mutation target "${mutation.skill.path}" already exists`);
			}
			after.push({
				path: mutation.skill.path,
				content: mutation.skill.content,
				workspace: mutation.workspace,
			});
		}
		return sortSkillInputs(after);
	}

	#writeReceipt(batch: SkillMutationBatch, candidate: StoredSkillWriterCandidate): MutationWriteReceipt {
		const result: MutationWriteResult = {
			batchId: batch.batchId,
			status: "written",
			output: outputForCandidate(candidate),
			message: null,
		};
		const content = { batchId: batch.batchId, idempotencyKey: candidate.writeIdempotencyKey, result };
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId: stableId("skill-write-receipt", {
					batchId: batch.batchId,
					idempotencyKey: candidate.writeIdempotencyKey,
				}),
				producer: this.#producer,
				sourceIds: [batch.batchId, ...candidate.operationIds],
				scope: batch.metadata.scope,
				createdAt: candidate.writtenAt,
				content,
			}),
			...content,
		};
	}

	async write(batch: SkillMutationBatch, context: SkillWriterContext): Promise<MutationWriteReceipt> {
		context.signal?.throwIfAborted();
		assertWriterContext(context);
		await this.#dependencies.leases.assertHeld(context.lease);
		const batchHash = computeEvolutionContentDigest(batch);
		const prior = await this.#loadCandidate(batch.batchId);
		if (prior !== null) {
			if (prior.batchHash !== batchHash || prior.writeIdempotencyKey !== context.idempotencyKey) {
				throw new Error(`Skill mutation batch "${batch.batchId}" was already staged with different content`);
			}
			return this.#writeReceipt(batch, prior);
		}

		const { base, mutation } = await this.#assertBatch(batch);
		const afterSkills = this.#applyMutation(base, mutation);
		const evolved = await this.#dependencies.harnessState.saveVersion(
			{ memory: base.state.memory, skills: afterSkills },
			batch.expectedBaseVersion,
			base.manifest.metadata,
		);
		const staged = await this.#dependencies.harnessState.loadVersion(evolved.manifest.version);
		if (
			staged.manifest.base !== batch.expectedBaseVersion ||
			staged.state.memory !== base.state.memory ||
			serializeEvolutionValue(sortSkillInputs(staged.state.skills.map(skillInput))) !==
				serializeEvolutionValue(afterSkills)
		) {
			throw new Error(`Skill mutation batch "${batch.batchId}" did not stage the complete harness bundle`);
		}
		const diff: SkillMutationExactDiff = {
			removed: mutation.existingSkills.map((skill) => ({
				skillId: skill.skillId,
				path: skill.path,
				contentDigest: skill.contentDigest,
			})),
			added:
				mutation.skill === null ? [] : [{ path: mutation.skill.path, contentDigest: mutation.skill.contentDigest }],
		};
		const candidateContent = {
			schemaVersion: CANDIDATE_SCHEMA_VERSION,
			writerVersion: this.#dependencies.version,
			writtenAt: this.#dependencies.clock.now(),
			writeIdempotencyKey: context.idempotencyKey,
			candidateId: stableId("skill-writer-candidate", { batchId: batch.batchId }),
			batchId: batch.batchId,
			batchHash,
			expectedBaseVersion: batch.expectedBaseVersion,
			resultingHarnessVersion: staged.manifest.version,
			operationIds: [mutation.mutationId],
			afterSkills,
			diff,
		};
		const candidate: StoredSkillWriterCandidate = {
			...candidateContent,
			candidateDigest: computeEvolutionContentDigest(candidateContent),
		};
		await this.#writeImmutable(this.#candidateFile(batch.batchId), candidate);
		return this.#writeReceipt(batch, candidate);
	}

	#activationReceipt(
		batch: SkillMutationBatch,
		idempotencyKey: string,
		result: HarnessActivationResult,
		createdAt: string,
	): HarnessActivationReceipt {
		const content = { batchId: batch.batchId, idempotencyKey, result };
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId: stableId("skill-activation-receipt", { batchId: batch.batchId, idempotencyKey }),
				producer: this.#producer,
				sourceIds: [batch.batchId, ...batch.mutations.map((mutation) => mutation.mutationId)],
				scope: batch.metadata.scope,
				createdAt,
				content,
			}),
			...content,
		};
	}

	async activate(
		batch: SkillMutationBatch,
		writeReceipt: MutationWriteReceipt,
		context: SkillWriterContext,
	): Promise<HarnessActivationReceipt> {
		context.signal?.throwIfAborted();
		assertWriterContext(context);
		await this.#dependencies.leases.assertHeld(context.lease);
		const prior = await this.#loadActivation(batch.batchId);
		const writeReceiptDigest = computeEvolutionContentDigest(writeReceipt);
		if (prior !== null) {
			if (
				prior.batchHash !== computeEvolutionContentDigest(batch) ||
				prior.writeReceiptDigest !== writeReceiptDigest ||
				prior.activationIdempotencyKey !== context.idempotencyKey
			) {
				throw new Error(`Skill mutation batch "${batch.batchId}" was already activated with different content`);
			}
			return prior.receipt;
		}
		await this.#assertBatch(batch);
		const output = parseWriteOutput(writeReceipt.result);
		const candidate = await this.#loadCandidate(batch.batchId);
		if (
			writeReceipt.batchId !== batch.batchId ||
			writeReceipt.idempotencyKey !== candidate?.writeIdempotencyKey ||
			writeReceipt.metadata.contentDigest !== computeEvolutionContentDigest(receiptContent(writeReceipt)) ||
			candidate === null ||
			candidate.batchHash !== computeEvolutionContentDigest(batch) ||
			candidate.candidateId !== output.candidateId ||
			candidate.candidateDigest !== output.candidateDigest ||
			serializeEvolutionValue(output) !== serializeEvolutionValue(outputForCandidate(candidate))
		) {
			throw new Error(`Skill mutation batch "${batch.batchId}" write receipt does not match its staged bundle`);
		}
		const base = await this.#dependencies.harnessState.loadVersion(candidate.expectedBaseVersion);
		const staged = await this.#dependencies.harnessState.loadVersion(candidate.resultingHarnessVersion);
		if (
			staged.manifest.base !== candidate.expectedBaseVersion ||
			staged.state.memory !== base.state.memory ||
			serializeEvolutionValue(sortSkillInputs(staged.state.skills.map(skillInput))) !==
				serializeEvolutionValue(candidate.afterSkills)
		) {
			throw new Error(`Skill mutation batch "${batch.batchId}" staged harness bundle is invalid`);
		}
		await this.#dependencies.leases.assertHeld(context.lease);
		const selection = await this.#dependencies.harnessState.selectVersionIfCurrent(
			candidate.resultingHarnessVersion,
			candidate.expectedBaseVersion,
		);
		if (selection.status === "conflict" && selection.actualCurrent !== candidate.resultingHarnessVersion) {
			throw new EvolutionExecutionError("Harness revision changed before skill activation", {
				reasonCode: "harness-base-conflict",
				retryable: false,
				diagnostics: {
					expectedHarnessVersion: selection.expectedCurrent,
					actualHarnessVersion: selection.actualCurrent,
				},
			});
		}
		const result: HarnessActivationResult = {
			batchId: batch.batchId,
			status: "activated",
			resultingHarnessVersion: candidate.resultingHarnessVersion,
			message: null,
		};
		const receipt = this.#activationReceipt(batch, context.idempotencyKey, result, this.#dependencies.clock.now());
		await this.#writeImmutable(this.#activationFile(batch.batchId), {
			schemaVersion: ACTIVATION_SCHEMA_VERSION,
			batchId: batch.batchId,
			batchHash: candidate.batchHash,
			writeReceiptDigest,
			activationIdempotencyKey: context.idempotencyKey,
			receipt,
		} satisfies StoredSkillWriterActivation);
		return receipt;
	}
}
