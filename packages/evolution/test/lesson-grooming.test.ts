import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessStateStore } from "../../harness-state/src/index.ts";
import {
	createEvolutionArtifactMetadata,
	EvolutionMemoryWriter,
	FileEvolutionPersistence,
	type MutationBatch,
} from "../src/index.ts";

const scope = { repositoryId: "test", scopeId: "workspace" };
const context = {
	idempotencyKey: "groom",
	lease: { kind: "writer" as const, key: "global", ownerId: "test", fence: 1, expiresAt: "2099-01-01T00:00:00Z" },
};
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(points: readonly number[]) {
	const root = await mkdtemp(join(tmpdir(), "lesson-grooming-"));
	roots.push(root);
	const state = new HarnessStateStore(join(root, "agent"));
	const empty = await state.initialize();
	const initial = await state.advance(
		{ memory: points.map((_, index) => `Lesson ${index + 1}: Keep rule ${index + 1}.`).join("\n\n") },
		empty.manifest.version,
		{ evolutionMemory: { nextLessonNumber: points.length + 1 } },
	);
	if (initial.status !== "advanced") throw new Error("Fixture advance failed");
	const writer = new EvolutionMemoryWriter({ version: "test", harnessState: state, statePath: join(root, "writer") });
	const scores = new FileEvolutionPersistence(join(root, "evolution"));
	const snapshot = await writer.captureSnapshot();
	await scores.registerLessonScoreRevision(scope, snapshot);
	const ledger = await scores.loadLessonScores(scope, snapshot.harnessVersion);
	expect(
		await scores.saveLessonScores(
			scope,
			ledger.revision,
			ledger.scores.map((item, index) => ({
				...item,
				harnessRevision: snapshot.harnessVersion,
				points: points[index]!,
				lastAppliedOutputIdempotencyKey: "fixture",
			})),
		),
	).toBe("committed");
	return { state, writer, scores, snapshot };
}

describe("lesson grooming", () => {
	it.each([
		{ points: [-5, -6, 0], remaining: [3] },
		{ points: [...Array<number>(12).fill(0), -1], remaining: Array.from({ length: 12 }, (_, index) => index + 1) },
		{
			points: [-5, -6, -2, ...Array<number>(12).fill(0)],
			remaining: Array.from({ length: 12 }, (_, index) => index + 4),
		},
		{
			points: [-5, -6, -7, ...Array<number>(11).fill(0)],
			remaining: Array.from({ length: 11 }, (_, index) => index + 4),
		},
		{ points: Array<number>(13).fill(0), remaining: Array.from({ length: 12 }, (_, index) => index + 2) },
		{ points: [-5], remaining: [] },
	])("removes exactly the threshold/cap victims: $points", async ({ points, remaining }) => {
		const { state, writer, scores, snapshot } = await setup(points);
		expect(snapshot.activeMemoryItems.every((item) => item.ledger.origin === "manual")).toBe(true);
		const groomed = await writer.groom(scores, scope, context);
		const selected = await state.loadCurrent();
		expect(selected.manifest.version).toBe(groomed.harnessVersion);
		expect(selected.manifest.version).not.toBe(snapshot.harnessVersion);
		expect(selected.manifest.metadata.evolutionMemory.nextLessonNumber).toBe(remaining.length + 1);
		expect(selected.state.memory.trim()).toBe(
			remaining.map((rule, index) => `Lesson ${index + 1}: Keep rule ${rule}.`).join("\n\n"),
		);
		expect(groomed.activeMemoryItems.map((item) => item.memoryItemId)).toEqual(
			remaining.map((rule) => snapshot.activeMemoryItems[rule - 1]!.memoryItemId),
		);
		expect(await writer.captureSnapshot()).toEqual(groomed);
		expect((await scores.loadLessonScores(scope, groomed.harnessVersion)).scores.map((item) => item.points)).toEqual(
			remaining.map((rule) => points[rule - 1]),
		);
		expect(await writer.groom(scores, scope, context)).toEqual(groomed);
		expect((await state.loadCurrent()).manifest.version).toBe(groomed.harnessVersion);
	});

	it.each([[], [-4.5, 0], Array<number>(12).fill(0)].map((points) => ({ points })))(
		"does not advance below thresholds: $points",
		async ({ points }) => {
			const { state, writer, scores, snapshot } = await setup(points);
			expect(await writer.groom(scores, scope, context)).toEqual(snapshot);
			expect((await state.loadCurrent()).manifest.version).toBe(snapshot.harnessVersion);
		},
	);

	it("keeps manual removal unavailable to ordinary evolution batches", async () => {
		const { writer, snapshot } = await setup([-5]);
		const item = snapshot.activeMemoryItems[0]!;
		const content: Omit<MutationBatch, "metadata"> = {
			batchId: "ordinary",
			targetKind: "evolution-memory",
			expectedBaseVersion: snapshot.harnessVersion,
			expectedBaseDigest: snapshot.memoryContentDigest,
			baseMemoryItems: snapshot.activeMemoryItems,
			activationEventId: "ordinary-activation",
			mutations: [
				{
					mutationId: "ordinary-mutation",
					proposalId: "ordinary-proposal",
					target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
					payload: {
						operation: "REMOVE",
						memoryItemId: item.memoryItemId,
						expectedContentDigest: item.contentDigest,
						reason: "test",
					},
				},
			],
		};
		const batch = {
			...content,
			metadata: createEvolutionArtifactMetadata({
				artifactId: content.batchId,
				producer: { name: "test", version: "1", promptVersion: null, model: null },
				sourceIds: [],
				scope,
				createdAt: "2026-01-01T00:00:00Z",
				content,
			}),
		};
		await expect(writer.write(batch, context)).rejects.toThrow("cannot automatically remove");
	});

	it("still rejects mismatched removal digests", async () => {
		const { state, writer, scores, snapshot } = await setup([-5]);
		const points = await scores.loadLessonScores(scope, snapshot.harnessVersion);
		vi.spyOn(scores, "loadLessonScores").mockResolvedValue({
			...points,
			scores: points.scores.map((item) => ({ ...item, contentDigest: "wrong" })),
		});
		await expect(writer.groom(scores, scope, context)).rejects.toThrow("cannot automatically remove");
		expect((await state.loadCurrent()).manifest.version).toBe(snapshot.harnessVersion);
	});
});
