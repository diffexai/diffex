import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import { materializeJsonlInvocation } from "#harness-trace";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../../src/core/invocation-trace.ts";
import { LESSON_REPORT_TOOL } from "../../src/core/lesson-reports.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SKILL_REPORT_TOOL } from "../../src/core/skill-reports.ts";
import { goalControls } from "./goal-harness.ts";
import { createHarness } from "./harness.ts";

const marker = "GOAL_MODE_PRIVATE_EVOLUTION_EVIDENCE";

describe("goal mode evolution isolation", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("suppresses real lesson feedback and excludes goal runs from later trace ingestion", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
		cleanups.push(harness.cleanup);
		const agentDir = join(harness.tempDir, "agent");
		const workspace = await resolveHarnessWorkspace(harness.tempDir);
		const store = new HarnessStateStore(agentDir, { workspace: workspace.workspace });
		const initial = await store.initialize();
		const bundle = await store.saveVersion({ memory: "Lesson 1: Verify every result.\n" }, initial.manifest.version);
		await store.selectVersion(bundle.manifest.version);
		const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
		const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace.workspace);
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
		const report = fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }), {
			stopReason: "toolUse",
		});

		harness.setResponses([fauxAssistantMessage("Before goal mode."), report]);
		await session.prompt("Run the ordinary baseline.");
		expect(harness.getPendingResponseCount()).toBe(0);
		const baseline = harness.faux.state.callCount;
		expect(baseline).toBe(2);

		const goal = goalControls({ ...harness, session });
		await goal.setGoalModeEnabled(true);
		harness.setResponses([fauxAssistantMessage(`${marker} result`), report]);
		await session.prompt(`${marker} request`);
		expect(harness.faux.state.callCount).toBe(baseline + 1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(session.systemPrompt).toContain("Verify every result.");
		expect(harness.settingsManager.getEvolutionEnabled()).toBe(true);

		await goal.setGoalModeEnabled(false);
		harness.setResponses([fauxAssistantMessage("After goal mode."), report]);
		await session.prompt("Run the normal follow-up.");
		expect(harness.faux.state.callCount).toBe(baseline + 3);
		expect(harness.getPendingResponseCount()).toBe(0);
		await session.dispose();
		await trace.close();
		const traceDir = join(stateDir, "traces");
		const traceFiles = (await readdir(traceDir)).filter((name) => name.endsWith(".jsonl"));
		expect(traceFiles.length).toBeGreaterThan(0);
		const traces = await Promise.all(traceFiles.map((name) => readFile(join(traceDir, name), "utf8")));
		expect(traces.join("\n")).not.toContain(marker);
		const materialized = await Promise.all(
			traceFiles.map((name) => materializeJsonlInvocation(join(traceDir, name))),
		);
		expect(JSON.stringify(materialized)).not.toContain(marker);
	});

	it("suppresses SDK-wired evolved skill feedback and restores it on exit", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
		cleanups.push(harness.cleanup);
		const agentDir = join(harness.tempDir, "agent");
		const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
		const store = new HarnessStateStore(agentDir, { workspace });
		const initial = await store.initialize();
		const bundle = await store.saveVersion(
			{
				memory: "",
				skills: [
					{
						path: "skills/verify/SKILL.md",
						content: "---\nname: verify\ndescription: Verify the result.\n---\n\nCheck the result.\n",
						workspace,
					},
				],
			},
			initial.manifest.version,
		);
		await store.selectVersion(bundle.manifest.version);
		const loader = new DefaultResourceLoader({
			cwd: harness.tempDir,
			agentDir,
			settingsManager: harness.settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionsOverride: () => harness.session.resourceLoader.getExtensions(),
			skillsOverride: () => ({ skills: [], diagnostics: [] }),
		});
		await loader.reload();
		const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: loader,
			settingsManager: harness.settingsManager,
			sessionManager: manager,
			harnessStateStore: store,
			harnessVersionBundle: bundle,
			subagents: false,
			tools: ["read"],
		});
		cleanups.push(() => session.dispose());
		const report = fauxAssistantMessage(fauxToolCall(SKILL_REPORT_TOOL.name, { skills: [] }), {
			stopReason: "toolUse",
		});
		const calls: string[][] = [];
		const capture = (response: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
			calls.push(context.tools?.map((tool) => tool.name) ?? []);
			return response;
		};
		harness.setResponses([capture(fauxAssistantMessage("Baseline.")), capture(report)]);
		await session.prompt("Use the evolved verification skill.");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual([SKILL_REPORT_TOOL.name]);
		const goal = goalControls({ ...harness, session });
		await goal.setGoalModeEnabled(true);
		harness.setResponses([capture(fauxAssistantMessage("Goal mode answer.")), capture(report)]);
		await session.prompt("Use the evolved verification skill again.");
		expect(calls).toHaveLength(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(session.systemPrompt).toContain("verify");
		await goal.setGoalModeEnabled(false);
		harness.setResponses([capture(fauxAssistantMessage("After goal.")), capture(report)]);
		await session.prompt("Continue verifying.");
		expect(calls).toHaveLength(5);
		expect(calls[4]).toEqual([SKILL_REPORT_TOOL.name]);
		expect(harness.settingsManager.getEvolutionEnabled()).toBe(true);
	});
});
