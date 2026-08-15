import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/diffex-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/diffex-ai/compat";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionCommandContextActions } from "../src/core/extensions/types.ts";
import { SUBMIT_PLAN_TOOL_NAME } from "../src/core/plan-mode.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcEvent } from "../src/modes/rpc/rpc-types.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function getCommandResponses(outputLines: string[], id: string, command: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === command,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPlanModeTarget(): { sessionManager: SessionManager; leafId: string } {
	const sessionManager = SessionManager.inMemory();
	const leafId = sessionManager.appendCollaborationModeChange("plan");
	return { sessionManager, leafId };
}

function createPendingPlanContinuationTarget(): { sessionManager: SessionManager; leafId: string } {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCollaborationModeChange("plan");
	const plan = { id: "accepted-plan", title: "Accepted plan", markdown: "1. Implement interactively." };
	sessionManager.appendPlan(plan);
	const leafId = sessionManager.appendPlanResolution(plan.id, "implement");
	return { sessionManager, leafId };
}

function createLifecycleInvalidTarget(): { sessionManager: SessionManager; leafId: string } {
	const sessionManager = SessionManager.inMemory();
	const modeEntryId = sessionManager.appendCollaborationModeChange("plan");
	const plan = { id: "invalid-plan", title: "Invalid target", markdown: "1. Remain noninteractive." };
	const leafId = sessionManager.appendPlan(plan);
	const modeEntry = sessionManager.getEntry(modeEntryId);
	if (modeEntry?.type !== "collaboration_mode_change") throw new Error("Expected collaboration mode entry");
	modeEntry.mode = "default";
	return { sessionManager, leafId };
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	activationTarget?: { sessionManager: SessionManager; leafId: string | null };
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, streamOptions) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				const responseTimer = setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
				streamOptions?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(responseTimer);
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...createAssistantMessage("aborted"), stopReason: "aborted" },
						});
					},
					{ once: true },
				);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	const runtimePrompt = vi.fn(async (text: string, promptOptions?: Parameters<AgentSession["prompt"]>[1]) =>
		session.prompt(text, promptOptions),
	);
	const runtimeHost = {
		session,
		prompt: runtimePrompt,
		newSession: vi.fn(async (newSessionOptions?: Parameters<AgentSessionRuntime["newSession"]>[0]) => {
			if (options.activationTarget) {
				newSessionOptions?.validateTarget?.(
					options.activationTarget.sessionManager,
					options.activationTarget.leafId,
				);
			}
			return { cancelled: true };
		}),
		switchSession: vi.fn(
			async (_sessionPath: string, switchOptions?: Parameters<AgentSessionRuntime["switchSession"]>[1]) => {
				if (options.activationTarget) {
					switchOptions?.validateTarget?.(
						options.activationTarget.sessionManager,
						options.activationTarget.leafId,
					);
				}
				return { cancelled: true };
			},
		),
		fork: vi.fn(async (_entryId: string, forkOptions?: Parameters<AgentSessionRuntime["fork"]>[1]) => {
			if (options.activationTarget) {
				forkOptions?.validateTarget?.(options.activationTarget.sessionManager, options.activationTarget.leafId);
			}
			return { cancelled: true, selectedText: "" };
		}),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			await session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	activationTarget?: { sessionManager: SessionManager; leafId: string | null };
}): Promise<{
	lineHandler: (line: string) => void;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runtimeHost, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(async () => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("rejects an initial plan-mode session before taking over RPC I/O", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
		runtimeHost.session.setCollaborationMode("plan");

		try {
			await expect(runRpcMode(runtimeHost)).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);
			expect(rpcIo.lineHandler).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	it("rejects an initial accepted plan continuation before taking over RPC I/O", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost({ withAuth: true, responseDelayMs: 0 });
		const session = runtimeHost.session;
		session.setCollaborationMode("plan");
		const submitPlan = session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
		if (!submitPlan) throw new Error("Expected submit_plan in plan mode");
		await submitPlan.execute("rpc-accepted-plan", {
			title: "Accepted plan",
			markdown: "1. Continue only through the interactive host.",
		});
		const plan = session.pendingPlan;
		if (!plan) throw new Error("Expected a pending plan");
		session.resolvePlan(plan.id, "implement");

		try {
			await expect(runRpcMode(runtimeHost)).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);
			expect(rpcIo.lineHandler).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("keeps native plan lifecycle events off the RPC wire", async () => {
		type PlanLifecycleRpcEvent = Extract<
			RpcEvent,
			{ type: "collaboration_mode_changed" | "plan_submitted" | "plan_resolved" }
		>;
		expectTypeOf<PlanLifecycleRpcEvent>().toEqualTypeOf<never>();

		const { runtimeHost, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			rpcIo.outputLines = [];
			const session = runtimeHost.session;
			session.setCollaborationMode("plan");
			const submitPlan = session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
			if (!submitPlan) throw new Error("Expected submit_plan in plan mode");
			await submitPlan.execute("rpc-plan", {
				title: "RPC-hidden plan",
				markdown: "1. Keep plan lifecycle state inside the interactive and SDK surfaces.",
			});
			const plan = session.pendingPlan;
			if (!plan) throw new Error("Expected a pending plan");
			session.resolvePlan(plan.id, "discard");

			const outputTypes = parseOutputLines(rpcIo.outputLines).map((record) => record.type);
			expect(outputTypes).not.toContain("collaboration_mode_changed");
			expect(outputTypes).not.toContain("plan_submitted");
			expect(outputTypes).not.toContain("plan_resolved");
		} finally {
			await cleanup();
		}
	});

	it.each([
		["plan-mode", createPlanModeTarget],
		["accepted-plan continuation", createPendingPlanContinuationTarget],
	] as const)("rejects %s targets for direct session replacement commands", async (_label, createTarget) => {
		const activationTarget = createTarget();
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			activationTarget,
		});

		try {
			runtimeHost.session.sessionManager.appendCollaborationModeChange("default");
			for (const [id, command] of [
				["new-plan", { type: "new_session" }],
				["switch-plan", { type: "switch_session", sessionPath: "/target/session.jsonl" }],
				["fork-plan", { type: "fork", entryId: "source-entry" }],
				["clone-plan", { type: "clone" }],
			] as const) {
				lineHandler(JSON.stringify({ id, ...command }));
				await vi.waitFor(() => {
					expect(getCommandResponses(rpcIo.outputLines, id, command.type)).toEqual([
						expect.objectContaining({
							success: false,
							error: "Plan mode is not supported in print, JSON, or RPC mode.",
						}),
					]);
				});
			}
			expect(runtimeHost.newSession).toHaveBeenCalledTimes(1);
			expect(runtimeHost.switchSession).toHaveBeenCalledTimes(1);
			expect(runtimeHost.fork).toHaveBeenCalledTimes(2);
		} finally {
			await cleanup();
		}
	});

	it("rejects accepted-plan continuation targets for extension session actions before mutation", async () => {
		const activationTarget = createPendingPlanContinuationTarget();
		const { runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			activationTarget,
		});

		try {
			const actions = (
				runtimeHost.session as unknown as {
					_extensionCommandContextActions?: ExtensionCommandContextActions;
				}
			)._extensionCommandContextActions;
			if (!actions) throw new Error("Expected bound RPC extension command actions");

			await expect(actions.newSession()).rejects.toThrow("Plan mode is not supported in print, JSON, or RPC mode");
			await expect(actions.switchSession("/target/session.jsonl")).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);
			await expect(actions.fork("source-entry")).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);

			const sessionManager = runtimeHost.session.sessionManager;
			const defaultLeafId = sessionManager.appendCollaborationModeChange("default");
			sessionManager.appendCollaborationModeChange("plan");
			const plan = { id: "tree-plan", title: "Tree plan", markdown: "1. Stay interactive." };
			sessionManager.appendPlan(plan);
			const continuationLeafId = sessionManager.appendPlanResolution(plan.id, "implement");
			sessionManager.branch(defaultLeafId);
			const navigateTree = vi.spyOn(runtimeHost.session, "navigateTree");
			await expect(actions.navigateTree(continuationLeafId)).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);
			expect(navigateTree).not.toHaveBeenCalled();
			expect(sessionManager.getLeafId()).toBe(defaultLeafId);
		} finally {
			await cleanup();
		}
	});

	it("rejects plan-mode targets for extension session actions before current-tree mutation", async () => {
		const activationTarget = createPlanModeTarget();
		const { runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			activationTarget,
		});

		try {
			const actions = (
				runtimeHost.session as unknown as {
					_extensionCommandContextActions?: ExtensionCommandContextActions;
				}
			)._extensionCommandContextActions;
			if (!actions) throw new Error("Expected bound RPC extension command actions");

			await expect(actions.newSession()).rejects.toThrow("Plan mode is not supported in print, JSON, or RPC mode");
			await expect(actions.switchSession("/target/session.jsonl")).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);
			await expect(actions.fork("source-entry")).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);

			const sessionManager = runtimeHost.session.sessionManager;
			const planLeafId = sessionManager.appendCollaborationModeChange("plan");
			const defaultLeafId = sessionManager.appendCollaborationModeChange("default");
			const navigateTree = vi.spyOn(runtimeHost.session, "navigateTree");
			await expect(actions.navigateTree(planLeafId)).rejects.toThrow(
				"Plan mode is not supported in print, JSON, or RPC mode",
			);
			expect(navigateTree).not.toHaveBeenCalled();
			expect(sessionManager.getLeafId()).toBe(defaultLeafId);
		} finally {
			await cleanup();
		}
	});

	it("rejects a lifecycle-invalid target before RPC adoption", async () => {
		const activationTarget = createLifecycleInvalidTarget();
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			activationTarget,
		});

		try {
			lineHandler(JSON.stringify({ id: "invalid-new", type: "new_session" }));
			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "invalid-new", "new_session")).toEqual([
					expect.objectContaining({
						success: false,
						error: expect.stringMatching(/Plan entry .* is outside plan mode/),
					}),
				]);
			});
			expect(runtimeHost.session.collaborationMode).toBe("default");
		} finally {
			await cleanup();
		}
	});

	it.each(["plan mode", "accepted-plan continuation"] as const)(
		"rejects a prompt if the RPC session enters %s after startup",
		async (state) => {
			const { lineHandler, runtimeHost, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

			try {
				const session = runtimeHost.session;
				session.setCollaborationMode("plan");
				if (state === "accepted-plan continuation") {
					const submitPlan = session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
					if (!submitPlan) throw new Error("Expected submit_plan in plan mode");
					await submitPlan.execute("rpc-late-plan", {
						title: "Late accepted plan",
						markdown: "1. Do not start through RPC.",
					});
					const plan = session.pendingPlan;
					if (!plan) throw new Error("Expected a pending plan");
					session.resolvePlan(plan.id, "implement");
				}
				lineHandler(JSON.stringify({ id: "late-plan", type: "prompt", message: "Do not run" }));

				await vi.waitFor(() => {
					expect(getPromptResponses(rpcIo.outputLines, "late-plan")).toEqual([
						expect.objectContaining({
							success: false,
							error: "Plan mode is not supported in print, JSON, or RPC mode.",
						}),
					]);
				});
				expect(runtimeHost.prompt).not.toHaveBeenCalled();
			} finally {
				await cleanup();
			}
		},
	);

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});
