import {
	computeHarnessSkillId,
	type HarnessStateStore,
	type HarnessVersion,
	type HarnessWorkspaceIdentity,
} from "@earendil-works/diffex-harness-state";
import type { EvolutionScope } from "./contracts.ts";

export const SKILL_SCORE_SCHEMA_VERSION = 1 as const;

export interface SkillScoreRevision {
	readonly scope: EvolutionScope;
	readonly workspace: HarnessWorkspaceIdentity;
	/** The revision pinned to the output, not necessarily the currently selected pointer. */
	readonly harnessRevision: HarnessVersion;
}

export interface SkillScore extends SkillScoreRevision {
	readonly schemaVersion: typeof SKILL_SCORE_SCHEMA_VERSION;
	readonly skillId: string;
	readonly packageVersion: HarnessVersion;
	readonly contentDigest: HarnessVersion;
	readonly points: number;
	readonly lastOutputIdempotencyKey: string | null;
}

/** Revision is provenance, not a reset boundary: unchanged packages retain their scores. */
export function skillScoreSubject(score: SkillScore) {
	return {
		scope: score.scope,
		workspace: score.workspace,
		skillId: score.skillId,
		packageVersion: score.packageVersion,
		contentDigest: score.contentDigest,
	};
}

/** Derive eligibility only from a validated immutable bundle, never an installed-skill catalog. */
export async function loadScoreableSkills(
	harnessState: HarnessStateStore,
	revision: SkillScoreRevision,
): Promise<readonly SkillScore[]> {
	if (
		revision.scope.repositoryId.trim() === "" ||
		revision.scope.scopeId.trim() === "" ||
		revision.scope.repositoryId !== revision.workspace.repositoryId ||
		(revision.workspace.directoryId !== undefined && revision.workspace.directoryId.trim() === "")
	) {
		throw new Error("Invalid skill score scope or workspace");
	}
	const bundle = await harnessState.loadVersion(revision.harnessRevision);
	return bundle.state.skills
		.filter(
			(skill) =>
				skill.workspace.repositoryId === revision.workspace.repositoryId &&
				skill.workspace.directoryId === revision.workspace.directoryId,
		)
		.map((skill) => ({
			schemaVersion: SKILL_SCORE_SCHEMA_VERSION,
			scope: revision.scope,
			workspace: skill.workspace,
			harnessRevision: bundle.manifest.version,
			skillId: computeHarnessSkillId(skill.workspace, skill.path),
			packageVersion: skill.packageVersion,
			contentDigest: skill.contentHash,
			points: 0,
			lastOutputIdempotencyKey: null,
		}));
}
