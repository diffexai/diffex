import { validateHarnessSkillContent } from "@earendil-works/diffex-harness-state";
import type {
	EvolutionArtifactProducer,
	EvolutionArtifactReference,
	EvolutionInputSnapshot,
	EvolutionSkillCatalogEntry,
	SkillCandidate,
	SkillCandidateGroup,
	SkillDraftValidationIssue,
	SkillDraftValidationReport,
} from "./contracts.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionJobStore,
	SkillDraftValidationEnvironment,
	SkillDraftValidationEnvironmentSource,
	SkillDraftValidator,
	SkillDraftValidatorInput,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";

const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;
const MINIMUM_INDEPENDENT_TASKS = 2;
const SECRET_PATTERNS = [
	/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
	/\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_+./=-]{16,}/i,
] as const;
const MARKDOWN_TARGET_PATTERN = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const HTML_TARGET_PATTERN = /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu;

interface CandidateSource {
	readonly candidate: SkillCandidate;
	readonly input: EvolutionInputSnapshot;
	readonly jobId: string;
	readonly selectedMemoryProposalIds: readonly string[];
	readonly resultingHarnessVersion: string | null;
}

export interface DeterministicSkillDraftValidatorDependencies {
	readonly version: string;
	readonly artifacts: EvolutionArtifactStore;
	readonly jobs: EvolutionJobStore;
	readonly environment: SkillDraftValidationEnvironmentSource;
}

export interface DeterministicSkillDraftValidatorOptions {
	readonly maxContentBytes?: number;
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = uniqueSorted(left);
	const normalizedRight = uniqueSorted(right);
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((value, index) => value === normalizedRight[index])
	);
}

function sameReference(left: EvolutionArtifactReference | null, right: EvolutionArtifactReference): boolean {
	return left?.artifactId === right.artifactId && left.contentDigest === right.contentDigest;
}

function contentWithoutMetadata<T extends { readonly metadata: unknown }>(value: T): Omit<T, "metadata"> {
	const { metadata: _metadata, ...content } = value;
	return content;
}

function isInputSnapshot(artifact: EvolutionArtifact): artifact is EvolutionInputSnapshot {
	return "evidenceSources" in artifact && "repository" in artifact && "harness" in artifact && "trigger" in artifact;
}

function isSkillCandidate(artifact: EvolutionArtifact): artifact is SkillCandidate {
	return "artifactKind" in artifact && artifact.artifactKind === "skill-candidate";
}

function normalizedText(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function localReferenceTargets(content: string): string[] {
	const targets = [...content.matchAll(MARKDOWN_TARGET_PATTERN), ...content.matchAll(HTML_TARGET_PATTERN)].flatMap(
		(match) => match[1] ?? [],
	);
	return uniqueSorted(
		targets.filter((target) => {
			if (target.startsWith("#") || target.startsWith("//")) return false;
			return !/^[a-z][a-z0-9+.-]*:/iu.test(target);
		}),
	);
}

function issue(code: string, message: string): SkillDraftValidationIssue {
	return { code, message };
}

function workspaceMatches(group: SkillCandidateGroup, environment: SkillDraftValidationEnvironment): boolean {
	return (
		group.profile.workspace.repositoryId === environment.workspace.repositoryId &&
		group.profile.workspace.directoryId === environment.workspace.directoryId
	);
}

function skillVersionKey(value: {
	readonly skillId: string;
	readonly version: string;
	readonly contentDigest: string;
}): string {
	return `${value.skillId}\u0000${value.version}\u0000${value.contentDigest}`;
}

function latestCatalogVersions(source: CandidateSource): readonly EvolutionSkillCatalogEntry[] {
	return source.candidate.existingSkillIds.flatMap((skillId) => {
		const matches = source.input.skillCatalog.filter((skill) => skill.skillId === skillId);
		return matches.length === 1 ? matches : [];
	});
}

export class DeterministicSkillDraftValidator implements SkillDraftValidator {
	readonly #dependencies: DeterministicSkillDraftValidatorDependencies;
	readonly #producer: EvolutionArtifactProducer;
	readonly #maxContentBytes: number;

	constructor(
		dependencies: DeterministicSkillDraftValidatorDependencies,
		options: DeterministicSkillDraftValidatorOptions = {},
	) {
		this.#dependencies = dependencies;
		this.#producer = {
			name: "diffex-skill-draft-validator",
			version: dependencies.version,
			promptVersion: null,
			model: null,
		};
		this.#maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
		if (!Number.isSafeInteger(this.#maxContentBytes) || this.#maxContentBytes < 1) {
			throw new Error("maxContentBytes must be a positive integer");
		}
	}

	async validate(input: SkillDraftValidatorInput): Promise<SkillDraftValidationReport> {
		input.signal?.throwIfAborted();
		const issues: SkillDraftValidationIssue[] = [];
		const add = (code: string, message: string) => issues.push(issue(code, message));
		const draftReference = {
			artifactId: input.draft.metadata.artifactId,
			contentDigest: computeEvolutionContentDigest(input.draft),
		};
		if (
			input.draft.artifactKind !== "skill-draft" ||
			input.draft.draftId === "" ||
			input.draft.metadata.artifactId !== input.draft.draftId ||
			input.draft.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(input.draft)) ||
			input.draft.groupId !== input.group.groupId ||
			input.draft.synthesisIdempotencyKey !== input.group.synthesisIdempotencyKey ||
			!sameReference(input.group.draft, draftReference) ||
			input.group.state !== "drafted"
		) {
			add("draft-identity-invalid", "The draft does not match the immutable drafted candidate group");
		}
		if (
			!sameValues(
				input.draft.proposalRevisionIds,
				input.group.proposalRevisions.map((revision) => revision.revisionId),
			)
		) {
			add("proposal-revision-closure-invalid", "The draft does not retain the complete proposal revision set");
		}

		const sources: CandidateSource[] = [];
		for (const revision of input.group.proposalRevisions) {
			input.signal?.throwIfAborted();
			const artifact = await this.#dependencies.artifacts.get(revision.candidate);
			if (
				!isSkillCandidate(artifact) ||
				artifact.candidateId !== revision.candidateId ||
				artifact.metadata.artifactId !== revision.candidateId ||
				artifact.metadata.contentDigest !== computeEvolutionContentDigest(contentWithoutMetadata(artifact)) ||
				computeEvolutionContentDigest(artifact) !== revision.candidate.contentDigest
			) {
				add("candidate-provenance-invalid", `Candidate revision "${revision.revisionId}" is not immutable`);
				continue;
			}
			const job = await this.#dependencies.jobs.load(revision.sourceEvolutionJobId);
			if (job === null || job.outcome !== "completed" || job.stage !== "completed") {
				add("source-job-unavailable", `Source evolution job "${revision.sourceEvolutionJobId}" is unavailable`);
				continue;
			}
			const inputArtifact = await this.#dependencies.artifacts.get(job.inputSnapshot);
			if (!isInputSnapshot(inputArtifact)) {
				add("source-snapshot-invalid", `Source evolution job "${job.jobId}" has an invalid input snapshot`);
				continue;
			}
			const checkpoint = job.checkpoints.find((candidate) => candidate.stage === "skill-curating");
			const selectedMemoryProposalIds =
				checkpoint !== undefined && Array.isArray(checkpoint.state.selectedMemoryProposalIds)
					? checkpoint.state.selectedMemoryProposalIds.filter(
							(proposalId): proposalId is string => typeof proposalId === "string",
						)
					: [];
			sources.push({
				candidate: artifact,
				input: inputArtifact,
				jobId: job.jobId,
				selectedMemoryProposalIds,
				resultingHarnessVersion: job.completion?.resultingHarnessVersion ?? null,
			});
		}

		const candidates = sources.map((source) => source.candidate);
		if (
			!sameValues(
				input.draft.sourceCandidateIds,
				candidates.map((candidate) => candidate.candidateId),
			)
		) {
			add("candidate-closure-invalid", "The draft source candidate closure is incomplete");
		}
		const expectedEvidenceIds = uniqueSorted(
			candidates.flatMap((candidate) => [...candidate.supportingEvidenceIds, ...candidate.contradictingEvidenceIds]),
		);
		if (!sameValues(input.draft.sourceEvidenceIds, expectedEvidenceIds)) {
			add("evidence-closure-invalid", "The draft source evidence closure is incomplete");
		}
		const expectedTraceIds = uniqueSorted(
			candidates.flatMap((candidate) => [...candidate.supportingTraceIds, ...candidate.contradictingTraceIds]),
		);
		if (!sameValues(input.draft.sourceTraceIds, expectedTraceIds)) {
			add("trace-closure-invalid", "The draft source trace closure is incomplete");
		}
		const expectedInstructionDigests = uniqueSorted(
			sources.flatMap((source) => source.input.instructions.map((instruction) => instruction.contentDigest)),
		);
		if (!sameValues(input.draft.repositoryInstructionDigests, expectedInstructionDigests)) {
			add("instruction-closure-invalid", "The draft repository instruction closure is incomplete");
		}
		const expectedSkillVersions = uniqueSorted(
			sources.flatMap((source) =>
				source.candidate.existingSkillIds.flatMap((skillId) =>
					source.input.skillCatalog
						.filter((skill) => skill.skillId === skillId)
						.map((skill) => skillVersionKey(skill)),
				),
			),
		);
		if (!sameValues(input.draft.sourceSkillVersions.map(skillVersionKey), expectedSkillVersions)) {
			add("source-skill-closure-invalid", "The draft source skill version closure is incomplete");
		}

		const derivedSupportingLineages = new Set<string>();
		const derivedContradictingLineages = new Set<string>();
		for (const source of sources) {
			const evidenceById = new Map(
				source.input.evidenceSources.flatMap((evidenceSource) =>
					evidenceSource.invocation.evidence.map((evidence) => [evidence.evidenceId, evidence] as const),
				),
			);
			const derive = (evidenceIds: readonly string[], target: Set<string>) => {
				for (const evidenceId of evidenceIds) {
					const evidence = evidenceById.get(evidenceId);
					if (evidence === undefined) {
						add(
							"evidence-source-missing",
							`Candidate "${source.candidate.candidateId}" cites unavailable evidence`,
						);
						continue;
					}
					for (const identifier of evidence.order.causalIdentifiers) {
						const name = identifier.name.toLocaleLowerCase("en-US");
						if (name.includes("task") && name.includes("lineage")) target.add(identifier.value);
					}
				}
			};
			const supporting = new Set<string>();
			const contradicting = new Set<string>();
			derive(source.candidate.supportingEvidenceIds, supporting);
			derive(source.candidate.contradictingEvidenceIds, contradicting);
			if (!sameValues(source.candidate.taskLineageIds, [...supporting, ...contradicting])) {
				add(
					"candidate-lineage-closure-invalid",
					`Candidate "${source.candidate.candidateId}" has invalid task lineage closure`,
				);
			}
			for (const lineageId of supporting) derivedSupportingLineages.add(lineageId);
			for (const lineageId of contradicting) derivedContradictingLineages.add(lineageId);
			if (!sameValues(source.candidate.memoryRelationship.memoryProposalIds, source.selectedMemoryProposalIds)) {
				add(
					"memory-relationship-stale",
					`Candidate "${source.candidate.candidateId}" does not match its selected memory proposals`,
				);
			}
		}
		if (
			derivedSupportingLineages.size < MINIMUM_INDEPENDENT_TASKS ||
			!sameValues(input.group.evidence.supportingTaskLineageIds, [...derivedSupportingLineages]) ||
			!sameValues(input.group.evidence.contradictingTaskLineageIds, [...derivedContradictingLineages])
		) {
			add("independent-recurrence-invalid", "The final draft does not retain independently recurring evidence");
		}

		const environment = await this.#dependencies.environment.capture(input.group.profile.workspace, input.signal);
		if (!workspaceMatches(input.group, environment)) {
			add("workspace-scope-mismatch", "The active workspace does not match the candidate workspace");
		}
		const latest = sources.at(-1);
		if (latest === undefined) {
			add("final-candidate-missing", "The final candidate revision is unavailable");
		} else {
			const expectedHarnessVersion = latest.resultingHarnessVersion ?? latest.input.expectedHarnessBaseVersion;
			if (environment.harnessVersion !== expectedHarnessVersion) {
				add("harness-base-stale", "The active harness no longer matches the final candidate base");
			}
			if (
				input.draft.operation !== latest.candidate.operation ||
				input.draft.proposedName !== latest.candidate.proposedName ||
				!sameValues(input.draft.existingSkillIds, latest.candidate.existingSkillIds) ||
				input.draft.workspace.repositoryId !== latest.candidate.workspace.repositoryId ||
				input.draft.workspace.directoryId !== latest.candidate.workspace.directoryId ||
				input.draft.workspace.rootPath !== latest.candidate.workspace.rootPath ||
				input.draft.workspace.repositoryRevision !== latest.candidate.workspace.repositoryRevision ||
				input.draft.workspace.evolutionScope.repositoryId !==
					latest.candidate.workspace.evolutionScope.repositoryId ||
				input.draft.workspace.evolutionScope.scopeId !== latest.candidate.workspace.evolutionScope.scopeId
			) {
				add("final-candidate-mismatch", "The draft does not match the final candidate operation and scope");
			}
			const activeVersions = new Map(environment.skillVersions.map((skill) => [skill.skillId, skill]));
			for (const frozen of latestCatalogVersions(latest)) {
				const active = activeVersions.get(frozen.skillId);
				if (
					active === undefined ||
					active.version !== frozen.version ||
					active.contentDigest !== frozen.contentDigest
				) {
					add("source-skill-stale", `Source skill "${frozen.skillId}" is no longer at its frozen version`);
				}
			}
			const normalizedContent = normalizedText(input.draft.content);
			for (const boundary of latest.candidate.applicabilityBoundaries) {
				if (!normalizedContent.includes(normalizedText(boundary))) {
					add("applicability-boundary-missing", `The draft omits applicability boundary "${boundary}"`);
				}
			}
			for (const counterexample of latest.candidate.trigger.negativeExamples) {
				if (!normalizedContent.includes(normalizedText(counterexample))) {
					add("counterexample-missing", `The draft omits counterexample "${counterexample}"`);
				}
			}
			for (const acceptanceCriterion of [
				...latest.candidate.verificationContract.checks,
				latest.candidate.verificationContract.completionCondition,
			]) {
				if (!normalizedContent.includes(normalizedText(acceptanceCriterion))) {
					add("acceptance-criterion-missing", `The draft omits acceptance criterion "${acceptanceCriterion}"`);
				}
			}
		}

		const inventoryPath = `skills/${input.draft.proposedName}/SKILL.md`;
		try {
			validateHarnessSkillContent(inventoryPath, input.draft.content);
		} catch (error) {
			add("skill-structure-invalid", error instanceof Error ? error.message : "The skill structure is invalid");
		}
		if (Buffer.byteLength(input.draft.content, "utf8") > this.#maxContentBytes) {
			add("skill-content-too-large", `The skill exceeds the ${this.#maxContentBytes}-byte size limit`);
		}
		if (input.draft.content.includes("\u0000")) add("skill-content-invalid", "The skill contains a NUL byte");
		if (SECRET_PATTERNS.some((pattern) => pattern.test(input.draft.content))) {
			add("sensitive-data-detected", "The skill violates the sensitive-data policy");
		}
		const localTargets = localReferenceTargets(input.draft.content);
		if (localTargets.length > 0) {
			add(
				"undeclared-reference",
				`Instruction-only skill drafts cannot reference undeclared local files: ${localTargets.join(", ")}`,
			);
		}

		const sortedIssues = [...issues].sort(
			(left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message),
		);
		const content = {
			artifactKind: "skill-draft-validation" as const,
			validationId: `skill-draft-validation-${computeEvolutionContentDigest({
				groupId: input.group.groupId,
				draft: draftReference,
				harnessVersion: environment.harnessVersion,
				issues: sortedIssues,
			}).slice("sha256:".length, "sha256:".length + 32)}`,
			groupId: input.group.groupId,
			draft: draftReference,
			validatorVersion: this.#dependencies.version,
			assurance: "structure-provenance-scope-and-security-only" as const,
			disposition: sortedIssues.length === 0 ? ("accepted" as const) : ("rejected" as const),
			issues: sortedIssues,
			validatedHarnessVersion: environment.harnessVersion,
			validatedSkillVersions: uniqueSorted(environment.skillVersions.map(skillVersionKey)),
			canonicalInventory: [inventoryPath],
			memoryRelationshipDigest: computeEvolutionContentDigest(
				candidates.map((candidate) => ({
					candidateId: candidate.candidateId,
					memoryRelationship: candidate.memoryRelationship,
				})),
			),
		};
		return {
			metadata: createEvolutionArtifactMetadata({
				artifactId: content.validationId,
				producer: this.#producer,
				sourceIds: uniqueSorted([input.draft.draftId, ...input.draft.sourceCandidateIds]),
				scope: input.draft.metadata.scope,
				createdAt: input.createdAt,
				content,
			}),
			...content,
		};
	}
}
