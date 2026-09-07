import type {
	HarnessVersion,
	HarnessVersionBundle,
	HarnessWorkspaceIdentity,
} from "@earendil-works/diffex-harness-state";
import type { EvolutionScope } from "./contracts.ts";

export const SKILL_SCORE_SCHEMA_VERSION = 1 as const;

/** Package identity survives unrelated harness revisions; either digest changing starts a new subject. */
export interface SkillScoreIdentity {
	readonly skillId: string;
	readonly packageVersion: HarnessVersion;
	readonly contentDigest: HarnessVersion;
	readonly workspace: HarnessWorkspaceIdentity;
}

export interface SkillScoreRow extends SkillScoreIdentity {
	/** Revision in which this version was active when these totals were saved. */
	readonly harnessRevision: HarnessVersion;
	readonly points: number;
	readonly lastAppliedOutputIdempotencyKey: string;
}

export interface SkillScoreCatalog {
	readonly harnessRevision: HarnessVersion;
	readonly items: readonly SkillScoreIdentity[];
}

/** Mutable state, partitioned by both evolution scope and exact workspace identity. No skill content. */
export interface SkillScoreLedger {
	readonly schemaVersion: typeof SKILL_SCORE_SCHEMA_VERSION;
	readonly scope: EvolutionScope;
	readonly workspace: HarnessWorkspaceIdentity;
	readonly revision: number;
	readonly catalogs: readonly SkillScoreCatalog[];
	/** Superseded package versions remain here for audit, without affecting their replacements. */
	readonly rows: readonly SkillScoreRow[];
}

export interface SkillScoreSnapshot {
	/** Compare-and-swap revision for saving absolute point totals. */
	readonly revision: number;
	readonly scope: EvolutionScope;
	readonly workspace: HarnessWorkspaceIdentity;
	readonly harnessRevision: HarnessVersion;
	readonly scores: readonly (SkillScoreIdentity & {
		readonly points: number;
		readonly lastAppliedOutputIdempotencyKey: string | null;
	})[];
}

export interface SkillScoreStore {
	/**
	 * Register all workspace-matching skills from a validated harness bundle, never an installed catalog.
	 * Caller supplies the bundle active for the output. New package identities have effective points of 0.
	 */
	registerSkillScoreRevision(
		scope: EvolutionScope,
		workspace: HarnessWorkspaceIdentity,
		bundle: HarnessVersionBundle,
	): Promise<void>;
	/** Requires prior registration; reads mutable ledger state only. */
	loadSkillScores(
		scope: EvolutionScope,
		workspace: HarnessWorkspaceIdentity,
		harnessRevision: HarnessVersion,
	): Promise<SkillScoreSnapshot>;
	/**
	 * Atomically save totals for identities present in their registered revision.
	 * Caller owns scoring policy, output replay handling, and ensuring subjects remain currently active.
	 */
	saveSkillScores(
		scope: EvolutionScope,
		workspace: HarnessWorkspaceIdentity,
		expectedRevision: number,
		rows: readonly SkillScoreRow[],
	): Promise<"committed" | "conflict">;
}
