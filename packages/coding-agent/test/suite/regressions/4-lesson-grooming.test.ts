import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeEvolutionContentDigest, EvolutionMemoryWriter, FileEvolutionPersistence } from "#evolution";
import { CuratorToolRegistry } from "../../../../evolution/src/curator-tools.ts";
import {
	createCodingAgentEvolutionRuntime,
	EvolutionRuntimeCoordinator,
	type EvolutionRuntimeEvent,
} from "../../../src/core/evolution-runtime.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../../../src/core/invocation-trace.ts";
import { LESSON_REPORT_TOOL } from "../../../src/core/lesson-reports.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(count = 2) {
	const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	cleanups.push(harness.cleanup);
	const agentDir = join(harness.tempDir, "agent");
	const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
	if (!workspace.directoryId) throw new Error("Missing workspace identity");
	const scope = { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId };
	const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace);
	const store = new HarnessStateStore(agentDir, { workspace });
	const root = await store.initialize();
	const bundle = await store.saveVersion(
		{
			memory: Array.from({ length: count }, (_, index) => `Lesson ${index + 1}: Keep rule ${index + 1}.`).join(
				"\n\n",
			),
		},
		root.manifest.version,
		{ evolutionMemory: { nextLessonNumber: count + 1 } },
	);
	await store.selectVersion(bundle.manifest.version);
	const writer = new EvolutionMemoryWriter({
		version: "test",
		harnessState: store,
		statePath: join(stateDir, "evolution", "writer"),
	});
	const scores = new FileEvolutionPersistence(join(stateDir, "evolution"));
	const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
	const { trace } = await createInvocationTrace({ agentDir: stateDir, sessionManager: manager });
	cleanups.push(() => trace.close());
	await trace.attachSession(manager, "startup");
	const coordinator = new EvolutionRuntimeCoordinator(trace);
	const options = {
		cwd: harness.tempDir,
		agentDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		settingsManager: harness.settingsManager,
		harnessStateStore: store,
		subagents: false as const,
		tools: [],
	};
	const { session } = await createAgentSession({
		...options,
		sessionManager: manager,
		harnessVersionBundle: bundle,
		telemetryContext: trace,
		lifecycleObserver: coordinator,
	});
	cleanups.push(() => session.dispose());
	const runtime = await createCodingAgentEvolutionRuntime({
		agentDir: stateDir,
		cwd: harness.tempDir,
		session,
		harnessState: store,
		modelRuntime: session.modelRuntime,
		resourceLoader: session.resourceLoader,
	});
	cleanups.push(() => runtime.stop());
	const events: EvolutionRuntimeEvent[] = [];
	runtime.control.subscribe((event) => events.push(event));
	async function nextSession() {
		const opened = await createAgentSession({ ...options, sessionManager: SessionManager.inMemory() });
		cleanups.push(() => opened.session.dispose());
		return opened.session;
	}
	return { harness, store, writer, scores, scope, session, runtime, coordinator, events, bundle, nextSession };
}

function assessment(lessonNumber = 2) {
	return fauxAssistantMessage(
		fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [{ lessonNumber, signal: "helpful" }] }),
		{ stopReason: "toolUse" },
	);
}

const emptyReflection = () =>
	fauxAssistantMessage(fauxToolCall("submit_evolution_response", { complete: true, lessons: [] }), {
		stopReason: "toolUse",
	});

describe("Item 4: grooming before evolution snapshots", () => {
	it.each(["manual", "automatic"] as const)(
		"grooms five omissions before the %s job and next prompt",
		async (trigger) => {
			const env = await setup();
			if (trigger === "automatic") {
				// Keep real faux-provider/trace wiring, but cross the production token threshold without huge prompts.
				const stream = env.session.agent.streamFunction;
				env.session.agent.streamFunction = (model, context, options) => {
					const output = createAssistantMessageEventStream();
					void (async () => {
						for await (const event of await stream(model, context, options)) {
							if (event.type === "done") {
								event.message.usage = { ...event.message.usage, input: 80_000, output: 0, totalTokens: 80_000 };
							}
							output.push(event);
						}
						output.end();
					})();
					return output;
				};
				await env.coordinator.replace(env.runtime);
				cleanups.push(() => env.coordinator.stop());
			}
			for (let index = 0; index < 5; index += 1) {
				const main = fauxAssistantMessage("Verified the requested result.");
				env.harness.setResponses([
					main,
					assessment(),
					...(index === 4 && trigger === "automatic" ? Array.from({ length: 10 }, emptyReflection) : []),
				]);
				await env.session.prompt(`Verify result ${index + 1}.`);
			}
			expect(
				(await env.scores.loadLessonScores(env.scope, env.bundle.manifest.version)).scores.map(
					(item) => item.points,
				),
			).toEqual([-5, 5]);
			if (trigger === "manual") {
				expect((await env.store.loadCurrent()).manifest.version).toBe(env.bundle.manifest.version);
				env.harness.setResponses(Array.from({ length: 10 }, emptyReflection));
				await env.runtime.start();
				const started = await env.runtime.control.startManual();
				expect(started.status).toBe("created");
			}
			await vi.waitFor(async () => expect(await env.runtime.control.listJobs()).toHaveLength(1));
			const summary = (await env.runtime.control.listJobs())[0]!;
			await vi.waitFor(
				async () => {
					const detail = await env.scores.load(summary.jobId);
					expect(
						detail?.outcome,
						JSON.stringify({ stage: detail?.stage, reason: detail?.reasonCode, message: detail?.failureMessage }),
					).toBe("completed");
				},
				{ timeout: 5_000 },
			);
			const job = await env.scores.load(summary.jobId);
			if (!job) throw new Error("Missing job");
			const input = await env.scores.get(job.inputSnapshot);
			if (!("expectedHarnessBaseVersion" in input)) throw new Error("Missing input snapshot");
			const selected = await env.store.loadCurrent();
			expect(input.trigger).toBe(trigger);
			expect(input.expectedHarnessBaseVersion).toBe(selected.manifest.version);
			expect(input.harness).toEqual(await env.writer.captureSnapshot());
			expect(input.harness.memory).toBe("Lesson 1: Keep rule 2.");
			expect(input.harness.memoryContentDigest).toBe(computeEvolutionContentDigest(selected.state.memory));
			expect(selected.manifest.metadata.evolutionMemory.nextLessonNumber).toBe(2);
			expect(env.session.activeHarnessVersion).toBe(env.bundle.manifest.version);
			expect(env.events.slice(0, 3).map((event) => event.type)).toEqual([
				"lesson-grooming",
				"lesson-grooming",
				"started",
			]);
			expect(env.events.slice(0, 2)).toEqual([
				{ type: "lesson-grooming", active: true },
				{ type: "lesson-grooming", active: false },
			]);
			const curator = new CuratorToolRegistry({
				jobId: job.jobId,
				input,
				lessons: [],
				instructions: [],
				audit: async () => {},
			});
			expect(curator.memory.entries.map(({ value }) => value.item)).toEqual(input.harness.activeMemoryItems);
			expect(curator.memory.entries.map(({ value }) => value.block.content)).toEqual(["Lesson 1: Keep rule 2."]);
			expect(curator.capabilities.removableMemoryRefs).toEqual([]);
			const next = await env.nextSession();
			env.harness.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain("Lesson 1: Keep rule 2.");
					expect(context.systemPrompt).not.toContain("Keep rule 1.");
					return fauxAssistantMessage("Verified again.");
				},
				assessment(1),
			]);
			await next.prompt("Verify again.");
			expect(env.harness.getPendingResponseCount()).toBe(0);
		},
	);

	it.each([0, 12])("leaves %i lessons unchanged below grooming thresholds", async (count) => {
		const env = await setup(count);
		for (let index = 0; index < 4; index += 1) {
			env.harness.setResponses([fauxAssistantMessage("Verified."), ...(count === 0 ? [] : [assessment()])]);
			await env.session.prompt(`Verify result ${index + 1}.`);
		}
		if (count > 0) {
			expect(
				(await env.scores.loadLessonScores(env.scope, env.bundle.manifest.version)).scores.map(
					(item) => item.points,
				),
			).toEqual(Array.from({ length: count }, (_, index) => (index === 1 ? 4 : -4)));
		}
		const before = await env.writer.captureSnapshot();
		const groom = vi.spyOn(EvolutionMemoryWriter.prototype, "groom");
		const started = await env.runtime.control.startManual();
		if (started.status !== "created") throw new Error("Expected a job");
		expect(await env.store.loadCurrent()).toEqual(env.bundle);
		expect(await env.writer.captureSnapshot()).toEqual(before);
		const job = await env.scores.load(started.job.jobId);
		if (!job) throw new Error("Missing job");
		const input = await env.scores.get(job.inputSnapshot);
		if (!("expectedHarnessBaseVersion" in input)) throw new Error("Missing input snapshot");
		expect(input.expectedHarnessBaseVersion).toBe(env.bundle.manifest.version);
		expect(input.harness).toEqual(before);
		expect(groom).toHaveBeenCalledTimes(count === 0 ? 0 : 1);
		if (count === 0) expect(env.events.filter((event) => event.type === "lesson-grooming")).toEqual([]);
		expect(env.harness.getPendingResponseCount()).toBe(0);
		await env.runtime.control.cancelJob(started.job.jobId);
	});

	it("skips grooming the empty selection while the session remains pinned to lessons", async () => {
		const env = await setup();
		env.harness.setResponses([fauxAssistantMessage("Verified."), assessment()]);
		await env.session.prompt("Verify before changing selection.");
		const empty = await env.store.saveVersion({ memory: "" }, env.bundle.manifest.version);
		await env.store.selectVersion(empty.manifest.version);
		expect(env.session.activeHarnessVersion).toBe(env.bundle.manifest.version);
		expect(env.session.harnessVersionBundle?.state.memory).toContain("Keep rule 1.");
		const groom = vi.spyOn(EvolutionMemoryWriter.prototype, "groom");
		const started = await env.runtime.control.startManual();
		if (started.status !== "created") throw new Error("Expected a job");
		const job = await env.scores.load(started.job.jobId);
		if (!job) throw new Error("Missing job");
		const input = await env.scores.get(job.inputSnapshot);
		if (!("expectedHarnessBaseVersion" in input)) throw new Error("Missing input snapshot");
		expect(input.expectedHarnessBaseVersion).toBe(empty.manifest.version);
		expect(input.harness).toEqual(await env.writer.captureSnapshot(empty.manifest.version));
		expect(input.harness.memory).toBe("");
		expect(input.harness.activeMemoryItems).toEqual([]);
		expect(await env.store.loadCurrent()).toEqual(empty);
		expect(env.session.activeHarnessVersion).toBe(env.bundle.manifest.version);
		expect(groom).not.toHaveBeenCalled();
		expect(env.events.filter((event) => event.type === "lesson-grooming")).toEqual([]);
		expect(env.harness.getPendingResponseCount()).toBe(0);
		await env.runtime.control.cancelJob(started.job.jobId);
	});

	it("trims the uniquely lowest of thirteen manual lessons and skips an ineligible automatic check", async () => {
		const env = await setup(13);
		expect(await env.runtime.control.triggerAutomatic()).toMatchObject({ status: "not-created" });
		expect(env.events).toEqual([]);
		expect((await env.store.loadCurrent()).manifest.version).toBe(env.bundle.manifest.version);
		env.harness.setResponses([
			fauxAssistantMessage("Verified."),
			fauxAssistantMessage(
				fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [{ lessonNumber: 7, signal: "harmful" }] }),
				{ stopReason: "toolUse" },
			),
		]);
		await env.session.prompt("Verify.");
		expect(
			(await env.scores.loadLessonScores(env.scope, env.bundle.manifest.version)).scores.map((item) => item.points),
		).toEqual(Array.from({ length: 13 }, (_, index) => (index === 6 ? -1.5 : -1)));
		const started = await env.runtime.control.startManual();
		if (started.status !== "created") throw new Error("Expected a job");
		const snapshot = await env.writer.captureSnapshot();
		expect(snapshot.activeMemoryItems).toHaveLength(12);
		expect(snapshot.memory).not.toContain("Keep rule 7.");
		expect(snapshot.memory).toContain("Lesson 1: Keep rule 1.");
		expect(snapshot.memory).toContain("Lesson 7: Keep rule 8.");
		expect(snapshot.memory).toContain("Lesson 12: Keep rule 13.");
		expect((await env.store.loadCurrent()).manifest.metadata.evolutionMemory.nextLessonNumber).toBe(13);
		expect((await env.runtime.control.getJob(started.job.jobId)).baseHarnessVersion).toBe(snapshot.harnessVersion);
		await env.runtime.control.cancelJob(started.job.jobId);
	});
});
