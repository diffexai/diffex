import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import type { EvolutionMemoryItem, EvolutionScope, ImmutableHarnessSnapshot } from "./contracts.ts";

export const LESSON_SCORE_SCHEMA_VERSION = 2 as const;

export type LessonScoreIdentity = Pick<EvolutionMemoryItem, "memoryItemId" | "contentDigest" | "creationRevision">;

export interface LessonScoreRow extends LessonScoreIdentity {
	readonly harnessRevision: HarnessVersion;
	readonly points: number;
	readonly lastAppliedOutputIdempotencyKey: string;
}

export interface LessonScoreCatalog {
	readonly harnessRevision: HarnessVersion;
	readonly items: readonly LessonScoreIdentity[];
}

/** Validated sparse judgments bound to the output's catalog, never a conversation artifact. */
export interface LessonScoreReport {
	/** Stable session/output-ordinal key, shared by every retry of the same output. */
	readonly outputId: string;
	readonly harnessRevision: HarnessVersion;
	readonly judgments: readonly {
		readonly item: LessonScoreIdentity;
		readonly signal: "helpful" | "harmful";
	}[];
}

/** Mutable, scope-local state; catalogs contain identities only, never lesson text. */
export interface LessonScoreLedger {
	readonly schemaVersion: typeof LESSON_SCORE_SCHEMA_VERSION;
	readonly scope: EvolutionScope;
	readonly revision: number;
	readonly catalogs: readonly LessonScoreCatalog[];
	readonly rows: readonly LessonScoreRow[];
	/** Retained independently of rows so older replays and fully removed catalogs remain idempotent. */
	readonly appliedOutputIds: readonly string[];
}

export interface LessonScoreSnapshot {
	/** Compare-and-swap revision for saving absolute point totals. */
	readonly revision: number;
	readonly scope: EvolutionScope;
	readonly harnessRevision: HarnessVersion;
	readonly scores: readonly (LessonScoreIdentity & {
		readonly points: number;
		readonly lastAppliedOutputIdempotencyKey: string | null;
	})[];
}

export interface LessonScoreStore {
	/**
	 * Validate and atomically score a sparse report (+1 helpful, -1.5 harmful, -1 omitted).
	 * Both revisions must be registered. The caller must hold harness selection stable until commit.
	 * Only identities surviving in currentHarnessRevision accrue points; replacements start at zero.
	 */
	applyLessonScoreReport(
		scope: EvolutionScope,
		report: LessonScoreReport,
		currentHarnessRevision: HarnessVersion,
	): Promise<"committed" | "already-applied">;
	/** Register exactly the active items from a memory writer snapshot; registration creates no score rows. */
	registerLessonScoreRevision(
		scope: EvolutionScope,
		snapshot: Pick<ImmutableHarnessSnapshot, "harnessVersion" | "activeMemoryItems">,
	): Promise<void>;
	/** Requires prior registration; reads only mutable ledger state, not harness files. */
	loadLessonScores(scope: EvolutionScope, harnessRevision: HarnessVersion): Promise<LessonScoreSnapshot>;
	/**
	 * Atomically save absolute totals for registered active identities. Callers own scoring policy,
	 * output replay handling, and checking that the output's lessons remain currently active.
	 */
	saveLessonScores(
		scope: EvolutionScope,
		expectedRevision: number,
		rows: readonly LessonScoreRow[],
	): Promise<"committed" | "conflict">;
}
