import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@diffexai/diffex-ai";
import { HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import { materializeJsonlInvocation } from "#harness-trace";
import { createCodingAgentEvolutionRuntime, EvolutionRuntimeCoordinator } from "../../src/core/evolution-runtime.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../../src/core/invocation-trace.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { goalControls } from "./goal-harness.ts";
import { createHarness } from "./harness.ts";

describe("goal mode evolution lifecycle", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it.each([false, true])(
		"blocks manual evolution and honors the global preference after exit (%s)",
		async (globalPreference) => {
			const harness = await createHarness();
			cleanups.push(harness.cleanup);
			const agentDir = join(harness.tempDir, "agent");
			const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
			const store = new HarnessStateStore(agentDir, { workspace });
			const bundle = await store.initialize();
			const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
			const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace);
			const { trace } = await createInvocationTrace({ agentDir: stateDir, sessionManager: manager });
			cleanups.push(() => trace.close());
			await trace.attachSession(manager, "startup");
			const coordinator = new EvolutionRuntimeCoordinator(trace, {
				getEnabled: () => harness.settingsManager.getEvolutionEnabled(),
				setEnabled: (enabled) => harness.settingsManager.setEvolutionEnabled(enabled),
			});
			cleanups.push(() => coordinator.stop());
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
				lifecycleObserver: coordinator,
				subagents: false,
				tools: ["read"],
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
			await coordinator.replace(runtime);
			// Manual evolution needs eligible pre-goal evidence to create a job.
			harness.setResponses([fauxAssistantMessage("Baseline investigation complete.")]);
			await session.prompt("Investigate the baseline task.");
			const goal = goalControls({ ...harness, session });
			await goal.setGoalModeEnabled(true);
			expect(harness.settingsManager.getEvolutionEnabled()).toBe(true);
			await expect(Promise.resolve().then(() => coordinator.startManual())).rejects.toThrow(
				/evolution|goal|disabled|suspend/i,
			);
			expect(await runtime.control.listJobs()).toEqual([]);
			harness.settingsManager.setEvolutionEnabled(globalPreference);
			await goal.setGoalModeEnabled(false);
			expect(harness.settingsManager.getEvolutionEnabled()).toBe(globalPreference);
			if (globalPreference) expect((await coordinator.startManual()).status).toBe("created");
			else await expect(Promise.resolve().then(() => coordinator.startManual())).rejects.toThrow(/disabled/i);
		},
	);

	it("restores suspension before recording the first resumed operation", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
		cleanups.push(harness.cleanup);
		const agentDir = join(harness.tempDir, "agent");
		const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
		const store = new HarnessStateStore(agentDir, { workspace });
		const bundle = await store.initialize();
		const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
		const first = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			sessionManager: manager,
			harnessStateStore: store,
			harnessVersionBundle: bundle,
			subagents: false,
			tools: ["read"],
		});
		cleanups.push(() => first.session.dispose());
		await goalControls({ ...harness, session: first.session }).setGoalModeEnabled(true);
		harness.setResponses([fauxAssistantMessage("Saved goal session.")]);
		await first.session.prompt("Create the resumable session.");
		await first.session.dispose();
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("Missing persisted session path");
		const resumedManager = SessionManager.open(sessionPath);
		const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace);
		const { trace } = await createInvocationTrace({ agentDir: stateDir, sessionManager: resumedManager });
		cleanups.push(() => trace.close());
		await trace.attachSession(resumedManager, "startup");
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			sessionManager: resumedManager,
			harnessStateStore: store,
			harnessVersionBundle: bundle,
			telemetryContext: trace,
			lifecycleObserver: trace,
			subagents: false,
			tools: ["read"],
		});
		cleanups.push(() => resumed.session.dispose());
		expect(goalControls({ ...harness, session: resumed.session }).isGoalModeEnabled).toBe(true);
		const marker = "RESUMED_GOAL_TRACE_EXCLUSION";
		harness.setResponses([fauxAssistantMessage(`${marker} answer`)]);
		await resumed.session.prompt(`${marker} request`);
		await resumed.session.dispose();
		await trace.close();
		const traceDirectory = join(stateDir, "traces");
		const files = await readdir(traceDirectory).catch(() => []);
		for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
			const path = join(traceDirectory, file);
			expect(await readFile(path, "utf8")).not.toContain(marker);
			expect(JSON.stringify(await materializeJsonlInvocation(path))).not.toContain(marker);
		}
	});
});
