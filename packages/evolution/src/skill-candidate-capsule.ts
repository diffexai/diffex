import type {
	EvolutionArtifactReference,
	SkillCandidate,
	SkillCandidateGroup,
	SkillCandidateGroupCapsule,
	SkillCandidateGroupContract,
	SkillCandidateGroupHistoricalAddition,
	SkillCandidateMaterialField,
} from "./contracts.ts";
import type { EvolutionArtifact } from "./ports.ts";
import { computeEvolutionContentDigest } from "./provenance.ts";

export interface SkillCandidateMaterialEntry {
	readonly field: SkillCandidateMaterialField;
	readonly value: unknown;
}

function uniqueValues<T>(values: readonly T[]): T[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const digest = computeEvolutionContentDigest(value);
		if (seen.has(digest)) return false;
		seen.add(digest);
		return true;
	});
}

export function skillCandidateGroupContract(candidate: SkillCandidate): SkillCandidateGroupContract {
	return {
		operation: candidate.operation,
		proposedName: candidate.proposedName,
		workspace: candidate.workspace,
		existingSkillIds: [...new Set(candidate.existingSkillIds)].sort((left, right) => left.localeCompare(right)),
		skillability: candidate.skillability,
		trigger: {
			description: candidate.trigger.description,
			positiveExamples: uniqueValues(candidate.trigger.positiveExamples),
			negativeExamples: uniqueValues(candidate.trigger.negativeExamples),
		},
		preconditions: uniqueValues(candidate.preconditions),
		procedure: {
			steps: uniqueValues(candidate.procedure.steps),
			requiredTools: uniqueValues(candidate.procedure.requiredTools),
			environment: uniqueValues(candidate.procedure.environment),
		},
		failureHandling: uniqueValues(candidate.failureHandling),
		applicabilityBoundaries: uniqueValues(candidate.applicabilityBoundaries),
		verificationContract: {
			checks: uniqueValues(candidate.verificationContract.checks),
			completionCondition: candidate.verificationContract.completionCondition,
		},
		memoryRelationship: candidate.memoryRelationship,
	};
}

export function skillCandidateMaterialEntries(contract: SkillCandidateGroupContract): SkillCandidateMaterialEntry[] {
	return [
		{ field: "operation", value: contract.operation },
		{ field: "proposedName", value: contract.proposedName },
		...contract.existingSkillIds.map((value) => ({ field: "existingSkillIds" as const, value })),
		{ field: "skillability", value: contract.skillability },
		{ field: "trigger.description", value: contract.trigger.description },
		...contract.trigger.positiveExamples.map((value) => ({ field: "trigger.positiveExamples" as const, value })),
		...contract.trigger.negativeExamples.map((value) => ({ field: "trigger.negativeExamples" as const, value })),
		...contract.preconditions.map((value) => ({ field: "preconditions" as const, value })),
		...contract.procedure.steps.map((value) => ({ field: "procedure.steps" as const, value })),
		...contract.procedure.requiredTools.map((value) => ({ field: "procedure.requiredTools" as const, value })),
		...contract.procedure.environment.map((value) => ({ field: "procedure.environment" as const, value })),
		...contract.failureHandling.map((value) => ({ field: "failureHandling" as const, value })),
		...contract.applicabilityBoundaries.map((value) => ({ field: "applicabilityBoundaries" as const, value })),
		...contract.verificationContract.checks.map((value) => ({
			field: "verificationContract.checks" as const,
			value,
		})),
		{
			field: "verificationContract.completionCondition",
			value: contract.verificationContract.completionCondition,
		},
		{ field: "memoryRelationship", value: contract.memoryRelationship },
	];
}

function materialKey(entry: SkillCandidateMaterialEntry): string {
	return `${entry.field}\u0000${computeEvolutionContentDigest(entry.value)}`;
}

function additionEntry(addition: SkillCandidateGroupHistoricalAddition): SkillCandidateMaterialEntry {
	return { field: addition.field, value: addition.value };
}

export function missingCapsuleMaterial(
	capsule: Pick<SkillCandidateGroupCapsule, "conflicts" | "contract" | "historicalAdditions">,
	candidates: readonly SkillCandidate[],
): readonly { readonly field: SkillCandidateMaterialField; readonly valueDigest: string }[] {
	const retained = new Set([
		...skillCandidateMaterialEntries(capsule.contract).map(materialKey),
		...capsule.historicalAdditions.map((addition) => materialKey(additionEntry(addition))),
		...capsule.conflicts.flatMap((conflict) =>
			conflict.alternatives.map((alternative) => materialKey({ field: conflict.field, value: alternative.value })),
		),
	]);
	const missing = new Map<string, { readonly field: SkillCandidateMaterialField; readonly valueDigest: string }>();
	for (const candidate of candidates) {
		for (const entry of skillCandidateMaterialEntries(skillCandidateGroupContract(candidate))) {
			const key = materialKey(entry);
			if (retained.has(key) || missing.has(key)) continue;
			missing.set(key, { field: entry.field, valueDigest: computeEvolutionContentDigest(entry.value) });
		}
	}
	return [...missing.values()].sort(
		(left, right) => left.field.localeCompare(right.field) || left.valueDigest.localeCompare(right.valueDigest),
	);
}

export function capsuleRequiresEnrichment(
	capsule: Pick<SkillCandidateGroupCapsule, "conflicts" | "contract" | "historicalAdditions">,
	candidates: readonly SkillCandidate[],
): boolean {
	const missing = missingCapsuleMaterial(capsule, candidates);
	const explicitlyOmittedConflictValues = capsule.conflicts.reduce(
		(total, conflict) => total + conflict.omittedAlternativeCount,
		0,
	);
	if (missing.length !== explicitlyOmittedConflictValues) {
		throw new Error("Canonical capsule material coverage is inconsistent with its conflict overflow");
	}
	return missing.length > 0;
}

function contentWithoutMetadata<T extends { readonly metadata: unknown }>(value: T): Omit<T, "metadata"> {
	const { metadata: _metadata, ...content } = value;
	return content;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isCanonicalGroupCapsule(
	artifact: EvolutionArtifact,
	reference: EvolutionArtifactReference,
	group: SkillCandidateGroup,
): artifact is SkillCandidateGroupCapsule {
	const proposalRevisionIds = group.proposalRevisions.map((revision) => revision.revisionId);
	return (
		"artifactKind" in artifact &&
		artifact.artifactKind === "skill-candidate-group-capsule" &&
		artifact.groupId === group.groupId &&
		artifact.capsuleId === reference.artifactId &&
		artifact.metadata.artifactId === artifact.capsuleId &&
		artifact.metadata.contentDigest === computeEvolutionContentDigest(contentWithoutMetadata(artifact)) &&
		computeEvolutionContentDigest(artifact) === reference.contentDigest &&
		artifact.metadata.scope.repositoryId === group.profile.workspace.evolutionScope.repositoryId &&
		artifact.metadata.scope.scopeId === group.profile.workspace.evolutionScope.scopeId &&
		artifact.baseProposalRevisionId === proposalRevisionIds.at(-1) &&
		sameOrderedValues(artifact.proposalRevisionIds, proposalRevisionIds) &&
		sameOrderedValues(
			artifact.sourceDigests,
			group.proposalRevisions.map((revision) => revision.candidate.contentDigest),
		) &&
		artifact.contract.workspace.repositoryId === group.profile.workspace.repositoryId &&
		artifact.contract.workspace.directoryId === group.profile.workspace.directoryId &&
		artifact.contract.workspace.evolutionScope.repositoryId === group.profile.workspace.evolutionScope.repositoryId &&
		artifact.contract.workspace.evolutionScope.scopeId === group.profile.workspace.evolutionScope.scopeId
	);
}
