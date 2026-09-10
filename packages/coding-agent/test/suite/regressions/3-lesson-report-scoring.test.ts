import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionMemoryDelta,
	EvolutionMemoryWriter,
	FileEvolutionPersistence,
	type LessonScoreLedger,
	type MutationBatch,
} from "#evolution";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { LESSON_REPORT_TOOL } from "../../../src/core/lesson-reports.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

function report(lessons: unknown) {
	return fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons }), { stopReason: "toolUse" });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
	const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	cleanups.push(harness.cleanup);
	const agentDir = join(harness.tempDir, "agent");
	const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
	if (!workspace.directoryId) throw new Error("Missing workspace directory ID");
	const scope = { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId };
	const statePath = join(resolveEvolutionWorkspaceStateDirectory(agentDir, workspace), "evolution");
	const store = new HarnessStateStore(agentDir, { workspace });
	await store.initialize();
	const writer = new EvolutionMemoryWriter({
		version: "test",
		harnessState: store,
		statePath: join(statePath, "writer"),
	});
	const scores = new FileEvolutionPersistence(statePath);
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
		expect((await writer.activate(batch, await writer.write(batch, context), context)).status).toBe("activated");
		const next = await writer.captureSnapshot();
		await scores.registerLessonScoreRevision(scope, next);
		return next;
	}
	const initial = await activate(
		["Verify results.", "Keep changes narrow.", "Read before editing."].map((content) => ({
			operation: "ADD",
			destination: { section: null, anchor: null },
			content,
			intendedScope: ["repository"],
		})),
	);
	async function open(manager: SessionManager) {
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			sessionManager: manager,
			harnessStateStore: store,
			harnessVersionBundle: await store.loadCurrent(),
			subagents: false,
			tools: [],
		});
		cleanups.push(() => session.dispose());
		return session;
	}
	const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
	const session = await open(manager);
	async function points(version = initial.harnessVersion) {
		return (await scores.loadLessonScores(scope, version)).scores.map((item) => item.points);
	}
	async function ledger() {
		return JSON.parse(
			await readFile(
				join(statePath, "lesson-scores", `${computeEvolutionContentDigest(scope).replace(":", "-")}.json`),
				"utf8",
			),
		) as LessonScoreLedger;
	}
	return {
		harness,
		agentDir,
		store,
		writer,
		scores,
		scope,
		initial,
		activate,
		session,
		manager,
		open,
		points,
		ledger,
	};
}

describe("Item 3: private lesson-report scoring", () => {
	it("scores one final report per prompt and keeps user-message ordinals stable across restart", async () => {
		const env = await setup();
		let promptIndex = 0;
		for (const [lessons, expected] of [
			[
				[
					{ lessonNumber: 1, signal: "helpful" },
					{ lessonNumber: 2, signal: "harmful" },
				],
				[1, -1.5, -1],
			],
			[[{ lessonNumber: 1, signal: "helpful" }], [2, -2.5, -2]],
			[[], [1, -3.5, -3]],
		] as const) {
			const responses = [fauxAssistantMessage("Normal output."), report(lessons)];
			if (promptIndex === 0) {
				responses.unshift(
					fauxAssistantMessage(fauxToolCall("missing", {}), {
						stopReason: "toolUse",
					}),
				);
			}
			const callsBefore = env.harness.faux.state.callCount;
			env.harness.setResponses(responses);
			await env.session.prompt("Check the result.");
			expect(env.harness.faux.state.callCount - callsBefore).toBe(promptIndex === 0 ? 3 : 2);
			expect((await env.ledger()).appliedOutputIds).toHaveLength(promptIndex + 1);
			expect(await env.points()).toEqual(expected);
			promptIndex++;
		}
		const sessionId = env.manager.getSessionId();
		expect((await env.ledger()).appliedOutputIds).toEqual(
			[1, 2, 3].map((ordinal) => JSON.stringify([sessionId, ordinal])),
		);
		const file = env.manager.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		await env.session.dispose();
		const resumed = await env.open(SessionManager.open(file));
		env.harness.setResponses([fauxAssistantMessage("Resumed output."), report([])]);
		await resumed.prompt("Continue.");
		expect(await env.points()).toEqual([0, -4.5, -4]);
		expect((await env.ledger()).appliedOutputIds.at(-1)).toBe(JSON.stringify([sessionId, 4]));
		expect(
			await env.scores.applyLessonScoreReport(
				env.scope,
				{
					outputId: JSON.stringify([sessionId, 1]),
					harnessRevision: env.initial.harnessVersion,
					judgments: [],
				},
				env.initial.harnessVersion,
			),
		).toBe("already-applied");
		expect(await env.points()).toEqual([0, -4.5, -4]);
	});

	it("commits overlapping SDK session reports once per session/output identity", async () => {
		const env = await setup();
		const otherManager = SessionManager.create(env.harness.tempDir, join(env.agentDir, "sessions"));
		const other = await env.open(otherManager);
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reporting = 0;
		env.harness.setResponses(
			Array.from({ length: 4 }, () => async (context) => {
				if (!context.tools?.some((tool) => tool.name === LESSON_REPORT_TOOL.name)) {
					return fauxAssistantMessage("Normal output.");
				}
				reporting += 1;
				await released;
				return report([
					{ lessonNumber: 1, signal: "helpful" },
					{ lessonNumber: 2, signal: "harmful" },
				]);
			}),
		);
		const prompts = [env.session.prompt("Check first session."), other.prompt("Check second session.")];
		try {
			await vi.waitFor(() => expect(reporting).toBe(2));
			expect(await env.points()).toEqual([0, 0, 0]);
		} finally {
			release();
			await Promise.all(prompts);
		}
		expect(await env.points()).toEqual([2, -3, -2]);
		const outputIds = [env.manager, otherManager].map((manager) => JSON.stringify([manager.getSessionId(), 1]));
		expect(new Set(outputIds).size).toBe(2);
		const committed = await env.ledger();
		expect([...committed.appliedOutputIds].sort()).toEqual([...outputIds].sort());
		expect(
			await Promise.all(
				outputIds.map((outputId) =>
					env.scores.applyLessonScoreReport(
						env.scope,
						{ outputId, harnessRevision: env.initial.harnessVersion, judgments: [] },
						env.initial.harnessVersion,
					),
				),
			),
		).toEqual(["already-applied", "already-applied"]);
		expect(await env.ledger()).toEqual(committed);
		expect(env.harness.getPendingResponseCount()).toBe(0);
	});

	it("silently discards failed, missing, malformed and invalid reports without neutral penalties", async () => {
		const env = await setup();
		const before = await env.ledger();
		const events: unknown[] = [];
		env.session.subscribe((event) => events.push(event));
		for (const response of [
			fauxAssistantMessage("SECRET_FAILURE", { stopReason: "error", errorMessage: "SECRET_FAILURE" }),
			fauxAssistantMessage("SECRET_MISSING_REPORT"),
			report(null),
			report([{ lessonNumber: 1, signal: "neutral" }]),
			report([
				{ lessonNumber: 1, signal: "helpful" },
				{ lessonNumber: 1, signal: "harmful" },
			]),
			report([
				{ lessonNumber: 1, signal: "helpful" },
				{ lessonNumber: 4, signal: "harmful" },
			]),
		]) {
			env.harness.setResponses([fauxAssistantMessage("Normal output."), response]);
			await env.session.prompt("Check again.");
			expect(await env.ledger()).toEqual(before);
		}
		expect(JSON.stringify(events)).not.toContain("SECRET_");
		expect(JSON.stringify(events)).not.toContain(LESSON_REPORT_TOOL.name);
		expect(JSON.stringify(env.manager.getEntries())).not.toContain("SECRET_");
	});

	it("resets REPLACE and excludes late explicit and neutral scores for removed identities", async () => {
		const env = await setup();
		env.harness.setResponses([fauxAssistantMessage("Initial output."), report([])]);
		await env.session.prompt("Check.");
		const first = env.initial.activeMemoryItems[0]!;
		let replaced = env.initial;
		env.harness.setResponses([
			fauxAssistantMessage("Output bound to old lessons."),
			async () => {
				replaced = await env.activate([
					{
						operation: "REPLACE",
						removal: {
							memoryItemId: first.memoryItemId,
							expectedContentDigest: first.contentDigest,
							reason: "test",
						},
						addition: { content: "Verify with stronger checks.", intendedScope: ["repository"] },
					},
				]);
				return report([
					{ lessonNumber: 1, signal: "helpful" },
					{ lessonNumber: 2, signal: "harmful" },
				]);
			},
		]);
		await env.session.prompt("Check while replacing.");
		expect(await env.points(replaced.harnessVersion)).toEqual([0, -2.5, -2]);
		expect((await env.points())[0]).toBe(-1);
		expect(replaced.activeMemoryItems[0]?.memoryItemId).not.toBe(first.memoryItemId);
		let removed = replaced;
		env.harness.setResponses([
			fauxAssistantMessage("Output before removal."),
			async () => {
				const replacement = replaced.activeMemoryItems[0]!;
				removed = await env.activate([
					{
						operation: "REMOVE",
						memoryItemId: replacement.memoryItemId,
						expectedContentDigest: replacement.contentDigest,
						reason: "test",
					},
				]);
				return report([{ lessonNumber: 2, signal: "helpful" }]);
			},
		]);
		await env.session.prompt("Check while removing.");
		expect(await env.points(removed.harnessVersion)).toEqual([-1.5, -3]);
		expect((await env.points(replaced.harnessVersion))[0]).toBe(0);
		expect(removed.memory).toBe("Lesson 1: Keep changes narrow.\n\nLesson 2: Read before editing.\n");
		expect(await env.writer.captureSnapshot()).toEqual(removed);
	});

	it("holds selection stable until the atomic score commit completes", async () => {
		const env = await setup();
		const target = await env.store.saveVersion({ memory: "Lesson 1: Other guidance.\n" }, env.initial.harnessVersion);
		let entered!: () => void;
		const entering = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const apply = FileEvolutionPersistence.prototype.applyLessonScoreReport;
		vi.spyOn(FileEvolutionPersistence.prototype, "applyLessonScoreReport").mockImplementation(async function (
			this: FileEvolutionPersistence,
			...args
		) {
			entered();
			await released;
			return apply.apply(this, args);
		});
		env.harness.setResponses([fauxAssistantMessage("Normal output."), report([])]);
		const prompt = env.session.prompt("Check.");
		await entering;
		let selected = false;
		const selection = env.store.selectVersion(target.manifest.version).then(() => {
			selected = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(selected).toBe(false);
			expect((await env.store.loadCurrent()).manifest.version).toBe(env.initial.harnessVersion);
		} finally {
			release();
			await Promise.all([prompt, selection]);
		}
		expect(await env.points()).toEqual([-1, -1, -1]);
		expect((await env.store.loadCurrent()).manifest.version).toBe(target.manifest.version);
	});
});
