import { posix } from "node:path";
import { validateHarnessSkillContent, validateHarnessSkillFilePath } from "@earendil-works/diffex-harness-state";
import type {
	EvolutionArtifactProducer,
	EvolutionArtifactReference,
	EvolutionInputSnapshot,
	EvolutionSkillCatalogEntry,
	SkillCandidate,
	SkillCandidateFailureHandling,
	SkillCandidateGroup,
	SkillCandidateGroupCapsule,
	SkillCandidateProcedureStep,
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
import { isCanonicalGroupCapsule, missingCapsuleMaterial } from "./skill-candidate-capsule.ts";

const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;
const DEFAULT_MAX_PACKAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_SUPPORTING_FILES = 32;
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
	readonly maxPackageBytes?: number;
	readonly maxSupportingFiles?: number;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isProcedureStep(value: unknown): value is SkillCandidateProcedureStep {
	return (
		isRecord(value) &&
		typeof value.sequence === "number" &&
		typeof value.action === "string" &&
		(typeof value.condition === "string" || value.condition === null)
	);
}

function isFailureHandling(value: unknown): value is SkillCandidateFailureHandling {
	return (
		isRecord(value) &&
		typeof value.signal === "string" &&
		typeof value.mitigation === "string" &&
		typeof value.recovery === "string"
	);
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

function resolveLocalReference(sourcePath: string, target: string): string | null {
	const unwrapped = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
	const path = unwrapped.split(/[?#]/u, 1)[0] ?? "";
	if (path === "") return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		throw new Error(`Local reference "${target}" has invalid percent encoding`);
	}
	if (decoded.startsWith("/") || decoded.startsWith("\\")) {
		throw new Error(`Local reference "${target}" must be relative to the skill package`);
	}
	const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
	const skillRoot = sourcePath.split("/").slice(0, 2).join("/");
	if (!resolved.startsWith(`${skillRoot}/`)) {
		throw new Error(`Local reference "${target}" escapes the skill package`);
	}
	return resolved;
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

function validateDraftAgainstCapsule(
	capsule: SkillCandidateGroupCapsule,
	content: string,
	add: (code: string, message: string) => void,
): void {
	const normalizedContent = normalizedText(content);
	const requireText = (code: string, label: string, value: string) => {
		if (!normalizedContent.includes(normalizedText(value))) add(code, `The draft omits ${label} "${value}"`);
	};
	for (const trigger of [capsule.contract.trigger.description, ...capsule.contract.trigger.positiveExamples]) {
		requireText("trigger-condition-missing", "trigger condition", trigger);
	}
	for (const precondition of capsule.contract.preconditions) {
		requireText("precondition-missing", "precondition", precondition);
	}
	let previousActionIndex = -1;
	for (const step of capsule.contract.procedure.steps) {
		const actionIndex = normalizedContent.indexOf(normalizedText(step.action));
		if (actionIndex === -1) {
			add("procedure-action-missing", `The draft omits procedure action "${step.action}"`);
		} else {
			if (actionIndex <= previousActionIndex) {
				add("procedure-action-order-invalid", "The draft changes the canonical procedure action order");
			}
			previousActionIndex = Math.max(previousActionIndex, actionIndex);
		}
		if (step.condition !== null) requireText("decision-branch-missing", "procedure condition", step.condition);
	}
	for (const tool of capsule.contract.procedure.requiredTools) {
		requireText("tool-dependency-missing", "required tool", tool);
	}
	for (const requirement of capsule.contract.procedure.environment) {
		requireText("environment-dependency-missing", "environment requirement", requirement);
	}
	for (const handling of capsule.contract.failureHandling) {
		requireText("failure-signal-missing", "failure signal", handling.signal);
		requireText("failure-mitigation-missing", "failure mitigation", handling.mitigation);
		requireText("recovery-action-missing", "recovery action", handling.recovery);
	}
	for (const boundary of capsule.contract.applicabilityBoundaries) {
		requireText("applicability-boundary-missing", "applicability boundary", boundary);
	}
	for (const counterexample of capsule.contract.trigger.negativeExamples) {
		requireText("counterexample-missing", "counterexample", counterexample);
	}
	for (const criterion of [
		...capsule.contract.verificationContract.checks,
		capsule.contract.verificationContract.completionCondition,
	]) {
		requireText("acceptance-criterion-missing", "acceptance criterion", criterion);
	}
	for (const addition of capsule.historicalAdditions) {
		if (typeof addition.value === "string") {
			switch (addition.field) {
				case "applicabilityBoundaries":
					requireText("applicability-boundary-missing", "applicability boundary", addition.value);
					break;
				case "preconditions":
					requireText("precondition-missing", "precondition", addition.value);
					break;
				case "procedure.environment":
					requireText("environment-dependency-missing", "environment requirement", addition.value);
					break;
				case "procedure.requiredTools":
					requireText("tool-dependency-missing", "required tool", addition.value);
					break;
				case "trigger.negativeExamples":
					requireText("counterexample-missing", "counterexample", addition.value);
					break;
				case "trigger.positiveExamples":
					requireText("trigger-condition-missing", "trigger condition", addition.value);
					break;
				case "verificationContract.checks":
					requireText("acceptance-criterion-missing", "acceptance criterion", addition.value);
					break;
				case "failureHandling":
				case "procedure.steps":
					break;
			}
		} else if (addition.field === "procedure.steps" && isProcedureStep(addition.value)) {
			requireText("procedure-action-missing", "procedure action", addition.value.action);
			if (addition.value.condition !== null) {
				requireText("decision-branch-missing", "procedure condition", addition.value.condition);
			}
		} else if (addition.field === "failureHandling" && isFailureHandling(addition.value)) {
			requireText("failure-signal-missing", "failure signal", addition.value.signal);
			requireText("failure-mitigation-missing", "failure mitigation", addition.value.mitigation);
			requireText("recovery-action-missing", "recovery action", addition.value.recovery);
		}
	}
}

export class DeterministicSkillDraftValidator implements SkillDraftValidator {
	readonly #dependencies: DeterministicSkillDraftValidatorDependencies;
	readonly #producer: EvolutionArtifactProducer;
	readonly #maxContentBytes: number;
	readonly #maxPackageBytes: number;
	readonly #maxSupportingFiles: number;

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
		this.#maxPackageBytes = options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
		this.#maxSupportingFiles = options.maxSupportingFiles ?? DEFAULT_MAX_SUPPORTING_FILES;
		if (!Number.isSafeInteger(this.#maxContentBytes) || this.#maxContentBytes < 1) {
			throw new Error("maxContentBytes must be a positive integer");
		}
		if (!Number.isSafeInteger(this.#maxPackageBytes) || this.#maxPackageBytes < 1) {
			throw new Error("maxPackageBytes must be a positive integer");
		}
		if (!Number.isSafeInteger(this.#maxSupportingFiles) || this.#maxSupportingFiles < 0) {
			throw new Error("maxSupportingFiles must be a non-negative integer");
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
		const capsuleArtifact = await this.#dependencies.artifacts.get(input.group.canonicalCapsule);
		const capsule: SkillCandidateGroupCapsule | null = isCanonicalGroupCapsule(
			capsuleArtifact,
			input.group.canonicalCapsule,
			input.group,
		)
			? capsuleArtifact
			: null;
		if (capsule === null) add("canonical-capsule-invalid", "The canonical group capsule is not immutable");
		if (input.draft.synthesisRequest.capsuleDigest !== input.group.canonicalCapsule.contentDigest) {
			add("synthesis-capsule-mismatch", "The draft was not synthesized from the current canonical capsule");
		}
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
				selectedMemoryProposalIds,
				resultingHarnessVersion: job.completion?.resultingHarnessVersion ?? null,
			});
		}

		const candidates = sources.map((source) => source.candidate);
		if (capsule !== null) {
			for (const omission of missingCapsuleMaterial(capsule, candidates)) {
				add(
					"canonical-capsule-information-missing",
					`The canonical capsule omits ${omission.field} value ${omission.valueDigest}`,
				);
			}
		}
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
		const declaredTraceIds = uniqueSorted(
			candidates.flatMap((candidate) => [...candidate.supportingTraceIds, ...candidate.contradictingTraceIds]),
		);
		const derivedTraceIds = uniqueSorted(
			sources.flatMap((source) => {
				const citedEvidenceIds = new Set([
					...source.candidate.supportingEvidenceIds,
					...source.candidate.contradictingEvidenceIds,
				]);
				return source.input.evidenceSources.flatMap((evidenceSource) =>
					evidenceSource.invocation.evidence.some((evidence) => citedEvidenceIds.has(evidence.evidenceId))
						? (evidenceSource.invocation.traceId ?? [])
						: [],
				);
			}),
		);
		if (!sameValues(declaredTraceIds, derivedTraceIds)) {
			add("candidate-trace-closure-invalid", "The candidate trace closure does not match its cited evidence");
		}
		if (!sameValues(input.draft.sourceTraceIds, derivedTraceIds)) {
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
				source.candidate.existingSkillIds.flatMap((skillId) => {
					const matches = source.input.skillCatalog.filter((skill) => skill.skillId === skillId);
					if (matches.length !== 1) {
						add(
							"source-skill-provenance-invalid",
							`Candidate "${source.candidate.candidateId}" does not resolve skill "${skillId}" uniquely`,
						);
					}
					return matches.map((skill) => skillVersionKey(skill));
				}),
			),
		);
		if (!sameValues(input.draft.sourceSkillVersions.map(skillVersionKey), expectedSkillVersions)) {
			add("source-skill-closure-invalid", "The draft source skill version closure is incomplete");
		}
		const expectedMetadataSourceIds = uniqueSorted([
			...input.draft.sourceCandidateIds,
			...input.draft.sourceEvidenceIds,
			...input.draft.sourceTraceIds,
			...input.draft.sourceSkillVersions.map((skill) => skill.skillId),
			...input.draft.repositoryInstructionDigests,
		]);
		if (
			!sameValues(input.draft.metadata.sourceIds, expectedMetadataSourceIds) ||
			input.draft.metadata.scope.repositoryId !== input.group.profile.workspace.evolutionScope.repositoryId ||
			input.draft.metadata.scope.scopeId !== input.group.profile.workspace.evolutionScope.scopeId
		) {
			add("draft-provenance-invalid", "The draft metadata does not retain its complete source and scope closure");
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
			if (
				source.candidate.memoryRelationship.memoryProposalIds.some(
					(proposalId) => !source.selectedMemoryProposalIds.includes(proposalId),
				)
			) {
				add(
					"memory-relationship-stale",
					`Candidate "${source.candidate.candidateId}" cites memory guidance that was not selected`,
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
		}
		if (capsule !== null) {
			if (
				input.draft.operation !== capsule.contract.operation ||
				input.draft.proposedName !== capsule.contract.proposedName ||
				!sameValues(input.draft.existingSkillIds, capsule.contract.existingSkillIds) ||
				input.draft.workspace.repositoryId !== capsule.contract.workspace.repositoryId ||
				input.draft.workspace.directoryId !== capsule.contract.workspace.directoryId ||
				input.draft.workspace.rootPath !== capsule.contract.workspace.rootPath ||
				input.draft.workspace.repositoryRevision !== capsule.contract.workspace.repositoryRevision ||
				input.draft.workspace.evolutionScope.repositoryId !==
					capsule.contract.workspace.evolutionScope.repositoryId ||
				input.draft.workspace.evolutionScope.scopeId !== capsule.contract.workspace.evolutionScope.scopeId
			) {
				add("canonical-contract-mismatch", "The draft does not match the canonical group operation and scope");
			}
			validateDraftAgainstCapsule(capsule, input.draft.content, add);
		}

		const inventoryPath = `skills/${input.draft.proposedName}/SKILL.md`;
		try {
			validateHarnessSkillContent(inventoryPath, input.draft.content);
		} catch (error) {
			add("skill-structure-invalid", error instanceof Error ? error.message : "The skill structure is invalid");
		}
		const canonicalFiles = new Map<string, { readonly path: string; readonly content: string }>();
		const portablePaths = new Set<string>();
		if (input.draft.files.length > this.#maxSupportingFiles) {
			add(
				"skill-file-count-exceeded",
				`The skill package exceeds the ${this.#maxSupportingFiles}-file supporting-file limit`,
			);
		}
		for (const file of input.draft.files) {
			let canonicalPath: string;
			try {
				canonicalPath = validateHarnessSkillFilePath(inventoryPath, file.path);
			} catch (error) {
				add(
					"skill-file-path-invalid",
					error instanceof Error ? error.message : `Invalid skill file "${file.path}"`,
				);
				continue;
			}
			const portablePath = canonicalPath.normalize("NFC").toLocaleLowerCase("en-US");
			if (portablePaths.has(portablePath)) {
				add("skill-file-path-collision", `Skill file "${file.path}" duplicates another package path`);
				continue;
			}
			portablePaths.add(portablePath);
			canonicalFiles.set(canonicalPath, file);
			if (Buffer.byteLength(file.content, "utf8") > this.#maxContentBytes) {
				add(
					"skill-file-too-large",
					`Skill file "${file.path}" exceeds the ${this.#maxContentBytes}-byte size limit`,
				);
			}
			if (/^\uFEFF|[\uD800-\uDFFF]|\u0000/u.test(file.content)) {
				add("skill-file-content-invalid", `Skill file "${file.path}" contains invalid text`);
			}
			if (SECRET_PATTERNS.some((pattern) => pattern.test(file.content))) {
				add("sensitive-data-detected", `Skill file "${file.path}" violates the sensitive-data policy`);
			}
		}
		if (Buffer.byteLength(input.draft.content, "utf8") > this.#maxContentBytes) {
			add("skill-content-too-large", `The skill exceeds the ${this.#maxContentBytes}-byte size limit`);
		}
		const packageBytes = [input.draft.content, ...input.draft.files.map((file) => file.content)].reduce(
			(total, content) => total + Buffer.byteLength(content, "utf8"),
			0,
		);
		if (packageBytes > this.#maxPackageBytes) {
			add("skill-package-too-large", `The skill package exceeds the ${this.#maxPackageBytes}-byte size limit`);
		}
		if (input.draft.content.includes("\u0000")) add("skill-content-invalid", "The skill contains a NUL byte");
		if (SECRET_PATTERNS.some((pattern) => pattern.test(input.draft.content))) {
			add("sensitive-data-detected", "The skill violates the sensitive-data policy");
		}
		const inventory = new Set([inventoryPath, ...canonicalFiles.keys()]);
		const referenceSources = [
			{ path: inventoryPath, content: input.draft.content },
			...[...canonicalFiles.entries()]
				.filter(([path]) => /\.(?:html?|md|markdown)$/iu.test(path))
				.map(([path, file]) => ({ path, content: file.content })),
		];
		for (const source of referenceSources) {
			for (const target of localReferenceTargets(source.content)) {
				let resolved: string | null;
				try {
					resolved = resolveLocalReference(source.path, target);
				} catch (error) {
					add(
						"local-reference-invalid",
						error instanceof Error ? error.message : `Invalid local reference "${target}"`,
					);
					continue;
				}
				if (resolved !== null && !inventory.has(resolved)) {
					add("undeclared-reference", `Local reference "${target}" from "${source.path}" is not in the package`);
				}
			}
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
			canonicalInventory: [inventoryPath, ...uniqueSorted([...canonicalFiles.keys()])],
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
