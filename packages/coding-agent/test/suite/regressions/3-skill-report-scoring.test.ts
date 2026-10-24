import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { computeHarnessSkillId, HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeEvolutionContentDigest, FileEvolutionPersistence, type SkillScoreLedger } from "#evolution";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { LESSON_REPORT_TOOL } from "../../../src/core/lesson-reports.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SKILL_REPORT_TOOL } from "../../../src/core/skill-reports.ts";
import { createHarness } from "../harness.ts";

function report(skills: unknown) {
	return fauxAssistantMessage(fauxToolCall(SKILL_REPORT_TOOL.name, { skills }), { stopReason: "toolUse" });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(memory = "") {
	const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	cleanups.push(harness.cleanup);
	const agentDir = join(harness.tempDir, "agent");
	const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
	if (!workspace.directoryId) throw new Error("Missing workspace directory ID");
	const scope = { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId };
	const statePath = join(resolveEvolutionWorkspaceStateDirectory(agentDir, workspace), "evolution");
	const scores = new FileEvolutionPersistence(statePath);
	const store = new HarnessStateStore(agentDir, { workspace });
	const empty = await store.initialize();
	const bundle = await store.saveVersion(
		{
			memory,
			skills: ["first", "second", "third"].map((name) => ({
				path: `skills/${name}/SKILL.md`,
				content: `---\nname: ${name}\ndescription: Use ${name} to verify results.\n---\nVerify the result.\n`,
				workspace,
			})),
		},
		empty.manifest.version,
	);
	await store.selectVersion(bundle.manifest.version);
	await scores.registerSkillScoreRevision(scope, workspace, bundle);
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
	async function points(version = bundle.manifest.version) {
		const snapshot = await scores.loadSkillScores(scope, workspace, version);
		return ["first", "second", "third"].map(
			(name) =>
				snapshot.scores.find((item) => item.skillId === computeHarnessSkillId(workspace, `skills/${name}/SKILL.md`))
					?.points,
		);
	}
	async function ledger() {
		return JSON.parse(
			await readFile(
				join(
					statePath,
					"skill-scores",
					`${computeEvolutionContentDigest({ scope, workspace }).replace(":", "-")}.json`,
				),
				"utf8",
			),
		) as SkillScoreLedger;
	}
	return { harness, agentDir, workspace, scope, scores, store, bundle, manager, session, open, points, ledger };
}

describe("Item 3: private skill-report scoring", () => {
	it("scores one final report per prompt and preserves user-message ordinals across restart and replay", async () => {
		const env = await setup();
		let promptIndex = 0;
		for (const [skills, expected] of [
			[
				[
					{ skillName: "first", signal: "helpful" },
					{ skillName: "second", signal: "harmful" },
				],
				[1, -1.5, -1],
			],
			[[], [0, -2.5, -2]],
			[[], [-1, -3.5, -3]],
		] as const) {
			const responses = [fauxAssistantMessage("Normal output."), report(skills)];
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
		expect(await env.points()).toEqual([-2, -4.5, -4]);
		expect((await env.ledger()).appliedOutputIds.at(-1)).toBe(JSON.stringify([sessionId, 4]));
		const saved = await env.ledger();
		expect(
			await env.scores.applySkillScoreReport(
				env.scope,
				env.workspace,
				{
					outputId: JSON.stringify([sessionId, 1]),
					harnessRevision: env.bundle.manifest.version,
					judgments: [],
				},
				env.bundle.manifest.version,
			),
		).toBe("already-applied");
		expect(await env.ledger()).toEqual(saved);
		expect(await env.store.loadCurrent()).toEqual(env.bundle);
		expect(await env.scores.listSkillLifecycleObservations(env.scope)).toEqual([]);
	});

	it("discards failed, missing, invalid and malformed reports without neutral penalties", async () => {
		const env = await setup();
		const before = await env.ledger();
		for (const response of [
			fauxAssistantMessage("SECRET_FAILURE", { stopReason: "error", errorMessage: "SECRET_FAILURE" }),
			fauxAssistantMessage("SECRET_MISSING_REPORT"),
			report(null),
			report([{ skillName: "first", signal: "neutral" }]),
			report([
				{ skillName: "first", signal: "helpful" },
				{ skillName: "first", signal: "harmful" },
			]),
			report([
				{ skillName: "first", signal: "helpful" },
				{ skillName: "unknown", signal: "harmful" },
			]),
		]) {
			env.harness.setResponses([fauxAssistantMessage("Normal output."), response]);
			await env.session.prompt("Check again.");
			expect(await env.ledger()).toEqual(before);
		}
		expect(JSON.stringify(env.manager.getEntries())).not.toContain("SECRET_");
		expect(JSON.stringify(env.session.messages)).not.toContain(SKILL_REPORT_TOOL.name);
	});

	it("scores overlapping SDK sessions without losing updates", async () => {
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
				if (!context.tools?.some((tool) => tool.name === SKILL_REPORT_TOOL.name))
					return fauxAssistantMessage("Normal output.");
				reporting += 1;
				await released;
				return report([
					{ skillName: "first", signal: "helpful" },
					{ skillName: "second", signal: "harmful" },
				]);
			}),
		);
		const prompts = [env.session.prompt("First session."), other.prompt("Second session.")];
		try {
			await vi.waitFor(() => expect(reporting).toBe(2));
			expect(await env.points()).toEqual([0, 0, 0]);
		} finally {
			release();
			await Promise.all(prompts);
		}
		expect(await env.points()).toEqual([2, -3, -2]);
		expect(new Set((await env.ledger()).appliedOutputIds)).toEqual(
			new Set([env.manager, otherManager].map((manager) => JSON.stringify([manager.getSessionId(), 1]))),
		);
		expect(env.harness.getPendingResponseCount()).toBe(0);
	});

	it("excludes late explicit and inferred scores for updated or retired packages while scoring survivors", async () => {
		const env = await setup();
		env.harness.setResponses([fauxAssistantMessage("Initial output."), report([])]);
		await env.session.prompt("Check.");
		let updated = env.bundle;
		env.harness.setResponses([
			fauxAssistantMessage("Output bound to the old packages."),
			async () => {
				updated = await env.store.saveVersion(
					{
						memory: "",
						skills: env.bundle.state.skills
							.filter((skill) => skill.name !== "second")
							.map((skill) => ({
								path: skill.path,
								workspace: skill.workspace,
								content: skill.content + (skill.name === "first" ? "New procedure.\n" : ""),
							})),
					},
					env.bundle.manifest.version,
				);
				await env.store.selectVersion(updated.manifest.version);
				return report([
					{ skillName: "first", signal: "helpful" },
					{ skillName: "third", signal: "harmful" },
				]);
			},
		]);
		await env.session.prompt("Check while updating.");
		expect(await env.points()).toEqual([-1, -1, -2.5]);
		expect(await env.points(updated.manifest.version)).toEqual([0, undefined, -2.5]);
		expect(await env.store.loadCurrent()).toEqual(updated);
		expect(env.session.activeHarnessVersion).toBe(env.bundle.manifest.version);
		// Background selection does not adopt packages; explicitly switch before scoring the new revision.
		await env.session.switchHarnessVersion(updated.manifest.version);
		expect(env.session.activeHarnessVersion).toBe(updated.manifest.version);
		env.harness.setResponses([fauxAssistantMessage("New version output."), report([])]);
		await env.session.prompt("Check the new version.");
		expect(await env.points(updated.manifest.version)).toEqual([-1, undefined, -3.5]);
		expect((await env.points()).slice(0, 2)).toEqual([-1, -1]);
	});

	it("holds harness selection stable until explicit and neutral scores commit together", async () => {
		const env = await setup();
		const target = await env.store.saveVersion({ memory: "", skills: [] }, env.bundle.manifest.version);
		let entered!: () => void;
		const entering = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const apply = FileEvolutionPersistence.prototype.applySkillScoreReport;
		vi.spyOn(FileEvolutionPersistence.prototype, "applySkillScoreReport").mockImplementation(async function (
			this: FileEvolutionPersistence,
			...args
		) {
			entered();
			await released;
			return apply.apply(this, args);
		});
		env.harness.setResponses([
			fauxAssistantMessage("Normal output."),
			report([{ skillName: "first", signal: "helpful" }]),
		]);
		const prompt = env.session.prompt("Check.");
		await entering;
		let selected = false;
		const selection = env.store.selectVersion(target.manifest.version).then(() => {
			selected = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(selected).toBe(false);
			expect(await env.points()).toEqual([0, 0, 0]);
		} finally {
			release();
			await Promise.all([prompt, selection]);
		}
		expect(await env.points()).toEqual([1, -1, -1]);
		expect((await env.store.loadCurrent()).manifest.version).toBe(target.manifest.version);
	});

	it("keeps skill and lesson scoring independent even for the same output key", async () => {
		const env = await setup("Lesson 1: Verify results.\n");
		const failed = fauxAssistantMessage("SECRET_FAILURE", { stopReason: "error", errorMessage: "SECRET_FAILURE" });
		const lesson = fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }), {
			stopReason: "toolUse",
		});
		for (const [lessonResponse, skillResponse] of [
			[failed, report([])],
			[lesson, failed],
			[lesson, report([])],
		]) {
			env.harness.setResponses([fauxAssistantMessage("Normal output."), lessonResponse!, skillResponse!]);
			await env.session.prompt("Check.");
		}
		expect(await env.points()).toEqual([-2, -2, -2]);
		expect(
			(await env.scores.loadLessonScores(env.scope, env.bundle.manifest.version)).scores.map((item) => item.points),
		).toEqual([-2]);
		expect((await env.ledger()).appliedOutputIds).toEqual(
			[1, 3].map((ordinal) => JSON.stringify([env.manager.getSessionId(), ordinal])),
		);
		expect(JSON.stringify(env.session.messages)).not.toContain("SECRET_");
		expect(env.harness.getPendingResponseCount()).toBe(0);
	});
});
