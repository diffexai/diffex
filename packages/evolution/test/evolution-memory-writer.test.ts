import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessStateStore } from "../../harness-state/src/index.ts";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifactProducer,
	type EvolutionLeaseToken,
	EvolutionMemoryWriter,
	type EvolutionMutation,
	type EvolutionScope,
	type MutationBatch,
} from "../src/index.ts";

const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const producer: EvolutionArtifactProducer = {
	name: "fixture",
	version: "1.0.0",
	promptVersion: null,
	model: null,
};
const writerLease: EvolutionLeaseToken = {
	kind: "writer",
	key: "global",
	ownerId: "writer-1",
	fence: 1,
	expiresAt: "2099-01-01T00:00:00.000Z",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-writer-"));
	temporaryDirectories.push(root);
	const harnessState = new HarnessStateStore(join(root, "agent"));
	const empty = await harnessState.initialize();
	const initialMemory =
		"# Evolution memory\n\n## Existing\n\n- Preserve this manual rule.\n\nTail bytes stay exact.\n";
	const initial = await harnessState.advance({ memory: initialMemory }, empty.manifest.version);
	if (initial.status !== "advanced") throw new Error("Expected fixture harness advance");
	const writer = new EvolutionMemoryWriter({
		version: "1.0.0",
		harnessState,
		statePath: join(root, "writer-state"),
	});
	const snapshot = await writer.captureSnapshot();
	return { harnessState, initial: initial.bundle, initialMemory, snapshot, writer };
}

async function emptyFixture() {
	const root = await mkdtemp(join(tmpdir(), "diffex-evolution-empty-writer-"));
	temporaryDirectories.push(root);
	const harnessState = new HarnessStateStore(join(root, "agent"));
	const initial = await harnessState.initialize();
	const writer = new EvolutionMemoryWriter({
		version: "1.0.0",
		harnessState,
		statePath: join(root, "writer-state"),
	});
	const snapshot = await writer.captureSnapshot();
	return { harnessState, initial, root, snapshot, writer };
}

function batch(
	snapshot: Awaited<ReturnType<EvolutionMemoryWriter["captureSnapshot"]>>,
	mutations: readonly EvolutionMutation[],
	options: { readonly batchId?: string; readonly activationEventId?: string } = {},
): MutationBatch {
	const content = {
		batchId: options.batchId ?? "batch-1",
		targetKind: "evolution-memory" as const,
		expectedBaseVersion: snapshot.harnessVersion,
		expectedBaseDigest: snapshot.memoryContentDigest,
		baseMemoryItems: snapshot.activeMemoryItems,
		activationEventId: options.activationEventId ?? "activation-event-1",
		mutations,
	};
	return {
		metadata: createEvolutionArtifactMetadata({
			artifactId: content.batchId,
			producer,
			sourceIds: mutations.map((mutation) => mutation.proposalId),
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
			content,
		}),
		...content,
	};
}

describe("evolution memory writer", () => {
	it("numbers model-authored lessons and rejects lessons longer than three sentences", async () => {
		const { harnessState, snapshot, writer } = await emptyFixture();
		const numberedBatch = batch(
			snapshot,
			[
				{
					mutationId: "mutation-numbered",
					proposalId: "proposal-numbered",
					target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: null, anchor: null },
						content: "Lesson 99: Verify the runtime. Capture the result. Fix visible regressions.",
						intendedScope: ["verification"],
					},
				},
			],
			{ batchId: "batch-numbered", activationEventId: "activation-numbered" },
		);
		const numberedWrite = await writer.write(numberedBatch, {
			idempotencyKey: "write-numbered",
			lease: writerLease,
		});
		await writer.activate(numberedBatch, numberedWrite, {
			idempotencyKey: "activate-numbered",
			lease: writerLease,
		});
		expect((await harnessState.loadCurrent()).state.memory).toBe(
			"Lesson 1: Verify the runtime. Capture the result. Fix visible regressions.\n",
		);

		const numberedSnapshot = await writer.captureSnapshot();
		const overlongBatch = batch(
			numberedSnapshot,
			[
				{
					mutationId: "mutation-overlong",
					proposalId: "proposal-overlong",
					target: { kind: "evolution-memory", expectedHarnessVersion: numberedSnapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: null, anchor: null },
						content: "First sentence. Second sentence. Third sentence. Fourth sentence.",
						intendedScope: ["verification"],
					},
				},
			],
			{ batchId: "batch-overlong", activationEventId: "activation-overlong" },
		);
		await expect(
			writer.write(overlongBatch, { idempotencyKey: "write-overlong", lease: writerLease }),
		).rejects.toThrow("at most 3 sentences");
		expect((await harnessState.loadCurrent()).state.memory).toBe(
			"Lesson 1: Verify the runtime. Capture the result. Fix visible regressions.\n",
		);
	});

	it("compacts lesson numbers durably when writer sidecar state is unavailable", async () => {
		const { harnessState, root, snapshot, writer } = await emptyFixture();
		const addition = batch(
			snapshot,
			["first", "second", "third"].map(
				(label, index): EvolutionMutation => ({
					mutationId: `mutation-${label}-lesson`,
					proposalId: `proposal-${label}-lesson`,
					target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: null, anchor: null },
						content: `Keep ${label} lesson content ${String(index + 1)}.`,
						intendedScope: ["verification"],
					},
				}),
			),
			{ batchId: "batch-three-lessons", activationEventId: "activation-three-lessons" },
		);
		const additionWrite = await writer.write(addition, { idempotencyKey: "write-three", lease: writerLease });
		await writer.activate(addition, additionWrite, { idempotencyKey: "activate-three", lease: writerLease });

		const addedSnapshot = await writer.captureSnapshot();
		const removedItem = addedSnapshot.activeMemoryItems[1];
		if (removedItem === undefined) throw new Error("Expected the second lesson memory item");
		const removal = batch(
			addedSnapshot,
			[
				{
					mutationId: "mutation-remove-second-lesson",
					proposalId: "proposal-remove-second-lesson",
					target: { kind: "evolution-memory", expectedHarnessVersion: addedSnapshot.harnessVersion },
					payload: {
						operation: "REMOVE",
						memoryItemId: removedItem.memoryItemId,
						expectedContentDigest: removedItem.contentDigest,
						reason: "Exercise durable lesson numbering",
					},
				},
			],
			{ batchId: "batch-remove-second-lesson", activationEventId: "activation-remove-second-lesson" },
		);
		const removalWrite = await writer.write(removal, { idempotencyKey: "write-remove-second", lease: writerLease });
		await writer.activate(removal, removalWrite, {
			idempotencyKey: "activate-remove-second",
			lease: writerLease,
		});
		const compacted = await harnessState.loadCurrent();
		expect(compacted.state.memory).toBe(
			"Lesson 1: Keep first lesson content 1.\n\nLesson 2: Keep third lesson content 3.\n",
		);
		expect(compacted.manifest.metadata.evolutionMemory.nextLessonNumber).toBe(3);

		const recoveredWriter = new EvolutionMemoryWriter({
			version: "1.0.0",
			harnessState,
			statePath: join(root, "recovered-writer-state"),
		});
		const recoveredSnapshot = await recoveredWriter.captureSnapshot();
		const fourthAddition = batch(
			recoveredSnapshot,
			[
				{
					mutationId: "mutation-fourth-lesson",
					proposalId: "proposal-fourth-lesson",
					target: { kind: "evolution-memory", expectedHarnessVersion: recoveredSnapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: null, anchor: "Lesson 3: Keep third lesson content 3." },
						content: "Continue the durable lesson sequence.",
						intendedScope: ["verification"],
					},
				},
			],
			{ batchId: "batch-fourth-lesson", activationEventId: "activation-fourth-lesson" },
		);
		const fourthWrite = await recoveredWriter.write(fourthAddition, {
			idempotencyKey: "write-fourth",
			lease: writerLease,
		});
		await recoveredWriter.activate(fourthAddition, fourthWrite, {
			idempotencyKey: "activate-fourth",
			lease: writerLease,
		});

		expect((await harnessState.loadCurrent()).state.memory).toBe(
			"Lesson 1: Keep first lesson content 1.\n\nLesson 2: Keep third lesson content 3.\n\nLesson 3: Continue the durable lesson sequence.\n",
		);
	});

	it("bootstraps blank memory by appending additions in mutation order", async () => {
		const { harnessState, initial, snapshot, writer } = await emptyFixture();
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-verification",
				proposalId: "proposal-verification",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: null },
					content: "- Verify UI and scene-flow changes in a real runtime.",
					intendedScope: ["verification"],
				},
			},
			{
				mutationId: "mutation-capability-honesty",
				proposalId: "proposal-capability-honesty",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: null },
					content: "- Confirm persistence before promising durable recall.",
					intendedScope: ["capability-honesty"],
				},
			},
		]);

		const writeResult = await writer.write(selectedBatch, {
			idempotencyKey: "write-empty",
			lease: writerLease,
		});
		expect(writeResult.status).toBe("written");
		expect((await harnessState.loadCurrent()).state.memory).toBe("");

		const activation = await writer.activate(selectedBatch, writeResult, {
			idempotencyKey: "activate-empty",
			lease: writerLease,
		});

		expect(activation.status).toBe("activated");
		expect(activation.resultingHarnessVersion).not.toBe(initial.manifest.version);
		expect((await harnessState.loadCurrent()).state.memory).toBe(
			"Lesson 1: Verify UI and scene-flow changes in a real runtime.\n\nLesson 2: Confirm persistence before promising durable recall.\n",
		);
		const activatedSnapshot = await writer.captureSnapshot();
		expect(activatedSnapshot.activeMemoryItems).toHaveLength(2);
		expect(activatedSnapshot.activeMemoryItems).toEqual([
			expect.objectContaining({
				contentDigest: computeEvolutionContentDigest(
					"Lesson 1: Verify UI and scene-flow changes in a real runtime.",
				),
				ledger: { origin: "evolution", creationEventId: "activation-event-1", supersessionEventId: null },
			}),
			expect.objectContaining({
				contentDigest: computeEvolutionContentDigest(
					"Lesson 2: Confirm persistence before promising durable recall.",
				),
				ledger: { origin: "evolution", creationEventId: "activation-event-1", supersessionEventId: null },
			}),
		]);
	});

	it("rejects named sections instead of discarding them during blank-memory bootstrap", async () => {
		const { harnessState, snapshot, writer } = await emptyFixture();
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-global",
				proposalId: "proposal-global",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: null },
					content: "Keep this batch atomic.",
					intendedScope: ["repository"],
				},
			},
			{
				mutationId: "mutation-missing-section",
				proposalId: "proposal-missing-section",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: "verification", anchor: null },
					content: "Do not discard this requested section.",
					intendedScope: ["verification"],
				},
			},
		]);

		await expect(
			writer.write(selectedBatch, { idempotencyKey: "write-missing-section", lease: writerLease }),
		).rejects.toMatchObject({
			name: "EvolutionWriterValidationError",
			message: 'EVOLVE.md section "verification" must exist exactly once',
		});
		expect((await harnessState.loadCurrent()).state.memory).toBe("");
	});

	it.each([
		["first", 0],
		["middle", 1],
		["final", 2],
	] as const)("replaces the %s flat memory item in place", async (label, targetIndex) => {
		const { harnessState, snapshot, writer } = await emptyFixture();
		const initialBatch = batch(
			snapshot,
			["First", "Middle", "Final"].map(
				(name): EvolutionMutation => ({
					mutationId: `mutation-add-${name.toLowerCase()}`,
					proposalId: `proposal-add-${name.toLowerCase()}`,
					target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: null, anchor: null },
						content: `${name} lesson.`,
						intendedScope: ["repository"],
					},
				}),
			),
			{ batchId: `batch-seed-${label}`, activationEventId: `activation-seed-${label}` },
		);
		const initialWrite = await writer.write(initialBatch, {
			idempotencyKey: `write-seed-${label}`,
			lease: writerLease,
		});
		await writer.activate(initialBatch, initialWrite, {
			idempotencyKey: `activate-seed-${label}`,
			lease: writerLease,
		});
		const seededSnapshot = await writer.captureSnapshot();
		const target = seededSnapshot.activeMemoryItems[targetIndex];
		if (target === undefined) throw new Error(`Expected the ${label} memory item`);
		const replacementBatch = batch(
			seededSnapshot,
			[
				{
					mutationId: `mutation-replace-${label}`,
					proposalId: `proposal-replace-${label}`,
					target: { kind: "evolution-memory", expectedHarnessVersion: seededSnapshot.harnessVersion },
					payload: {
						operation: "REPLACE",
						removal: {
							memoryItemId: target.memoryItemId,
							expectedContentDigest: target.contentDigest,
							reason: `Replace the ${label} lesson`,
						},
						addition: { content: `${label} replacement.`, intendedScope: ["repository"] },
					},
				},
			],
			{ batchId: `batch-replace-${label}`, activationEventId: `activation-replace-${label}` },
		);
		const replacementWrite = await writer.write(replacementBatch, {
			idempotencyKey: `write-replace-${label}`,
			lease: writerLease,
		});
		await writer.activate(replacementBatch, replacementWrite, {
			idempotencyKey: `activate-replace-${label}`,
			lease: writerLease,
		});

		const expected = ["First lesson.", "Middle lesson.", "Final lesson."];
		expected[targetIndex] = `${label} replacement.`;
		expect((await harnessState.loadCurrent()).state.memory).toBe(
			`${expected.map((content, index) => `Lesson ${String(index + 1)}: ${content}`).join("\n\n")}\n`,
		);
		const replacedSnapshot = await writer.captureSnapshot();
		expect(replacedSnapshot.activeMemoryItems).toHaveLength(3);
		expect(replacedSnapshot.activeMemoryItems[targetIndex]?.memoryItemId).not.toBe(target.memoryItemId);
		expect((await harnessState.loadCurrent()).manifest.metadata.evolutionMemory.nextLessonNumber).toBe(4);
	});

	it("keeps a section-contained replacement in its exact location", async () => {
		const root = await mkdtemp(join(tmpdir(), "diffex-evolution-section-replace-"));
		temporaryDirectories.push(root);
		const harnessState = new HarnessStateStore(join(root, "agent"));
		const empty = await harnessState.initialize();
		const initial = await harnessState.advance(
			{ memory: "# Alpha\n\nAlpha baseline.\n\n# Beta\n\nBeta baseline.\n" },
			empty.manifest.version,
		);
		if (initial.status !== "advanced") throw new Error("Expected section fixture harness advance");
		const writer = new EvolutionMemoryWriter({
			version: "1.0.0",
			harnessState,
			statePath: join(root, "writer-state"),
		});
		const snapshot = await writer.captureSnapshot();
		const additionBatch = batch(
			snapshot,
			[
				{
					mutationId: "mutation-add-alpha",
					proposalId: "proposal-add-alpha",
					target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: "Alpha", anchor: null },
						content: "Alpha managed lesson.",
						intendedScope: ["alpha"],
					},
				},
			],
			{ batchId: "batch-add-alpha", activationEventId: "activation-add-alpha" },
		);
		const additionWrite = await writer.write(additionBatch, {
			idempotencyKey: "write-add-alpha",
			lease: writerLease,
		});
		await writer.activate(additionBatch, additionWrite, {
			idempotencyKey: "activate-add-alpha",
			lease: writerLease,
		});
		const addedSnapshot = await writer.captureSnapshot();
		const target = addedSnapshot.activeMemoryItems.find((item) => item.ledger.origin === "evolution");
		if (target === undefined) throw new Error("Expected an Alpha evolution memory item");
		const replacementBatch = batch(
			addedSnapshot,
			[
				{
					mutationId: "mutation-replace-alpha",
					proposalId: "proposal-replace-alpha",
					target: { kind: "evolution-memory", expectedHarnessVersion: addedSnapshot.harnessVersion },
					payload: {
						operation: "REPLACE",
						removal: {
							memoryItemId: target.memoryItemId,
							expectedContentDigest: target.contentDigest,
							reason: "Narrow the Alpha lesson",
						},
						addition: { content: "Alpha replacement.", intendedScope: ["alpha"] },
					},
				},
			],
			{ batchId: "batch-replace-alpha", activationEventId: "activation-replace-alpha" },
		);
		const replacementWrite = await writer.write(replacementBatch, {
			idempotencyKey: "write-replace-alpha",
			lease: writerLease,
		});
		await writer.activate(replacementBatch, replacementWrite, {
			idempotencyKey: "activate-replace-alpha",
			lease: writerLease,
		});

		expect((await harnessState.loadCurrent()).state.memory).toBe(
			"# Alpha\n\nAlpha baseline.\n\nLesson 1: Alpha replacement.\n\n# Beta\n\nBeta baseline.\n",
		);
	});

	it("stages selected deltas and atomically activates one harness revision", async () => {
		const { harnessState, initial, initialMemory, snapshot, writer } = await fixture();
		const mutations: readonly EvolutionMutation[] = [
			{
				mutationId: "mutation-add",
				proposalId: "proposal-add",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: "Existing", anchor: null },
					content: "- Apply selected deltas as one batch.",
					intendedScope: ["repository"],
				},
			},
		];
		const selectedBatch = batch(snapshot, mutations);

		const writeResult = await writer.write(selectedBatch, {
			idempotencyKey: "write-key",
			lease: writerLease,
		});

		expect(writeResult).toMatchObject({
			batchId: selectedBatch.batchId,
			status: "written",
			output: {
				expectedBaseVersion: initial.manifest.version,
				operationIds: ["mutation-add"],
			},
			message: null,
		});
		expect((await harnessState.loadCurrent()).state.memory).toBe(initialMemory);

		const activation = await writer.activate(selectedBatch, writeResult, {
			idempotencyKey: "activate-key",
			lease: writerLease,
		});

		expect(activation.status).toBe("activated");
		expect(activation.resultingHarnessVersion).not.toBe(initial.manifest.version);
		const current = await harnessState.loadCurrent();
		expect(current.manifest.base).toBe(initial.manifest.version);
		expect(current.state.memory).toBe(
			"# Evolution memory\n\n## Existing\n\n- Preserve this manual rule.\n\nTail bytes stay exact.\n\nLesson 1: Apply selected deltas as one batch.\n",
		);
		const activatedSnapshot = await writer.captureSnapshot();
		expect(activatedSnapshot.activeMemoryItems).toHaveLength(3);
		expect(activatedSnapshot.activeMemoryItems.at(-1)).toMatchObject({
			contentDigest: computeEvolutionContentDigest("Lesson 1: Apply selected deltas as one batch."),
			creationRevision: current.manifest.version,
			ledger: { origin: "evolution", creationEventId: "activation-event-1", supersessionEventId: null },
		});
		expect(activatedSnapshot.activeMemoryItems.slice(0, 2)).toEqual(
			snapshot.activeMemoryItems.map((item) => expect.objectContaining({ memoryItemId: item.memoryItemId })),
		);
	});

	it("preserves evolved skill artifacts while activating a memory mutation", async () => {
		const root = await mkdtemp(join(tmpdir(), "diffex-evolution-writer-skills-"));
		temporaryDirectories.push(root);
		const harnessState = new HarnessStateStore(join(root, "agent"));
		const empty = await harnessState.initialize();
		const skillContent =
			"---\nname: review-workflow\ndescription: Review changes with focused checks.\n---\n\n# Review workflow\n";
		const initial = await harnessState.advance(
			{
				memory: "Baseline memory.\n",
				skills: [
					{
						path: "skills/review-workflow/SKILL.md",
						content: skillContent,
						workspace: { repositoryId: "global", directoryId: "directory-1" },
					},
				],
			},
			empty.manifest.version,
		);
		if (initial.status !== "advanced") throw new Error("Expected skill harness advance");
		const writer = new EvolutionMemoryWriter({
			version: "1.0.0",
			harnessState,
			statePath: join(root, "writer-state"),
		});
		const snapshot = await writer.captureSnapshot();
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-preserve-skill",
				proposalId: "proposal-preserve-skill",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: null },
					content: "Keep skill and memory activation atomic.",
					intendedScope: ["repository"],
				},
			},
		]);

		const writeResult = await writer.write(selectedBatch, {
			idempotencyKey: "write-preserve-skill",
			lease: writerLease,
		});
		const activation = await writer.activate(selectedBatch, writeResult, {
			idempotencyKey: "activate-preserve-skill",
			lease: writerLease,
		});
		const activated = await harnessState.loadCurrent();

		expect(activated.manifest.version).toBe(activation.resultingHarnessVersion);
		expect(activated.state.memory).toContain("Keep skill and memory activation atomic.");
		expect(activated.state.skills).toHaveLength(1);
		expect(activated.state.skills[0]?.content).toBe(skillContent);
		expect(activated.manifest.artifacts.filter((artifact) => artifact.kind === "skill")).toEqual(
			initial.bundle.manifest.artifacts.filter((artifact) => artifact.kind === "skill"),
		);
	});

	it("rejects a partial batch without publishing any mutation", async () => {
		const { harnessState, initial, initialMemory, snapshot, writer } = await fixture();
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-valid",
				proposalId: "proposal-valid",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: "Existing", anchor: null },
					content: "- This change must not leak from a failed batch.",
					intendedScope: ["repository"],
				},
			},
			{
				mutationId: "mutation-invalid",
				proposalId: "proposal-invalid",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: "end" },
					content: "- This destination is stale.",
					intendedScope: ["repository"],
				},
			},
		]);

		await expect(
			writer.write(selectedBatch, { idempotencyKey: "write-key", lease: writerLease }),
		).rejects.toMatchObject({
			name: "EvolutionWriterValidationError",
			message: "EVOLVE.md addition anchor must match exactly one memory item",
		});
		expect((await harnessState.loadCurrent()).state.memory).toBe(initialMemory);
		expect((await harnessState.listVersions()).versions).toHaveLength(2);
		expect((await writer.captureSnapshot()).harnessVersion).toBe(initial.manifest.version);
	});

	it("retains manually authored items for explicit review", async () => {
		const { harnessState, initialMemory, snapshot, writer } = await fixture();
		const manualItem = snapshot.activeMemoryItems[0];
		if (manualItem === undefined) throw new Error("Expected a manual memory item");
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-remove-manual",
				proposalId: "proposal-remove-manual",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "REMOVE",
					memoryItemId: manualItem.memoryItemId,
					expectedContentDigest: manualItem.contentDigest,
					reason: "Automatic removal is not authorized",
				},
			},
		]);

		await expect(writer.write(selectedBatch, { idempotencyKey: "write-key", lease: writerLease })).rejects.toThrow(
			`cannot automatically remove memory item "${manualItem.memoryItemId}"`,
		);
		expect((await harnessState.loadCurrent()).state.memory).toBe(initialMemory);
	});

	it("resumes an interrupted write and activation without applying a delta twice", async () => {
		const { harnessState, snapshot, writer } = await fixture();
		const addition = batch(
			snapshot,
			[
				{
					mutationId: "mutation-managed",
					proposalId: "proposal-managed",
					target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
					payload: {
						operation: "ADD",
						destination: { section: "Existing", anchor: null },
						content: "- Remove this evolution-managed rule later.",
						intendedScope: ["repository"],
					},
				},
			],
			{ batchId: "batch-add", activationEventId: "activation-add" },
		);
		const additionWrite = await writer.write(addition, { idempotencyKey: "write-add", lease: writerLease });
		await writer.activate(addition, additionWrite, { idempotencyKey: "activate-add", lease: writerLease });
		const addedSnapshot = await writer.captureSnapshot();
		const managedItem = addedSnapshot.activeMemoryItems.find((item) => item.ledger.origin === "evolution");
		if (managedItem === undefined) throw new Error("Expected an evolution-managed memory item");
		const removal = batch(
			addedSnapshot,
			[
				{
					mutationId: "mutation-remove-managed",
					proposalId: "proposal-remove-managed",
					target: { kind: "evolution-memory", expectedHarnessVersion: addedSnapshot.harnessVersion },
					payload: {
						operation: "REMOVE",
						memoryItemId: managedItem.memoryItemId,
						expectedContentDigest: managedItem.contentDigest,
						reason: "Validated counterevidence",
					},
				},
			],
			{ batchId: "batch-remove", activationEventId: "activation-remove" },
		);

		const firstWrite = await writer.write(removal, { idempotencyKey: "write-remove", lease: writerLease });
		const resumedWrite = await writer.write(removal, { idempotencyKey: "write-remove", lease: writerLease });
		expect(resumedWrite).toEqual(firstWrite);
		const firstActivation = await writer.activate(removal, firstWrite, {
			idempotencyKey: "activate-remove",
			lease: writerLease,
		});
		const resumedActivation = await writer.activate(removal, resumedWrite, {
			idempotencyKey: "activate-remove",
			lease: writerLease,
		});

		expect(resumedActivation).toEqual(firstActivation);
		expect((await harnessState.listVersions()).versions).toHaveLength(4);
		expect((await harnessState.loadCurrent()).state.memory).not.toContain("Remove this evolution-managed rule");
		expect((await writer.captureSnapshot()).activeMemoryItems).toHaveLength(2);
	});

	it("rejects sensitive or malformed candidates before harness activation", async () => {
		const { harnessState, initialMemory, snapshot, writer } = await fixture();
		const rejected = [
			{
				id: "secret",
				content: "- api_key = abcdefghijklmnopqrstuvwxyz123456",
				message: "sensitive-data policy",
			},
			{ id: "fence", content: "```text\nunclosed", message: "unclosed fenced code block" },
			{
				id: "duplicate",
				content: "- Preserve this manual rule.",
				message: "duplicate normalized memory items",
			},
		] as const;
		for (const candidate of rejected) {
			const selectedBatch = batch(
				snapshot,
				[
					{
						mutationId: `mutation-${candidate.id}`,
						proposalId: `proposal-${candidate.id}`,
						target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
						payload: {
							operation: "ADD",
							destination: { section: null, anchor: null },
							content: candidate.content,
							intendedScope: ["repository"],
						},
					},
				],
				{ batchId: `batch-${candidate.id}`, activationEventId: `activation-${candidate.id}` },
			);
			await expect(
				writer.write(selectedBatch, { idempotencyKey: `write-${candidate.id}`, lease: writerLease }),
			).rejects.toThrow(candidate.message);
		}
		expect((await harnessState.loadCurrent()).state.memory).toBe(initialMemory);
	});

	it("branches from the frozen base when another harness is selected before writing", async () => {
		const { harnessState, snapshot, writer } = await fixture();
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-frozen-base",
				proposalId: "proposal-frozen-base",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: null },
					content: "- Keep this evolution on its frozen harness base.",
					intendedScope: ["repository"],
				},
			},
		]);
		const competing = await harnessState.advance(
			{ memory: `${snapshot.memory}\nCompeting selected memory.\n` },
			snapshot.harnessVersion,
		);
		if (competing.status !== "advanced") throw new Error("Expected competing harness advance");

		const writeResult = await writer.write(selectedBatch, {
			idempotencyKey: "write-frozen-base",
			lease: writerLease,
		});
		const activation = await writer.activate(selectedBatch, writeResult, {
			idempotencyKey: "activate-frozen-base",
			lease: writerLease,
		});

		expect(await harnessState.loadCurrent()).toEqual(competing.bundle);
		if (activation.resultingHarnessVersion === null) throw new Error("Expected an evolved harness version");
		const evolved = await harnessState.loadVersion(activation.resultingHarnessVersion);
		expect(evolved.manifest.base).toBe(snapshot.harnessVersion);
		expect(evolved.state.memory).toContain("Keep this evolution on its frozen harness base.");
		expect(evolved.state.memory).not.toContain("Competing selected memory.");
		expect((await harnessState.listVersions()).versions).toHaveLength(4);
	});

	it("rejects a tampered write receipt before activation", async () => {
		const { harnessState, initialMemory, snapshot, writer } = await fixture();
		const selectedBatch = batch(snapshot, [
			{
				mutationId: "mutation-receipt",
				proposalId: "proposal-receipt",
				target: { kind: "evolution-memory", expectedHarnessVersion: snapshot.harnessVersion },
				payload: {
					operation: "ADD",
					destination: { section: null, anchor: null },
					content: "- Activate only the exact staged receipt.",
					intendedScope: ["repository"],
				},
			},
		]);
		const writeResult = await writer.write(selectedBatch, {
			idempotencyKey: "write-receipt",
			lease: writerLease,
		});
		if (writeResult.output === null) throw new Error("Expected a candidate output");
		const tampered = {
			...writeResult,
			output: { ...writeResult.output, diff: { start: 0, removed: "", added: "false audit data" } },
		};

		await expect(
			writer.activate(selectedBatch, tampered, {
				idempotencyKey: "activate-receipt",
				lease: writerLease,
			}),
		).rejects.toThrow("write receipt does not match its durable candidate");
		expect((await harnessState.loadCurrent()).state.memory).toBe(initialMemory);
	});
});
