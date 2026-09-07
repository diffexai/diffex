import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import type { EvolutionMemoryItem, EvolutionScope, ImmutableHarnessSnapshot } from "./contracts.ts";

export const LESSON_SCORE_SCHEMA_VERSION = 1 as const;

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

/** Mutable, scope-local state; catalogs contain identities only, never lesson text. */
export interface LessonScoreLedger {
	readonly schemaVersion: typeof LESSON_SCORE_SCHEMA_VERSION;
	readonly scope: EvolutionScope;
	readonly revision: number;
	readonly catalogs: readonly LessonScoreCatalog[];
	readonly rows: readonly LessonScoreRow[];
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
