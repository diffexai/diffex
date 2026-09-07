import type {
	HarnessVersion,
	HarnessVersionBundle,
	HarnessWorkspaceIdentity,
} from "@earendil-works/diffex-harness-state";
import type { EvolutionScope } from "./contracts.ts";

export const SKILL_SCORE_SCHEMA_VERSION = 2 as const;

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

/** Validated sparse judgments bound to the output's catalog, never a conversation artifact. */
export interface SkillScoreReport {
	/** Stable session/output-ordinal key, shared by every retry of the same output. */
	readonly outputId: string;
	readonly harnessRevision: HarnessVersion;
	readonly judgments: readonly {
		readonly item: SkillScoreIdentity;
		readonly signal: "helpful" | "harmful";
	}[];
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
	/** Retained independently of rows, including outputs whose entire bound catalog was removed. */
	readonly appliedOutputIds: readonly string[];
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
	 * Atomically score a fully validated sparse report (+1 helpful, -1.5 harmful, -1 omitted).
	 * Both revisions must be registered; caller holds harness selection stable until commit.
	 * Only exact package identities surviving in currentHarnessRevision accrue points.
	 */
	applySkillScoreReport(
		scope: EvolutionScope,
		workspace: HarnessWorkspaceIdentity,
		report: SkillScoreReport,
		currentHarnessRevision: HarnessVersion,
	): Promise<"committed" | "already-applied">;
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
