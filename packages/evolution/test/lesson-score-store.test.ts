import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessStateStore } from "../../harness-state/src/index.ts";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionMemoryDelta,
	EvolutionMemoryWriter,
	EvolutionStorageCorruptionError,
	FileEvolutionPersistence,
	type ImmutableHarnessSnapshot,
	LESSON_SCORE_SCHEMA_VERSION,
	type LessonScoreLedger,
	type LessonScoreReport,
	type LessonScoreRow,
	type MutationBatch,
} from "../src/index.ts";

const scope = { repositoryId: "repository", scopeId: "workspace" };
const otherRevision = `sha256:${"a".repeat(64)}` as const;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "diffex-lesson-scores-"));
	roots.push(root);
	const harness = new HarnessStateStore(join(root, "agent"));
	await harness.initialize();
	const writer = new EvolutionMemoryWriter({
		version: "test",
		harnessState: harness,
		statePath: join(root, "writer"),
	});
	const storePath = join(root, "evolution");
	const store = new FileEvolutionPersistence(storePath);
	const ledgerPath = join(
		storePath,
		"lesson-scores",
		`${computeEvolutionContentDigest(scope).replace(":", "-")}.json`,
	);
	let sequence = 0;
	async function activate(payloads: readonly EvolutionMemoryDelta[]) {
		const snapshot = await writer.captureSnapshot();
		sequence += 1;
		const content = {
			batchId: `batch-${sequence}`,
			targetKind: "evolution-memory" as const,
			expectedBaseVersion: snapshot.harnessVersion,
			expectedBaseDigest: snapshot.memoryContentDigest,
			baseMemoryItems: snapshot.activeMemoryItems,
			activationEventId: `activation-${sequence}`,
			mutations: payloads.map((payload, index) => ({
				mutationId: `mutation-${sequence}-${index}`,
				proposalId: `proposal-${sequence}-${index}`,
				target: { kind: "evolution-memory" as const, expectedHarnessVersion: snapshot.harnessVersion },
				payload,
			})),
		};
		const batch: MutationBatch = {
			...content,
			metadata: createEvolutionArtifactMetadata({
				artifactId: content.batchId,
				producer: { name: "test", version: "1", promptVersion: null, model: null },
				sourceIds: [],
				scope,
				createdAt: new Date().toISOString(),
				content,
			}),
		};
		const context = {
			idempotencyKey: content.batchId,
			lease: {
				kind: "writer" as const,
				key: "global",
				ownerId: "test",
				fence: 1,
				expiresAt: "2099-01-01T00:00:00Z",
			},
		};
		await writer.activate(batch, await writer.write(batch, context), context);
		const next = await writer.captureSnapshot();
		await store.registerLessonScoreRevision(scope, next);
		return next;
	}
	const empty = await writer.captureSnapshot();
	await store.registerLessonScoreRevision(scope, empty);
	const snapshot = await activate(
		["First", "Second"].map((label) => ({
			operation: "ADD",
			destination: { section: null, anchor: null },
			content: `${label} lesson.`,
			intendedScope: ["repository"],
		})),
	);
	return { root, storePath, ledgerPath, store, writer, harness, empty, snapshot, activate };
}

function row(snapshot: ImmutableHarnessSnapshot, index = 0): LessonScoreRow {
	const item = snapshot.activeMemoryItems[index];
	if (item === undefined) throw new Error("Missing fixture lesson");
	return {
		harnessRevision: snapshot.harnessVersion,
		memoryItemId: item.memoryItemId,
		contentDigest: item.contentDigest,
		creationRevision: item.creationRevision,
		points: -1.5,
		lastAppliedOutputIdempotencyKey: "session-1/output-1",
	};
}

describe("lesson score store", () => {
	it("registers exact active catalogs, starts at zero without rows, and reads without harness files", async () => {
		const { root, storePath, ledgerPath, store, writer, harness, empty, snapshot } = await fixture();
		expect((await store.loadLessonScores(scope, empty.harnessVersion)).scores).toEqual([]);
		const initial = await store.loadLessonScores(scope, snapshot.harnessVersion);
		expect(initial.scores).toEqual(
			snapshot.activeMemoryItems.map((item) => ({
				memoryItemId: item.memoryItemId,
				contentDigest: item.contentDigest,
				creationRevision: item.creationRevision,
				points: 0,
				lastAppliedOutputIdempotencyKey: null,
			})),
		);
		expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toMatchObject({
			schemaVersion: LESSON_SCORE_SCHEMA_VERSION,
			rows: [],
		});
		await store.registerLessonScoreRevision(scope, snapshot);
		expect(await store.loadLessonScores(scope, snapshot.harnessVersion)).toEqual(initial);
		expect(await store.saveLessonScores(scope, initial.revision, [row(snapshot)])).toBe("committed");
		const saved = await store.loadLessonScores(scope, snapshot.harnessVersion);
		expect(saved.scores.map((item) => item.points)).toEqual([-1.5, 0]);
		expect(await writer.captureSnapshot()).toEqual(snapshot);
		expect(await writer.loadActiveMemoryItems(await harness.loadCurrent())).toEqual(snapshot.activeMemoryItems);
		await rm(join(root, "agent"), { recursive: true });
		await rm(join(root, "writer"), { recursive: true });
		expect(await new FileEvolutionPersistence(storePath).loadLessonScores(scope, snapshot.harnessVersion)).toEqual(
			saved,
		);
	});

	it("includes manual lessons and isolates scopes", async () => {
		const { store, harness, writer, snapshot } = await fixture();
		const manual = await harness.advance({ memory: "Lesson 1: Manual guidance.\n" }, snapshot.harnessVersion);
		expect(manual.status).toBe("advanced");
		const next = await writer.captureSnapshot();
		expect(next.activeMemoryItems[0]?.ledger.origin).toBe("manual");
		await store.registerLessonScoreRevision(scope, next);
		const scores = await store.loadLessonScores(scope, next.harnessVersion);
		expect(scores.scores.map((item) => item.memoryItemId)).toEqual(
			next.activeMemoryItems.map((item) => item.memoryItemId),
		);
		await store.saveLessonScores(scope, scores.revision, [row(next)]);
		const otherScope = { ...scope, scopeId: "other" };
		await expect(store.loadLessonScores(otherScope, next.harnessVersion)).rejects.toThrow("Unregistered");
		await store.registerLessonScoreRevision(otherScope, next);
		expect((await store.loadLessonScores(otherScope, next.harnessVersion)).scores[0]?.points).toBe(0);
	});

	it("resets replacements by identity and preserves survivor scores through removal and renumbering", async () => {
		const { store, ledgerPath, snapshot, activate } = await fixture();
		const initial = await store.loadLessonScores(scope, snapshot.harnessVersion);
		const first = row(snapshot);
		const second = row(snapshot, 1);
		await store.saveLessonScores(scope, initial.revision, [first, second]);
		const replaced = await activate([
			{
				operation: "REPLACE",
				removal: { memoryItemId: first.memoryItemId, expectedContentDigest: first.contentDigest, reason: "test" },
				addition: { content: "Replacement lesson.", intendedScope: ["repository"] },
			},
		]);
		const replacedScores = await store.loadLessonScores(scope, replaced.harnessVersion);
		expect(replacedScores.scores.map((item) => item.points)).toEqual([0, -1.5]);
		expect(replacedScores.scores[0]?.memoryItemId).not.toBe(first.memoryItemId);
		expect(JSON.parse(await readFile(ledgerPath, "utf8")).rows).toHaveLength(2);
		await expect(
			store.saveLessonScores(scope, replacedScores.revision, [
				{ ...first, harnessRevision: replaced.harnessVersion },
			]),
		).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		const replacement = row(replaced);
		const removed = await activate([
			{
				operation: "REMOVE",
				memoryItemId: replacement.memoryItemId,
				expectedContentDigest: replacement.contentDigest,
				reason: "test",
			},
		]);
		const remaining = await store.loadLessonScores(scope, removed.harnessVersion);
		expect(remaining.scores).toHaveLength(1);
		expect(remaining.scores[0]).toMatchObject({
			memoryItemId: second.memoryItemId,
			creationRevision: second.creationRevision,
			points: -1.5,
		});
		expect(remaining.scores[0]?.contentDigest).not.toBe(second.contentDigest);
		expect(removed.memory).toBe("Lesson 1: Second lesson.\n");
		await expect(
			store.saveLessonScores(scope, remaining.revision, [
				{ ...replacement, harnessRevision: removed.harnessVersion },
			]),
		).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		expect((await store.loadLessonScores(scope, snapshot.harnessVersion)).scores.map((item) => item.points)).toEqual([
			-1.5, -1.5,
		]);
	});

	it("atomically expands sparse and empty reports with exact weights and durable replay protection", async () => {
		const { store, storePath, snapshot, activate } = await fixture();
		const next = await activate([
			{
				operation: "ADD",
				destination: { section: null, anchor: null },
				content: "Third lesson.",
				intendedScope: ["repository"],
			},
		]);
		const report: LessonScoreReport = {
			outputId: "session-1/output-1",
			harnessRevision: next.harnessVersion,
			judgments: [
				{ item: row(next), signal: "helpful" },
				{ item: row(next, 1), signal: "harmful" },
			],
		};
		const apply = (value: LessonScoreReport) => store.applyLessonScoreReport(scope, value, next.harnessVersion);
		expect(await apply(report)).toBe("committed");
		expect((await store.loadLessonScores(scope, next.harnessVersion)).scores.map((item) => item.points)).toEqual([
			1, -1.5, -1,
		]);
		await apply({ ...report, outputId: "session-1/output-2" });
		await apply({ ...report, outputId: "session-1/output-3", judgments: [] });
		const saved = await store.loadLessonScores(scope, next.harnessVersion);
		expect(saved.scores.map((item) => item.points)).toEqual([1, -4, -3]);
		const restarted = new FileEvolutionPersistence(storePath);
		expect(await restarted.applyLessonScoreReport(scope, report, next.harnessVersion)).toBe("already-applied");
		expect(await restarted.loadLessonScores(scope, next.harnessVersion)).toEqual(saved);
		expect((await store.loadLessonScores(scope, snapshot.harnessVersion)).scores.map((item) => item.points)).toEqual([
			1, -4,
		]);
	});

	it("serializes parallel sessions and duplicate outputs without lost updates", async () => {
		const { store, storePath, snapshot } = await fixture();
		const reports: LessonScoreReport[] = ["session-1/output-1", "session-2/output-1"].map((outputId) => ({
			outputId,
			harnessRevision: snapshot.harnessVersion,
			judgments: [{ item: row(snapshot), signal: "helpful" }],
		}));
		const results = await Promise.all(
			[...reports, ...reports].map((report) =>
				new FileEvolutionPersistence(storePath).applyLessonScoreReport(scope, report, snapshot.harnessVersion),
			),
		);
		expect(results.sort()).toEqual(["already-applied", "already-applied", "committed", "committed"]);
		expect((await store.loadLessonScores(scope, snapshot.harnessVersion)).scores.map((item) => item.points)).toEqual([
			2, -2,
		]);
	});

	it("rejects whole invalid reports without committing explicit or inferred points", async () => {
		const { store, snapshot } = await fixture();
		const before = await store.loadLessonScores(scope, snapshot.harnessVersion);
		const helpful = { item: row(snapshot), signal: "helpful" as const };
		for (const judgments of [
			[helpful, helpful],
			[helpful, { ...helpful, signal: "harmful" }],
			[helpful, { item: { ...row(snapshot, 1), contentDigest: otherRevision }, signal: "harmful" }],
			[{ ...helpful, signal: "neutral" }],
			null,
		]) {
			await expect(
				store.applyLessonScoreReport(
					scope,
					{
						outputId: "session-1/output-1",
						harnessRevision: snapshot.harnessVersion,
						judgments: judgments as LessonScoreReport["judgments"],
					},
					snapshot.harnessVersion,
				),
			).rejects.toThrow();
			expect(await store.loadLessonScores(scope, snapshot.harnessVersion)).toEqual(before);
		}
		await expect(
			store.applyLessonScoreReport(
				scope,
				{ outputId: "", harnessRevision: snapshot.harnessVersion, judgments: [] },
				snapshot.harnessVersion,
			),
		).rejects.toThrow();
		expect(await store.loadLessonScores(scope, snapshot.harnessVersion)).toEqual(before);
	});

	it("ignores removed and superseded items in late reports while scoring renumbered survivors", async () => {
		const { store, snapshot, activate, writer } = await fixture();
		const first = row(snapshot);
		const second = row(snapshot, 1);
		await store.applyLessonScoreReport(
			scope,
			{ outputId: "session-1/output-1", harnessRevision: snapshot.harnessVersion, judgments: [] },
			snapshot.harnessVersion,
		);
		const replaced = await activate([
			{
				operation: "REPLACE",
				removal: { memoryItemId: first.memoryItemId, expectedContentDigest: first.contentDigest, reason: "test" },
				addition: { content: "Replacement lesson.", intendedScope: ["repository"] },
			},
		]);
		await store.applyLessonScoreReport(
			scope,
			{
				outputId: "session-1/output-2",
				harnessRevision: snapshot.harnessVersion,
				judgments: [{ item: first, signal: "helpful" }],
			},
			replaced.harnessVersion,
		);
		expect((await store.loadLessonScores(scope, replaced.harnessVersion)).scores.map((item) => item.points)).toEqual([
			0, -2,
		]);
		const replacement = row(replaced);
		const removed = await activate([
			{
				operation: "REMOVE",
				memoryItemId: replacement.memoryItemId,
				expectedContentDigest: replacement.contentDigest,
				reason: "test",
			},
		]);
		await store.applyLessonScoreReport(
			scope,
			{
				outputId: "session-1/output-3",
				harnessRevision: replaced.harnessVersion,
				judgments: [
					{ item: replacement, signal: "harmful" },
					{ item: second, signal: "helpful" },
				],
			},
			removed.harnessVersion,
		);
		expect((await store.loadLessonScores(scope, removed.harnessVersion)).scores.map((item) => item.points)).toEqual([
			-1,
		]);
		expect((await store.loadLessonScores(scope, replaced.harnessVersion)).scores[0]?.points).toBe(0);
		expect((await store.loadLessonScores(scope, snapshot.harnessVersion)).scores[0]?.points).toBe(-1);
		expect(await writer.captureSnapshot()).toEqual(removed);
		expect(removed.memory).toBe("Lesson 1: Second lesson.\n");
	});

	it("rejects changed, duplicate, and superseded catalogs", async () => {
		const { store, snapshot } = await fixture();
		await expect(store.registerLessonScoreRevision(scope, { ...snapshot, activeMemoryItems: [] })).rejects.toThrow(
			"different active memory items",
		);
		await expect(
			store.registerLessonScoreRevision(scope, {
				...snapshot,
				harnessVersion: otherRevision,
				activeMemoryItems: [...snapshot.activeMemoryItems, ...snapshot.activeMemoryItems],
			}),
		).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		await expect(
			store.registerLessonScoreRevision(scope, {
				...snapshot,
				activeMemoryItems: snapshot.activeMemoryItems.map((item) => ({
					...item,
					supersessionRevision: otherRevision,
				})),
			}),
		).rejects.toThrow("superseded");
	});

	it("uses compare-and-swap across store instances without partial or lost writes", async () => {
		const { store, storePath, snapshot } = await fixture();
		const initial = await store.loadLessonScores(scope, snapshot.harnessVersion);
		const rows = [row(snapshot), row(snapshot, 1)];
		const results = await Promise.all([
			store.saveLessonScores(scope, initial.revision, rows),
			new FileEvolutionPersistence(storePath).saveLessonScores(scope, initial.revision, rows),
		]);
		expect(results.sort()).toEqual(["committed", "conflict"]);
		const saved = await store.loadLessonScores(scope, snapshot.harnessVersion);
		expect(saved.scores.map((item) => item.points)).toEqual([-1.5, -1.5]);
		expect(saved.revision).toBe(initial.revision + 1);
		await expect(store.saveLessonScores(scope, saved.revision, [row(snapshot), row(snapshot)])).rejects.toThrow(
			"Duplicate",
		);
		await expect(
			store.saveLessonScores(scope, saved.revision, [
				{ ...row(snapshot), points: 4 },
				{ ...row(snapshot, 1), contentDigest: otherRevision },
			]),
		).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		expect(await store.loadLessonScores(scope, snapshot.harnessVersion)).toEqual(saved);
	});

	it.each([
		{ points: Number.NaN },
		{ points: Number.POSITIVE_INFINITY },
		{ harnessRevision: otherRevision },
		{ contentDigest: otherRevision },
		{ creationRevision: otherRevision },
		{ memoryItemId: "unknown" },
		{ lastAppliedOutputIdempotencyKey: "" },
	])("rejects invalid score writes: %j", async (override) => {
		const { store, snapshot } = await fixture();
		const before = await store.loadLessonScores(scope, snapshot.harnessVersion);
		await expect(
			store.saveLessonScores(scope, before.revision, [{ ...row(snapshot), ...override }]),
		).rejects.toThrow();
		expect(await store.loadLessonScores(scope, snapshot.harnessVersion)).toEqual(before);
	});

	const corruptions: readonly [string, (ledger: LessonScoreLedger) => unknown][] = [
		["schema version", (ledger) => ({ ...ledger, schemaVersion: 99 })],
		["scope", (ledger) => ({ ...ledger, scope: { ...scope, scopeId: "other" } })],
		["revision", (ledger) => ({ ...ledger, revision: -1 })],
		["missing replay keys", (ledger) => ({ ...ledger, appliedOutputIds: undefined })],
		["empty replay key", (ledger) => ({ ...ledger, appliedOutputIds: [""] })],
		["duplicate replay keys", (ledger) => ({ ...ledger, appliedOutputIds: ["output-1", "output-1"] })],
		["duplicate catalogs", (ledger) => ({ ...ledger, catalogs: [...ledger.catalogs, ...ledger.catalogs] })],
		["duplicate rows", (ledger) => ({ ...ledger, rows: [...ledger.rows, ...ledger.rows] })],
		["unbound rows", (ledger) => ({ ...ledger, catalogs: [] })],
		["bad points", (ledger) => ({ ...ledger, rows: ledger.rows.map((item) => ({ ...item, points: "0" })) })],
		["bad digest", (ledger) => ({ ...ledger, rows: ledger.rows.map((item) => ({ ...item, contentDigest: "bad" })) })],
		[
			"missing idempotency key",
			(ledger) => ({
				...ledger,
				rows: ledger.rows.map((item) => ({ ...item, lastAppliedOutputIdempotencyKey: null })),
			}),
		],
	];
	it.each(corruptions)("rejects corrupt durable data on read: %s", async (_name, corrupt) => {
		const { store, snapshot, ledgerPath } = await fixture();
		const before = await store.loadLessonScores(scope, snapshot.harnessVersion);
		await store.saveLessonScores(scope, before.revision, [row(snapshot)]);
		const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as LessonScoreLedger;
		await writeFile(ledgerPath, JSON.stringify(corrupt(ledger)));
		await expect(store.loadLessonScores(scope, snapshot.harnessVersion)).rejects.toBeInstanceOf(
			EvolutionStorageCorruptionError,
		);
	});

	it("rejects malformed JSON rather than returning zero points", async () => {
		const { store, snapshot, ledgerPath } = await fixture();
		await writeFile(ledgerPath, "{");
		await expect(store.loadLessonScores(scope, snapshot.harnessVersion)).rejects.toBeInstanceOf(
			EvolutionStorageCorruptionError,
		);
	});
});
