import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@diffexai/diffex-ai";
import { HarnessStateStore } from "@diffexai/diffex-harness-state";
import { NOOP_TELEMETRY_CONTEXT } from "@diffexai/diffex-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionMemoryWriter } from "#evolution";
import { materializeJsonlInvocation } from "#harness-trace";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createCodingAgentEvolutionRuntime } from "../../../src/core/evolution-runtime.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../../../src/core/invocation-trace.ts";
import {
	createLessonReportContinuation,
	LESSON_REPORT_PROMPT,
	LESSON_REPORT_TOOL,
	resolveLessonReport,
	type ValidatedLessonReport,
} from "../../../src/core/lesson-reports.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText } from "../harness.ts";

const MEMORY = "Lesson 1: Verify the result.\n\nLesson 2: Keep changes narrow.\n\nLesson 3: Read before editing.\n";
const MARKER = "PRIVATE_LESSON_REPORT_RESPONSE";

function report(lessons: unknown) {
	return fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons }, { id: MARKER }), {
		stopReason: "toolUse",
	});
}

async function readTree(directory: string): Promise<string> {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map((entry) =>
				entry.isDirectory() ? readTree(join(directory, entry.name)) : readFile(join(directory, entry.name), "utf8"),
			),
		)
	).join("\n");
}

function expectPrivate(value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	expect(text).not.toContain(LESSON_REPORT_PROMPT);
	expect(text).not.toContain(LESSON_REPORT_TOOL.name);
	expect(text).not.toContain(MARKER);
}

describe("Item 2: private per-turn lesson reports", () => {
	const cleanups: (() => Promise<void>)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function setup(memory = MEMORY) {
		const observedExtensions: unknown[] = [];
		const harness = await createHarness({
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(diffex) => {
					diffex.on("agent_start", (event) => {
						observedExtensions.push(structuredClone(event));
					});
					diffex.on("agent_end", (event) => {
						observedExtensions.push(structuredClone(event));
					});
					diffex.on("context", (event) => {
						observedExtensions.push(structuredClone(event));
					});
					diffex.on("before_provider_request", (event) => {
						observedExtensions.push(structuredClone(event));
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		const agentDir = join(harness.tempDir, "agent");
		const workspace = await resolveHarnessWorkspace(harness.tempDir);
		const store = new HarnessStateStore(agentDir, { workspace: workspace.workspace });
		const initial = await store.initialize();
		const bundle = await store.saveVersion({ memory }, initial.manifest.version);
		await store.selectVersion(bundle.manifest.version);
		const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace.workspace);
		const writer = new EvolutionMemoryWriter({
			version: "test",
			harnessState: store,
			statePath: join(stateDir, "evolution", "writer"),
		});
		const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: stateDir, sessionManager: manager });
		cleanups.push(() => trace.close());
		await trace.attachSession(manager, "startup");
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			sessionManager: manager,
			harnessStateStore: store,
			harnessVersionBundle: bundle,
			telemetryContext: trace,
			lifecycleObserver: trace,
			subagents: false,
			tools: ["read"],
		});
		cleanups.push(() => session.dispose());
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(structuredClone(event));
		});
		return {
			harness,
			session,
			manager,
			trace,
			writer,
			bundle,
			store,
			stateDir,
			agentDir,
			events,
			observedExtensions,
		};
	}

	it("uses one final production-wired report per prompt without leaking into later prompts, exports, compaction, traces or snapshots", async () => {
		const env = await setup();
		const fixture = join(env.harness.tempDir, "input.txt");
		await writeFile(fixture, "ordinary tool result");
		const calls: { context: Context; options: SimpleStreamOptions | undefined }[] = [];
		const responses = [
			fauxAssistantMessage(fauxToolCall("read", { path: fixture }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Checked the requested input and verified its contents."),
			report([
				{ lessonNumber: 1, signal: "helpful" },
				{ lessonNumber: 2, signal: "harmful" },
			]),
			fauxAssistantMessage("The follow-up is complete."),
			report([{ lessonNumber: 3, signal: "helpful" }]),
		];
		env.harness.setResponses(
			responses.map((response) => (context, options) => {
				calls.push({ context: { ...context, messages: structuredClone(context.messages) }, options });
				return response;
			}),
		);
		await env.session.prompt("Read the input and verify it.");
		await env.session.prompt("Confirm the result.");
		expect(calls).toHaveLength(5);
		expect(calls[1]?.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		for (const index of [2, 4]) {
			const main = calls[index - 1]!;
			const assessment = calls[index]!;
			expect(assessment.context.systemPrompt).toBe(main.context.systemPrompt);
			expect(assessment.context.systemPrompt?.split(MEMORY)).toHaveLength(2);
			expect(assessment.context.messages.slice(0, main.context.messages.length)).toEqual(main.context.messages);
			expect(getMessageText(assessment.context.messages.at(-1))).toBe(LESSON_REPORT_PROMPT);
			expect(
				assessment.context.messages.slice(main.context.messages.length, -1).map((message) => message.role),
			).toEqual(["assistant"]);
			expect(assessment.context.tools).toEqual([LESSON_REPORT_TOOL]);
			expect(assessment.options?.telemetryContext).toBe(NOOP_TELEMETRY_CONTEXT);
			expect(assessment.options?.sessionId).toBeUndefined();
			expect(assessment.options?.onPayload).toBeUndefined();
			expect(assessment.options?.onResponse).toBeUndefined();
			expect(assessment.options?.transport).toBe("sse");
			expectPrivate(main.context);
		}
		expect(env.session.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
		expect(env.observedExtensions.some((event) => JSON.stringify(event).includes("agent_end"))).toBe(true);
		expectPrivate(env.events);
		expectPrivate(env.observedExtensions);
		expectPrivate(env.manager.getEntries());
		expectPrivate(await readFile(env.session.exportToJsonl(join(env.agentDir, "export.jsonl")), "utf8"));
		expectPrivate(await readFile(await env.session.exportToHtml(join(env.agentDir, "export.html")), "utf8"));

		const traces = (await readdir(join(env.stateDir, "traces"))).filter((path) => path.endsWith(".jsonl"));
		expect(traces.length).toBeGreaterThanOrEqual(2);
		for (const file of traces) {
			const path = join(env.stateDir, "traces", file);
			expectPrivate(await readFile(path, "utf8"));
			const invocation = await materializeJsonlInvocation(path);
			expect(invocation.integrity).toBe("complete");
			expect(invocation.evidence.length).toBeGreaterThan(0);
			expectPrivate(invocation);
		}
		const evolution = await createCodingAgentEvolutionRuntime({
			agentDir: env.stateDir,
			cwd: env.harness.tempDir,
			session: env.session,
			harnessState: env.store,
			modelRuntime: env.session.modelRuntime,
			resourceLoader: env.session.resourceLoader,
		});
		cleanups.push(() => evolution.stop());
		const started = await evolution.control.startManual();
		expect(started.status).toBe("created");
		expectPrivate(await readTree(env.stateDir));

		const compactContexts: Context[] = [];
		env.harness.setResponses(
			[0, 1].map(() => (context) => {
				compactContexts.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("Summary: verified the input.");
			}),
		);
		await env.session.compact();
		expect(compactContexts).toHaveLength(2);
		expectPrivate(compactContexts);
		expectPrivate(env.manager.getEntries());
	});

	it("binds judgments to the pre-output catalog despite selection and numbering changes while pending", async () => {
		const env = await setup();
		const reports: ValidatedLessonReport[] = [];
		let selected = env.bundle;
		env.session.agent.preparePrivateContinuation = createLessonReportContinuation({
			getBundle: () => selected,
			getOutputId: () => "test-output",
			writer: env.writer,
			stream: (model, context, options) => env.session.modelRuntime.streamSimple(model, context, options),
			consume: async (value) => {
				reports.push(value);
			},
		});
		const oldItems = await env.writer.loadActiveMemoryItems(env.bundle);
		env.harness.setResponses([
			async () => {
				selected = await env.store.saveVersion(
					{ memory: "Lesson 1: A different lesson.\n" },
					env.bundle.manifest.version,
				);
				await env.store.selectVersion(selected.manifest.version);
				return fauxAssistantMessage("Main output finished after a revision switch.");
			},
			async () => {
				selected = await env.store.saveVersion(
					{ memory: "Lesson 1: Yet another lesson.\n" },
					selected.manifest.version,
				);
				await env.store.selectVersion(selected.manifest.version);
				return report([{ lessonNumber: 2, signal: "helpful" }]);
			},
		]);
		await env.session.prompt("Verify with the original lessons.");
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			harnessRevision: env.bundle.manifest.version,
			activeMemoryItems: oldItems,
			judgments: [{ item: oldItems[1], signal: "helpful" }],
		});
		expect(reports[0]?.harnessRevision).not.toBe(selected.manifest.version);
		expectPrivate(env.events);
	});

	it("accepts sparse and empty reports, rejecting malformed, neutral, duplicate, conflicting and unknown refs atomically", async () => {
		const env = await setup();
		const activeMemoryItems = await env.writer.loadActiveMemoryItems(env.bundle);
		const binding = { outputId: "test-output", harnessRevision: env.bundle.manifest.version, activeMemoryItems };
		expect(resolveLessonReport(report([]), binding, [1, 2, 3])?.judgments).toEqual([]);
		expect(
			resolveLessonReport(report([{ lessonNumber: 3, signal: "harmful" }]), binding, [1, 2, 3])?.judgments,
		).toEqual([{ item: activeMemoryItems[2], signal: "harmful" }]);
		const bad = [
			null,
			{},
			[{ lessonNumber: "1", signal: "helpful" }],
			[{ lessonNumber: 1, signal: "neutral" }],
			[{ lessonNumber: 1, signal: "helpful", extra: true }],
			[{ lessonNumber: 1.5, signal: "harmful" }],
			[
				{ lessonNumber: 1, signal: "helpful" },
				{ lessonNumber: 4, signal: "harmful" },
			],
			[
				{ lessonNumber: 2, signal: "helpful" },
				{ lessonNumber: 2, signal: "helpful" },
			],
			[
				{ lessonNumber: 2, signal: "helpful" },
				{ lessonNumber: 2, signal: "harmful" },
			],
		];
		for (const lessons of bad) expect(resolveLessonReport(report(lessons), binding, [1, 2, 3])).toBeUndefined();
		for (const stopReason of ["stop", "length", "error", "aborted"] as const) {
			expect(resolveLessonReport({ ...report([]), stopReason }, binding, [1, 2, 3])).toBeUndefined();
		}
		expect(
			resolveLessonReport(
				fauxAssistantMessage(
					[
						fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }),
						fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }),
					],
					{ stopReason: "toolUse" },
				),
				binding,
				[1, 2, 3],
			),
		).toBeUndefined();

		const consumed: ValidatedLessonReport[] = [];
		env.session.agent.preparePrivateContinuation = createLessonReportContinuation({
			getBundle: () => env.session.harnessVersionBundle,
			getOutputId: () => "test-output",
			writer: env.writer,
			stream: (model, context, options) => env.session.modelRuntime.streamSimple(model, context, options),
			consume: async (value) => {
				consumed.push(value);
			},
		});
		for (const response of [
			...bad.map(report),
			fauxAssistantMessage(MARKER, { stopReason: "error", errorMessage: MARKER }),
			fauxAssistantMessage("not a report"),
			report([]),
		]) {
			env.harness.setResponses([fauxAssistantMessage("normal answer"), response]);
			await env.session.prompt("Continue checking.");
		}
		expect(consumed).toHaveLength(1);
		expect(consumed[0]?.judgments).toEqual([]);
		expectPrivate(env.events);
		expectPrivate(env.manager.getEntries());
		expectPrivate(await readTree(env.stateDir));
	});

	it("does not assess when memory is empty or when the main output fails", async () => {
		const empty = await setup("");
		empty.harness.setResponses([fauxAssistantMessage("ordinary answer")]);
		await empty.session.prompt("Hello");
		expect(empty.harness.faux.state.callCount).toBe(1);
		const active = await setup();
		active.harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "main failure" })]);
		await active.session.prompt("Hello");
		expect(active.harness.faux.state.callCount).toBe(1);
	});
});
