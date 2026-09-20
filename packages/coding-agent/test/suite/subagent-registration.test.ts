import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@diffexai/diffex-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@diffexai/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "../../src/core/extensions/types.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import {
	RootLocalEphemeralSubagentSessionManagerFactory,
	type SubagentSessionManagerRequest,
} from "../../src/core/subagents/session-manager-factory.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../extension-test-utils.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { getLastUserText, getSettledAgentStatus, waitForSettledAgents } from "./subagent-harness.ts";

const COORDINATION_TOOLS = ["spawn_agent", "agent_action", "agent_status"];
const INCOMPATIBLE_PARENT_HOOKS = [
	"resources_discover",
	"input",
	"context",
	"before_agent_start",
	"before_provider_request",
	"before_provider_headers",
	"session_before_compact",
	"tool_call",
	"tool_result",
	"message_end",
] as const;
type IncompatibleParentHook = (typeof INCOMPATIBLE_PARENT_HOOKS)[number];
type ObservationParentHook = "agent_start" | "after_provider_response" | "message_start" | "tool_execution_start";

function registerParentHook(api: ExtensionAPI, hook: IncompatibleParentHook | ObservationParentHook): void {
	switch (hook) {
		case "resources_discover":
			api.on("resources_discover", () => {});
			break;
		case "input":
			api.on("input", () => {});
			break;
		case "context":
			api.on("context", () => {});
			break;
		case "before_agent_start":
			api.on("before_agent_start", () => {});
			break;
		case "before_provider_request":
			api.on("before_provider_request", () => {});
			break;
		case "before_provider_headers":
			api.on("before_provider_headers", () => {});
			break;
		case "session_before_compact":
			api.on("session_before_compact", () => {});
			break;
		case "tool_call":
			api.on("tool_call", () => {});
			break;
		case "tool_result":
			api.on("tool_result", () => {});
			break;
		case "message_end":
			api.on("message_end", () => {});
			break;
		case "agent_start":
			api.on("agent_start", () => {});
			break;
		case "after_provider_response":
			api.on("after_provider_response", () => {});
			break;
		case "message_start":
			api.on("message_start", () => {});
			break;
		case "tool_execution_start":
			api.on("tool_execution_start", () => {});
			break;
	}
}

function createParentHookExtension(
	hooks: readonly (IncompatibleParentHook | ObservationParentHook)[],
): InlineExtension {
	return {
		name: "parent-policy-test",
		factory: (api) => {
			for (const hook of hooks) registerParentHook(api, hook);
		},
	};
}

function parentPolicyError(hooks: readonly IncompatibleParentHook[]): string {
	return `Cannot spawn a subagent while parent extensions register incompatible hooks: ${hooks.join(", ")}. Remove those hooks or disable subagents for this session.`;
}

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

function appendAssistantToolCall(sessionManager: SessionManager, toolName: string, toolCallId: string): string {
	return sessionManager.appendMessage(
		fauxAssistantMessage(fauxToolCall(toolName, {}, { id: toolCallId }), { stopReason: "toolUse" }),
	);
}

async function executeActiveSpawn(session: AgentSession, toolCallId: string, name: string): Promise<void> {
	const internalState = session as unknown as { _isAgentRunActive: boolean };
	internalState._isAgentRunActive = true;
	try {
		await getActiveTool(session, "spawn_agent").execute(toolCallId, { name, task: `${name} task` });
	} finally {
		internalState._isAgentRunActive = false;
	}
}

function captureSubagentSessionManagerRequests(): SubagentSessionManagerRequest[] {
	const requests: SubagentSessionManagerRequest[] = [];
	const originalCreate = RootLocalEphemeralSubagentSessionManagerFactory.prototype.create;
	vi.spyOn(RootLocalEphemeralSubagentSessionManagerFactory.prototype, "create").mockImplementation(function (
		this: RootLocalEphemeralSubagentSessionManagerFactory,
		request,
	) {
		requests.push(request);
		return originalCreate.call(this, request);
	});
	return requests;
}

describe("root subagent tool registration", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];
	const runtimeCleanups: Array<() => Promise<void>> = [];
	let rootIndex = 0;

	afterEach(async () => {
		vi.restoreAllMocks();
		while (runtimeCleanups.length > 0) await runtimeCleanups.pop()?.();
		while (sessions.length > 0) await sessions.pop()?.dispose();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
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

	async function createPolicyRoot(
		harness: Harness,
		hooks: readonly (IncompatibleParentHook | ObservationParentHook)[],
		options: { sessionManager?: SessionManager; resourceLoader?: ReturnType<typeof createTestResourceLoader> } = {},
	): Promise<{ session: AgentSession; controller: SubagentController }> {
		const extensionsResult = await createTestExtensionsResult([createParentHookExtension(hooks)], harness.tempDir);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "policy-agent"),
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: options.resourceLoader ?? createTestResourceLoader({ extensionsResult }),
			sessionManager: options.sessionManager ?? SessionManager.inMemory(harness.tempDir),
			model: harness.getModel("faux-1"),
			thinkingLevel: "high",
		});
		sessions.push(session);
		const controller = (session as unknown as { _subagentController: SubagentController })._subagentController;
		return { session, controller };
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
			const definition = session.getToolDefinition(name);
			expect(definition?.executionMode).toBe("parallel");
			expect(definition?.promptSnippet).toBeTruthy();
			expect(session.systemPrompt).toContain(`- ${name}: ${definition?.promptSnippet}`);
			expect(definition?.promptGuidelines?.length).toBeGreaterThan(0);
			for (const guideline of definition?.promptGuidelines ?? []) {
				expect(session.systemPrompt).toContain(guideline);
			}
		}
		expect(configured).not.toContain("agents");
		expect(configured.indexOf("caller_tool")).toBeLessThan(configured.indexOf("spawn_agent"));
		expect(active).toContain("caller_tool");
		await expect(getActiveTool(session, "caller_tool").execute("caller-call", {})).resolves.toMatchObject({
			content: [{ type: "text", text: "caller_tool result" }],
		});
	});

	it("supports disabling and generic tool filtering", async () => {
		const harness = await setupHarness();
		const disabled = await createRoot(harness, { subagents: false });
		const allowlisted = await createRoot(harness, { tools: ["agent_status", "read"] });
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
		).toEqual(["agent_status", "read"]);
		expect(allowlisted.session.getActiveToolNames().sort()).toEqual(["agent_status", "read"]);
		expect(excluded.session.getAllTools().map((tool) => tool.name)).not.toContain("agent_action");
		expect(excluded.session.getActiveToolNames()).toEqual(expect.arrayContaining(["spawn_agent", "agent_status"]));
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
		controller.bindParent(session, () => []);
		expect(() => controller.bindParent(session, () => [])).toThrow("Subagent controller parent is already bound");
		await controller.shutdown();
	});

	it.each(INCOMPATIBLE_PARENT_HOOKS)("rejects spawn when the parent registers %s", async (hook) => {
		const harness = await setupHarness();
		const { session, controller } = await createPolicyRoot(harness, [hook]);

		await expect(
			getActiveTool(session, "spawn_agent").execute("spawn", { name: "worker", task: "task" }),
		).rejects.toThrow(parentPolicyError([hook]));
		expect(controller.snapshot().agents).toEqual([]);
	});

	it("reports incompatible hook combinations once in authoritative order", async () => {
		const harness = await setupHarness();
		const registered = [...INCOMPATIBLE_PARENT_HOOKS].reverse();
		const { session } = await createPolicyRoot(harness, registered);

		await expect(
			getActiveTool(session, "spawn_agent").execute("spawn", { name: "worker", task: "task" }),
		).rejects.toThrow(parentPolicyError(INCOMPATIBLE_PARENT_HOOKS));
	});

	it("rejects before validation, child capture, persistence, reservation, or provider work", async () => {
		const harness = await setupHarness();
		harness.setResponses([fauxAssistantMessage("unexpected child response")]);
		const sessionManager = SessionManager.create(harness.tempDir, join(harness.tempDir, "policy-sessions"));
		const createChildManager = vi.spyOn(RootLocalEphemeralSubagentSessionManagerFactory.prototype, "create");
		const orderedHooks = ["resources_discover", "input", "tool_call", "message_end"] as const;
		const { session, controller } = await createPolicyRoot(
			harness,
			["message_end", "input", "tool_call", "input", "resources_discover"],
			{ sessionManager },
		);
		const entryCount = sessionManager.getEntryCount();
		const pendingResponses = harness.getPendingResponseCount();

		await expect(
			getActiveTool(session, "spawn_agent").execute("spawn", { name: "INVALID", task: "" }),
		).rejects.toThrow(parentPolicyError(orderedHooks));
		expect(controller.snapshot().agents).toEqual([]);
		expect(sessionManager.getEntryCount()).toBe(entryCount);
		expect(createChildManager).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(pendingResponses);

		const createSession = vi.fn();
		expect(() => controller.spawn("direct", "task", createSession)).toThrow(parentPolicyError(orderedHooks));
		expect(createSession).not.toHaveBeenCalled();
		expect(controller.snapshot().agents).toEqual([]);
		expect(sessionManager.getEntryCount()).toBe(entryCount);
	});

	it("keeps observation hooks and non-spawn actions admissible", async () => {
		const harness = await setupHarness();
		harness.setResponses([fauxAssistantMessage("child complete")]);
		const observed = await createPolicyRoot(harness, [
			"agent_start",
			"after_provider_response",
			"message_start",
			"tool_execution_start",
		]);
		await getActiveTool(observed.session, "spawn_agent").execute("spawn", { name: "worker", task: "task" });
		await expect(getSettledAgentStatus(observed.session)).resolves.toMatchObject({
			details: { agents: [{ name: "worker", status: "idle" }] },
		});

		const guarded = await createPolicyRoot(harness, ["context"]);
		guarded.controller.reserve("existing", "existing task");
		guarded.controller.markFailed("existing", "existing failure");
		await expect(
			getActiveTool(guarded.session, "agent_action").execute("interrupt", {
				target: "existing",
				action: "interrupt",
			}),
		).resolves.toMatchObject({ details: { target: "existing", status: "failed" } });
		await expect(getActiveTool(guarded.session, "agent_status").execute("list", {})).resolves.toMatchObject({
			details: { agents: [{ name: "existing", status: "failed" }] },
		});
	});

	it("checks the current extension runner after reload", async () => {
		const harness = await setupHarness();
		const initialExtensions = await createTestExtensionsResult([], harness.tempDir);
		const reloadedExtensions = await createTestExtensionsResult(
			[createParentHookExtension(["before_provider_headers"])],
			harness.tempDir,
		);
		let currentExtensions = initialExtensions;
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getExtensions = () => currentExtensions;
		resourceLoader.reload = async () => {
			currentExtensions = reloadedExtensions;
		};
		const { session } = await createPolicyRoot(harness, [], { resourceLoader });

		await session.reload();
		await expect(
			getActiveTool(session, "spawn_agent").execute("spawn", { name: "worker", task: "task" }),
		).rejects.toThrow(parentPolicyError(["before_provider_headers"]));
	});

	it("preserves unbound programmatic controller spawning", async () => {
		const child = await setupHarness();
		child.setResponses([fauxAssistantMessage("programmatic child complete")]);
		const controller = new SubagentController({ maxConcurrent: 1 });

		controller.spawn("worker", "task", async () => child.session);
		await expect(controller.queryAgents({ timeoutMs: 1_000, until: "all" })).resolves.toMatchObject({
			agents: [{ name: "worker", status: "idle", result: "programmatic child complete" }],
		});
		await controller.shutdown();
	});

	it("shuts down coordination tools when the root session is disposed", async () => {
		const harness = await setupHarness();
		const childStarted = deferred<void>();
		let childSignal: AbortSignal | undefined;
		harness.setResponses([
			async (_context, options) => {
				childSignal = options?.signal;
				childStarted.resolve();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("child stopped");
			},
		]);
		const { session } = await createRoot(harness);
		const spawn = getActiveTool(session, "spawn_agent");
		const agents = session.getToolDefinition("agent_status");
		if (!agents) throw new Error("Missing agent_status tool definition");

		await spawn.execute("spawn", { name: "worker", task: "keep working" });
		await childStarted.promise;
		session.dispose();

		expect(childSignal?.aborted).toBe(true);
		await expect(agents.execute("list", {}, undefined, undefined, {} as never)).rejects.toThrow(
			"Subagent controller is shut down",
		);
	});

	it("spawns through the root tool and retrieves the child result", async () => {
		const harness = await setupHarness();
		const childContexts: Context[] = [];
		const response = async (context: Context) => {
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
			if (!toolResults.some((message) => message.toolName === "agent_status")) {
				await waitForSettledAgents(session);
				return fauxAssistantMessage(fauxToolCall("agent_status", {}), {
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
		expect(toolResults.map((message) => message.toolName)).toEqual(["spawn_agent", "agent_status"]);
		expect(getMessageText(toolResults[1])).toContain('"result":"child complete"');
		expect(childContexts).toHaveLength(1);
		expect(childContexts[0]?.systemPrompt).toContain("- escalate_to_parent: Escalate issues or request an extension");
		expect(childContexts[0]?.systemPrompt).toContain(
			"current progress, remaining work, the goal, and the decision or extension needed",
		);
		expect(childContexts[0]?.systemPrompt).not.toContain("expected duration");
		for (const name of COORDINATION_TOOLS) {
			expect(childContexts[0]?.tools?.map((tool) => tool.name)).not.toContain(name);
		}
	});

	it("captures safe origins for agent and direct spawn calls", async () => {
		const harness = await setupHarness();
		const requests: SubagentSessionManagerRequest[] = [];
		const childManagers: SessionManager[] = [];
		const initialChildMessages: unknown[][] = [];
		const originalCreate = RootLocalEphemeralSubagentSessionManagerFactory.prototype.create;
		vi.spyOn(RootLocalEphemeralSubagentSessionManagerFactory.prototype, "create").mockImplementation(function (
			this: RootLocalEphemeralSubagentSessionManagerFactory,
			request,
		) {
			requests.push(request);
			const manager = originalCreate.call(this, request);
			childManagers.push(manager);
			initialChildMessages.push(manager.buildSessionContext().messages);
			return manager;
		});

		const response = (context: Context) => {
			const toolNames = context.tools?.map((tool) => tool.name) ?? [];
			if (!toolNames.includes("spawn_agent")) {
				return fauxAssistantMessage(`completed ${getLastUserText(context)}`);
			}
			const toolResults = context.messages.filter((message) => message.role === "toolResult");
			if (!toolResults.some((message) => message.toolName === "spawn_agent")) {
				return fauxAssistantMessage(
					[
						fauxToolCall("spawn_agent", { name: "first", task: "first task" }, { id: "spawn-first" }),
						fauxToolCall("spawn_agent", { name: "second", task: "second task" }, { id: "spawn-second" }),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("root complete");
		};
		harness.setResponses(Array.from({ length: 8 }, () => response));
		const { session } = await createRoot(harness);

		await session.prompt("delegate parallel work");

		const assistantEntry = session.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((content) => content.type === "toolCall" && content.id === "spawn-first"),
			);
		if (assistantEntry?.type !== "message") throw new Error("Missing spawning assistant entry");
		const agentRequests = requests.filter((request) => request.origin.type === "agent_tool_call");
		expect(agentRequests.map((request) => request.childName).sort()).toEqual(["first", "second"]);
		expect(agentRequests.map((request) => request.origin)).toEqual(
			expect.arrayContaining([
				{
					type: "agent_tool_call",
					toolCallId: "spawn-first",
					assistantEntryId: assistantEntry.id,
					contextEntryId: assistantEntry.parentId,
				},
				{
					type: "agent_tool_call",
					toolCallId: "spawn-second",
					assistantEntryId: assistantEntry.id,
					contextEntryId: assistantEntry.parentId,
				},
			]),
		);
		expect(assistantEntry.parentId).not.toBeNull();
		const anchorEntry = session.sessionManager.getEntry(assistantEntry.parentId!);
		if (anchorEntry?.type !== "message") throw new Error("Missing spawn context anchor");
		expect(anchorEntry.message.role).toBe("user");
		expect(getMessageText(anchorEntry.message)).toBe("delegate parallel work");

		const spawn = getActiveTool(session, "spawn_agent");
		await spawn.execute("spawn-direct", { name: "direct", task: "direct task" });
		await getSettledAgentStatus(session);

		const directRequest = requests.find((request) => request.childName === "direct");
		expect(directRequest?.origin).toEqual({
			type: "direct_tool_call",
			toolCallId: "spawn-direct",
			contextEntryId: null,
		});
		expect(requests.every((request) => request.sourceSessionManager === session.sessionManager)).toBe(true);
		expect(requests.every((request) => request.cwd === session.sessionManager.getCwd())).toBe(true);
		expect(requests.every((request) => request.parentSessionId === session.sessionId)).toBe(true);
		expect(requests.every((request) => Object.isFrozen(request) && Object.isFrozen(request.origin))).toBe(true);
		expect(new Set(childManagers).size).toBe(3);
		expect(initialChildMessages).toEqual([[], [], []]);
		for (const manager of childManagers) {
			expect(manager.isPersisted()).toBe(false);
			expect(manager.getSessionFile()).toBeUndefined();
			expect(manager.getHeader()?.parentSession).toBe(session.sessionId);
			expect(manager.buildSessionContext().messages.map(getMessageText)).not.toContain("delegate parallel work");
		}
	});

	it("binds reused tool-call identifiers to the newest selected-branch spawn", async () => {
		const harness = await setupHarness();
		harness.setResponses([fauxAssistantMessage("child complete")]);
		const requests = captureSubagentSessionManagerRequests();
		const { session } = await createRoot(harness);
		appendAssistantToolCall(session.sessionManager, "spawn_agent", "reused-call");
		const newestEntryId = appendAssistantToolCall(session.sessionManager, "spawn_agent", "reused-call");

		await executeActiveSpawn(session, "reused-call", "worker");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.origin).toMatchObject({
			type: "agent_tool_call",
			toolCallId: "reused-call",
			assistantEntryId: newestEntryId,
		});
	});

	it("ignores newer calls to other tools that reuse the spawn identifier", async () => {
		const harness = await setupHarness();
		harness.setResponses([fauxAssistantMessage("child complete")]);
		const requests = captureSubagentSessionManagerRequests();
		const { session } = await createRoot(harness);
		const spawnEntryId = appendAssistantToolCall(session.sessionManager, "spawn_agent", "shared-call");
		appendAssistantToolCall(session.sessionManager, "agent_status", "shared-call");

		await executeActiveSpawn(session, "shared-call", "worker");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.origin).toMatchObject({
			type: "agent_tool_call",
			toolCallId: "shared-call",
			assistantEntryId: spawnEntryId,
		});
	});

	it("ignores matching spawn calls on abandoned branches", async () => {
		const harness = await setupHarness();
		harness.setResponses([fauxAssistantMessage("child complete")]);
		const requests = captureSubagentSessionManagerRequests();
		const { session } = await createRoot(harness);
		const branchPointId = session.sessionManager.appendCustomEntry("branch-point");
		appendAssistantToolCall(session.sessionManager, "spawn_agent", "branched-call");
		session.sessionManager.branch(branchPointId);
		const selectedEntryId = appendAssistantToolCall(session.sessionManager, "spawn_agent", "branched-call");

		await executeActiveSpawn(session, "branched-call", "worker");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.origin).toMatchObject({
			type: "agent_tool_call",
			toolCallId: "branched-call",
			assistantEntryId: selectedEntryId,
		});
	});

	it("rejects unmatched spawn calls during an active agent run", async () => {
		const harness = await setupHarness();
		const { session } = await createRoot(harness);
		const branchPointId = session.sessionManager.appendCustomEntry("branch-point");
		appendAssistantToolCall(session.sessionManager, "spawn_agent", "missing-call");
		session.sessionManager.branch(branchPointId);
		appendAssistantToolCall(session.sessionManager, "agent_status", "missing-call");

		await expect(executeActiveSpawn(session, "missing-call", "worker")).rejects.toThrow(
			"Invariant violation: active spawn_agent call missing-call matched 0 persisted assistant entries",
		);
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
		const agents = getActiveTool(session, "agent_status");

		await spawn.execute("spawn-blocker", { name: "blocker", task: "blocker task" });
		await blockerStarted.promise;
		await spawn.execute("spawn-captured", { name: "captured", task: "captured task" });
		const queued = await agents.execute("agents-queued", {});
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
		await getSettledAgentStatus(session);

		expect(captured?.model.id).toBe("faux-1");
		expect(captured?.options?.reasoning).toBe("high");
		expect(captured?.toolNames).toEqual(["read", "bash", "edit", "write", "update_plan", "escalate_to_parent"]);
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
		await getSettledAgentStatus(runtime.session);
		await runtime.newSession();

		await expect(getActiveTool(runtime.session, "agent_status").execute("list", {})).resolves.toMatchObject({
			details: { agents: [] },
		});
	});
});
