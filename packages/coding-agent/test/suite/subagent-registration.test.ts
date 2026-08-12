import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/diffex-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-services.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { getLastUserText } from "./subagent-harness.ts";

const COORDINATION_TOOLS = ["spawn_agent", "agent_action", "agents"];

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createTestTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: `${name} result` }],
			details: {},
		}),
	};
}

function getActiveTool(session: AgentSession, name: string): AgentTool {
	const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing active tool: ${name}`);
	return tool;
}

describe("root subagent tool registration", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	const runtimeCleanups: Array<() => Promise<void>> = [];
	let rootIndex = 0;

	afterEach(async () => {
		while (runtimeCleanups.length > 0) await runtimeCleanups.pop()?.();
		while (sessions.length > 0) sessions.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setupHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		return harness;
	}

	async function createServices(harness: Harness, suffix = `${rootIndex++}`): Promise<AgentSessionServices> {
		const cwd = join(harness.tempDir, `root-${suffix}`);
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		return createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				reloadSettings: false,
			},
		});
	}

	async function createRoot(
		harness: Harness,
		options: Omit<CreateAgentSessionOptions, "modelRuntime" | "resourceLoader" | "settingsManager"> = {},
	): Promise<{ session: AgentSession; services: AgentSessionServices }> {
		const services = await createServices(harness);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(services.cwd),
			model: options.model ?? harness.getModel("faux-1"),
			thinkingLevel: options.thinkingLevel ?? "high",
			scopedModels: options.scopedModels,
			tools: options.tools,
			excludeTools: options.excludeTools,
			noTools: options.noTools,
			customTools: options.customTools,
			subagents: options.subagents,
		});
		sessions.push(session);
		return { session, services };
	}

	it("registers and activates all coordination tools by default", async () => {
		const harness = await setupHarness();
		const customTool = createTestTool("caller_tool");
		const { session } = await createRoot(harness, { customTools: [customTool] });

		const configured = session.getAllTools().map((tool) => tool.name);
		const active = session.getActiveToolNames();
		for (const name of COORDINATION_TOOLS) {
			expect(configured).toContain(name);
			expect(active).toContain(name);
			expect(session.getToolDefinition(name)?.executionMode).toBe("parallel");
		}
		expect(configured.indexOf("caller_tool")).toBeLessThan(configured.indexOf("spawn_agent"));
		expect(active).toContain("caller_tool");
		await expect(getActiveTool(session, "caller_tool").execute("caller-call", {})).resolves.toMatchObject({
			content: [{ type: "text", text: "caller_tool result" }],
		});
	});

	it("supports disabling and generic tool filtering", async () => {
		const harness = await setupHarness();
		const disabled = await createRoot(harness, { subagents: false });
		const allowlisted = await createRoot(harness, { tools: ["read", "agents"] });
		const excluded = await createRoot(harness, { excludeTools: ["agent_action"] });
		const none = await createRoot(harness, { noTools: "all" });
		const noBuiltins = await createRoot(harness, { noTools: "builtin" });

		for (const name of COORDINATION_TOOLS) {
			expect(disabled.session.getAllTools().map((tool) => tool.name)).not.toContain(name);
		}
		expect(
			allowlisted.session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["agents", "read"]);
		expect(allowlisted.session.getActiveToolNames().sort()).toEqual(["agents", "read"]);
		expect(excluded.session.getAllTools().map((tool) => tool.name)).not.toContain("agent_action");
		expect(excluded.session.getActiveToolNames()).toEqual(expect.arrayContaining(["spawn_agent", "agents"]));
		expect(none.session.getAllTools()).toEqual([]);
		expect(none.session.getActiveToolNames()).toEqual([]);
		expect(noBuiltins.session.getActiveToolNames().sort()).toEqual([...COORDINATION_TOOLS].sort());
	});

	it("rejects invalid options and reserved custom tool names", async () => {
		const harness = await setupHarness();
		const services = await createServices(harness, "validation");
		const baseOptions = {
			cwd: services.cwd,
			agentDir: services.agentDir,
			modelRuntime: services.modelRuntime,
			settingsManager: services.settingsManager,
			resourceLoader: services.resourceLoader,
			sessionManager: SessionManager.inMemory(services.cwd),
			model: harness.getModel("faux-1"),
		};

		for (const subagents of [true, null, [], { maxConcurrent: 0 }, { maxConcurrent: 1.5 }, { unknown: 1 }]) {
			await expect(
				createAgentSession({ ...baseOptions, subagents } as unknown as CreateAgentSessionOptions),
			).rejects.toThrow();
		}
		for (const name of COORDINATION_TOOLS) {
			await expect(
				createAgentSession({ ...baseOptions, subagents: false, customTools: [createTestTool(name)] }),
			).rejects.toThrow(`Custom tool name is reserved for subagent coordination: ${name}`);
		}
	});

	it("binds controller tools to exactly one parent", async () => {
		const harness = await setupHarness();
		const { session } = await createRoot(harness, { subagents: false });
		const controller = new SubagentController({ maxConcurrent: 1 });
		const tools = controller.createToolDefinitions();
		const spawn = tools.find((tool) => tool.name === "spawn_agent");
		if (!spawn) throw new Error("Missing spawn tool");

		await expect(
			spawn.execute("spawn", { name: "worker", task: "task" }, undefined, undefined, {} as never),
		).rejects.toThrow("Subagent controller parent is not bound");
		controller.bindParent(session);
		expect(() => controller.bindParent(session)).toThrow("Subagent controller parent is already bound");
		await controller.shutdown();
	});

	it("spawns through the root tool and retrieves the child result", async () => {
		const harness = await setupHarness();
		const childContexts: Context[] = [];
		const response = (context: Context) => {
			const toolNames = context.tools?.map((tool) => tool.name) ?? [];
			if (!toolNames.includes("spawn_agent")) {
				childContexts.push(context);
				return fauxAssistantMessage("child complete");
			}
			const toolResults = context.messages.filter((message) => message.role === "toolResult");
			if (!toolResults.some((message) => message.toolName === "spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "child task" }), {
					stopReason: "toolUse",
				});
			}
			if (!toolResults.some((message) => message.toolName === "agents")) {
				return fauxAssistantMessage(fauxToolCall("agents", { timeout_ms: 1_000, until: "all" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("root complete");
		};
		harness.setResponses(Array.from({ length: 6 }, () => response));
		const { session } = await createRoot(harness);

		await session.prompt("delegate work");

		expect(session.getLastAssistantText()).toBe("root complete");
		const toolResults = session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.toolName)).toEqual(["spawn_agent", "agents"]);
		expect(getMessageText(toolResults[1])).toContain('"result":"child complete"');
		expect(childContexts).toHaveLength(1);
		for (const name of COORDINATION_TOOLS) {
			expect(childContexts[0]?.tools?.map((tool) => tool.name)).not.toContain(name);
		}
	});

	it("applies configured concurrency and captures parent state when spawning", async () => {
		const harness = await setupHarness();
		const blockerStarted = deferred<void>();
		const blockerGate = deferred<void>();
		let captured:
			| {
					model: Model<string>;
					options: SimpleStreamOptions | undefined;
					toolNames: string[];
			  }
			| undefined;
		const response = async (
			context: Context,
			options: SimpleStreamOptions | undefined,
			_state: unknown,
			model: Model<string>,
		) => {
			const task = getLastUserText(context);
			if (task === "blocker task") {
				blockerStarted.resolve();
				await blockerGate.promise;
				return fauxAssistantMessage("blocker complete");
			}
			captured = { model, options, toolNames: context.tools?.map((tool) => tool.name) ?? [] };
			return fauxAssistantMessage("captured complete");
		};
		harness.setResponses([response, response]);
		const { session } = await createRoot(harness, { subagents: { maxConcurrent: 1 } });
		const spawn = getActiveTool(session, "spawn_agent");
		const agents = getActiveTool(session, "agents");

		await spawn.execute("spawn-blocker", { name: "blocker", task: "blocker task" });
		await blockerStarted.promise;
		await spawn.execute("spawn-captured", { name: "captured", task: "captured task" });
		const queued = await agents.execute("agents-queued", { timeout_ms: 0 });
		expect(queued.details).toMatchObject({
			agents: [
				{ name: "blocker", status: "running" },
				{ name: "captured", status: "queued" },
			],
		});

		await session.setModel(harness.getModel("faux-2")!);
		session.setThinkingLevel("off");
		session.setActiveToolsByName(["bash"]);
		blockerGate.resolve();
		await agents.execute("agents-finished", { timeout_ms: 1_000, until: "all" });

		expect(captured?.model.id).toBe("faux-1");
		expect(captured?.options?.reasoning).toBe("high");
		expect(captured?.toolNames).toEqual(["read", "bash", "edit", "write"]);
	});

	it("creates an independent empty controller after runtime replacement", async () => {
		const harness = await setupHarness();
		harness.setResponses([fauxAssistantMessage("child complete")]);
		const services = await createServices(harness, "runtime");
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel("faux-1"),
				thinkingLevel: "high",
			})),
			services,
			diagnostics: services.diagnostics,
		});
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: services.cwd,
			agentDir: services.agentDir,
			sessionManager: SessionManager.inMemory(services.cwd),
		});
		runtimeCleanups.push(() => runtime.dispose());

		await getActiveTool(runtime.session, "spawn_agent").execute("spawn", {
			name: "worker",
			task: "child task",
		});
		await getActiveTool(runtime.session, "agents").execute("wait", { timeout_ms: 1_000, until: "all" });
		await runtime.newSession();

		await expect(getActiveTool(runtime.session, "agents").execute("list", { timeout_ms: 0 })).resolves.toMatchObject({
			details: { timed_out: false, agents: [] },
		});
	});
});
