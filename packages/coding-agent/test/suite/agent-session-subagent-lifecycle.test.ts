import type { AgentToolResult } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/diffex-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../../src/index.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

const extensionContext = {} as ExtensionContext;

describe("AgentSession subagent lifecycle", () => {
	const roots: AgentSession[] = [];
	const harnesses: Harness[] = [];
	const fauxProviders: FauxProviderRegistration[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) await root.dispose();
		for (const faux of fauxProviders.splice(0)) faux.unregister();
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	async function createRoot(customTools: ToolDefinition[] = []): Promise<{ root: AgentSession; harness: Harness }> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const { session: root } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model: harness.getModel(),
			customTools,
			tools: [...customTools.map((tool) => tool.name), "spawn_agent", "agent_action", "agents"],
			subagents: { maxConcurrent: 1 },
		});
		roots.push(root);
		return { root, harness };
	}

	it("returns an immutable empty roster when subagents are disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model: harness.getModel(),
			subagents: false,
		});
		roots.push(session);

		const summaries = session.getSubagents();
		expect(summaries).toEqual([]);
		expect(Object.isFrozen(summaries)).toBe(true);
	});

	it("exposes sorted queued and running summaries through the session", async () => {
		const { root, harness } = await createRoot();
		const runningStarted = deferred<void>();
		const runningFinished = deferred<void>();
		harness.setResponses([
			async () => {
				runningStarted.resolve();
				await runningFinished.promise;
				return fauxAssistantMessage("running done");
			},
			fauxAssistantMessage("queued done"),
		]);
		const spawn = root.getToolDefinition("spawn_agent")!;
		const agents = root.getToolDefinition("agents")!;

		await spawn.execute(
			"spawn-zeta",
			{ name: "zeta", task: "original running task" },
			undefined,
			undefined,
			extensionContext,
		);
		await runningStarted.promise;
		await spawn.execute(
			"spawn-alpha",
			{ name: "alpha", task: "original queued task" },
			undefined,
			undefined,
			extensionContext,
		);

		const summaries = root.getSubagents();
		expect(summaries).toEqual([
			{ name: "alpha", status: "queued", task: "original queued task" },
			{ name: "zeta", status: "running", task: "original running task" },
		]);
		expect(Object.isFrozen(summaries)).toBe(true);
		expect(summaries.every(Object.isFrozen)).toBe(true);

		runningFinished.resolve();
		await agents.execute("wait-all", { timeout_ms: 1_000, until: "all" }, undefined, undefined, extensionContext);
	});

	it("awaits root and child cancellation and rejects retained tools after disposal", async () => {
		const rootToolStarted = deferred<void>();
		const rootToolAborted = deferred<void>();
		const blockingTool: ToolDefinition = {
			name: "block",
			label: "Block",
			description: "Block until aborted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					rootToolStarted.resolve();
					signal?.addEventListener(
						"abort",
						() => {
							rootToolAborted.resolve();
							resolve({ content: [{ type: "text", text: "root tool aborted" }], details: {} });
						},
						{ once: true },
					);
				}),
		};
		const { root, harness } = await createRoot([blockingTool]);
		const childProviderStarted = deferred<void>();
		const childProviderAborted = deferred<void>();
		harness.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					childProviderStarted.resolve();
					options?.signal?.addEventListener(
						"abort",
						() => {
							childProviderAborted.resolve();
							resolve(fauxAssistantMessage("child aborted", { stopReason: "aborted" }));
						},
						{ once: true },
					);
				}),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
		]);

		const spawn = root.getToolDefinition("spawn_agent")!;
		const action = root.getToolDefinition("agent_action")!;
		const agents = root.getToolDefinition("agents")!;
		const originalDispose = AgentSession.prototype.dispose;
		const disposedSessions: AgentSession[] = [];
		vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
			disposedSessions.push(this);
			return originalDispose.call(this);
		});
		const events: unknown[] = [];
		root.subscribe((event) => events.push(event));

		await spawn.execute("spawn-active", { name: "active", task: "wait" }, undefined, undefined, extensionContext);
		await childProviderStarted.promise;
		await spawn.execute("spawn-queued", { name: "queued", task: "wait" }, undefined, undefined, extensionContext);
		const agentsWaitResult = agents
			.execute(
				"wait-agents",
				{ timeout_ms: 10_000, targets: ["active", "queued"], until: "all" },
				undefined,
				undefined,
				extensionContext,
			)
			.catch((error: unknown) => error);
		const rootPrompt = root.prompt("run the blocking tool");
		await rootToolStarted.promise;

		const firstDispose = root.dispose();
		const secondDispose = root.dispose();
		expect(firstDispose).toBe(secondDispose);
		await Promise.all([childProviderAborted.promise, rootToolAborted.promise]);
		await firstDispose;
		await rootPrompt;
		await expect(agentsWaitResult).resolves.toMatchObject({ message: "Subagent controller is shut down" });

		expect(disposedSessions.filter((session) => session !== root)).toHaveLength(1);
		const settledEventCount = events.length;
		await Promise.resolve();
		expect(events).toHaveLength(settledEventCount);
		await expect(
			spawn.execute("spawn-late", { name: "late", task: "late" }, undefined, undefined, extensionContext),
		).rejects.toThrow("Subagent controller is shut down");
		await expect(
			action.execute(
				"action-late",
				{ target: "active", action: "interrupt" },
				undefined,
				undefined,
				extensionContext,
			),
		).rejects.toThrow("Subagent controller is shut down");
		await expect(
			agents.execute("agents-late", { timeout_ms: 0 }, undefined, undefined, extensionContext),
		).rejects.toThrow("Subagent controller is shut down");
	});

	it("resets children before reload and reuses retained tools and names", async () => {
		const { root, harness } = await createRoot();
		const childProviderStarted = deferred<void>();
		const childProviderAborted = deferred<void>();
		harness.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					childProviderStarted.resolve();
					options?.signal?.addEventListener(
						"abort",
						() => {
							childProviderAborted.resolve();
							resolve(fauxAssistantMessage("child aborted", { stopReason: "aborted" }));
						},
						{ once: true },
					);
				}),
		]);
		const spawn = root.getToolDefinition("spawn_agent")!;
		const agents = root.getToolDefinition("agents")!;
		await spawn.execute("spawn-worker", { name: "worker", task: "wait" }, undefined, undefined, extensionContext);
		await childProviderStarted.promise;
		await spawn.execute("spawn-queued", { name: "queued", task: "wait" }, undefined, undefined, extensionContext);
		const agentsWaitResult = agents
			.execute(
				"wait-agents",
				{ timeout_ms: 10_000, targets: ["worker", "queued"], until: "all" },
				undefined,
				undefined,
				extensionContext,
			)
			.catch((error: unknown) => error);

		const originalDispose = AgentSession.prototype.dispose;
		const childDisposeStarted = deferred<void>();
		const childDisposeGate = deferred<void>();
		vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
			const disposal = originalDispose.call(this);
			if (this === root) return disposal;
			return disposal.then(async () => {
				childDisposeStarted.resolve();
				await childDisposeGate.promise;
			});
		});
		const settingsReload = vi.spyOn(root.settingsManager, "reload");
		const reload = root.reload();
		await Promise.all([childProviderAborted.promise, childDisposeStarted.promise]);
		expect(settingsReload).not.toHaveBeenCalled();
		childDisposeGate.resolve();
		await reload;
		await expect(agentsWaitResult).resolves.toMatchObject({ message: "Subagent controller is resetting" });
		expect(settingsReload).toHaveBeenCalledOnce();

		const reloadedFaux = registerFauxProvider();
		fauxProviders.push(reloadedFaux);
		const fauxModel = reloadedFaux.getModel();
		root.modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: reloadedFaux.api,
			models: reloadedFaux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});
		await root.setModel(fauxModel);
		reloadedFaux.setResponses([fauxAssistantMessage("worker done"), fauxAssistantMessage("queued done")]);
		await spawn.execute("reuse-worker", { name: "worker", task: "again" }, undefined, undefined, extensionContext);
		const workerResult = await agents.execute(
			"wait-worker",
			{ timeout_ms: 1_000, targets: ["worker"], until: "all" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(workerResult).toMatchObject({
			details: { timed_out: false, agents: [{ name: "worker", status: "idle", result: "worker done" }] },
		});
		await spawn.execute("reuse-queued", { name: "queued", task: "again" }, undefined, undefined, extensionContext);
		await expect(
			agents.execute(
				"wait-queued",
				{ timeout_ms: 1_000, targets: ["queued"], until: "all" },
				undefined,
				undefined,
				extensionContext,
			),
		).resolves.toMatchObject({ details: { timed_out: false, agents: [{ name: "queued", status: "idle" }] } });
	});
});
