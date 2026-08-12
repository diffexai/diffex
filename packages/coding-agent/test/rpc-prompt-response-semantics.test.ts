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
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type ProfileSwitchEvent,
	TaskBoundaryCancelledError,
	type TaskBoundaryProposal,
	type TaskBoundaryResolver,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
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

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
}

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function taskBoundaryProposal(): TaskBoundaryProposal {
	return {
		decision: "reuse",
		fromProfileId: "coding",
		fromHarnessId: "parser-repair-a1b2c3",
		toProfileId: "research",
		targetHarnessId: "evidence-review-d4e5f6",
		targetHarnessRevision: "abcdef1234567890",
		targetHarnessName: "Evidence review",
		willResumeSession: true,
		confidence: 0.97,
	};
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	emitProfileSwitch?: boolean;
	taskBoundaryProposal?: TaskBoundaryProposal;
	newSessionCancelled?: boolean;
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
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
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

	let profileSwitchListener: ((event: ProfileSwitchEvent) => void) | undefined;
	let taskBoundaryResolver: TaskBoundaryResolver | undefined;
	const runtimePrompt = vi.fn(async (text: string, promptOptions?: Parameters<AgentSession["prompt"]>[1]) => {
		if (options.taskBoundaryProposal && !promptOptions?.streamingBehavior) {
			const resolution = (await taskBoundaryResolver?.(options.taskBoundaryProposal)) ?? "stay";
			if (resolution === "cancel") {
				promptOptions?.preflightResult?.(false);
				throw new TaskBoundaryCancelledError();
			}
		}
		await session.prompt(text, promptOptions);
		if (options.emitProfileSwitch) {
			profileSwitchListener?.({
				fromProfileId: "general",
				toProfileId: "research",
				reason: "private router reason",
				harnessId: "evidence-review-a1b2c3",
				harnessRevision: "abcdef1234567890",
				harnessName: "Evidence review",
				reused: true,
				notice: 'Found evolved harness "Evidence review" for this task. Switched to revision abcdef123456.',
			});
		}
		return {
			routing: promptOptions?.streamingBehavior ? ("selected" as const) : ("bypassed" as const),
			activeProfileId: promptOptions?.streamingBehavior ? "routed-profile" : "general",
		};
	});
	const runtimeHost = {
		session,
		activeProfile: { id: options.taskBoundaryProposal?.fromProfileId ?? "general" },
		activeHarness: options.taskBoundaryProposal ? { id: options.taskBoundaryProposal.fromHarnessId } : undefined,
		prompt: runtimePrompt,
		newSession: vi.fn(async () => ({ cancelled: options.newSessionCancelled ?? true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		setProfileSwitchListener: vi.fn((listener?: (event: ProfileSwitchEvent) => void) => {
			profileSwitchListener = listener;
		}),
		setTaskBoundaryResolver: vi.fn((resolver?: TaskBoundaryResolver) => {
			taskBoundaryResolver = resolver;
		}),
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
	emitProfileSwitch?: boolean;
	taskBoundaryProposal?: TaskBoundaryProposal;
	newSessionCancelled?: boolean;
}): Promise<{
	lineHandler: (line: string) => void;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const listenerSnapshot = takeListenerSnapshot();
	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	await vi.waitFor(() => {
		const previousSignalListeners = listenerSnapshot.signals.get("SIGTERM")?.length ?? 0;
		expect(process.listenerCount("SIGTERM")).toBeGreaterThan(previousSignalListeners);
	});

	return {
		lineHandler: rpcIo.lineHandler!,
		runtimeHost,
		cleanup: async () => {
			try {
				await cleanup();
			} finally {
				restoreListeners(listenerSnapshot);
			}
		},
	};
}

describe("RPC prompt response semantics", () => {
	afterEach(async () => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
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

	it("emits one typed reason-free profile switch event", async () => {
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			emitProfileSwitch: true,
		});

		try {
			lineHandler(JSON.stringify({ id: "profile-switch", type: "prompt", message: "Review evidence" }));

			await vi.waitFor(() => {
				const event = parseOutputLines(rpcIo.outputLines).find((record) => record.type === "profile_switch");
				expect(event).toMatchObject({
					type: "profile_switch",
					fromProfileId: "general",
					toProfileId: "research",
					harnessId: "evidence-review-a1b2c3",
					harnessRevision: "abcdef1234567890",
					harnessName: "Evidence review",
					reused: true,
					notice: 'Found evolved harness "Evidence review" for this task. Switched to revision abcdef123456.',
				});
				expect(event).not.toHaveProperty("reason");
			});
			expect(runtimeHost.setProfileSwitchListener).toHaveBeenCalledTimes(1);
		} finally {
			await cleanup();
		}
	});

	it("requests and single-settles a content-free task boundary before prompt preflight", async () => {
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			taskBoundaryProposal: taskBoundaryProposal(),
		});

		try {
			lineHandler(JSON.stringify({ id: "future-prompt", type: "prompt", message: "Review the evidence" }));

			let requestId = "";
			await vi.waitFor(() => {
				const event = parseOutputLines(rpcIo.outputLines).find((record) => record.type === "task_boundary_request");
				expect(event).toEqual({
					type: "task_boundary_request",
					requestId: expect.any(String),
					decision: "reuse",
					fromProfileId: "coding",
					fromHarnessId: "parser-repair-a1b2c3",
					toProfileId: "research",
					targetHarnessId: "evidence-review-d4e5f6",
					targetHarnessRevision: "abcdef1234567890",
					targetHarnessName: "Evidence review",
					willResumeSession: true,
					confidence: 0.97,
				});
				requestId = event?.requestId as string;
				expect(JSON.stringify(event)).not.toContain("reason");
				expect(JSON.stringify(event)).not.toContain("description");
				expect(getPromptResponses(rpcIo.outputLines, "future-prompt")).toHaveLength(0);
			});
			lineHandler(
				JSON.stringify({
					id: "invalid-boundary",
					type: "resolve_task_boundary",
					requestId,
					resolution: "later",
				}),
			);
			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "invalid-boundary", "resolve_task_boundary")).toEqual([
					expect.objectContaining({ success: false, error: "Invalid task-boundary resolution" }),
				]);
				expect(getPromptResponses(rpcIo.outputLines, "future-prompt")).toHaveLength(0);
			});

			lineHandler(
				JSON.stringify({
					id: "resolve-boundary",
					type: "resolve_task_boundary",
					requestId,
					resolution: "switch",
				}),
			);

			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "resolve-boundary", "resolve_task_boundary")).toEqual([
					expect.objectContaining({ success: true }),
				]);
				expect(getPromptResponses(rpcIo.outputLines, "future-prompt")).toEqual([
					expect.objectContaining({ success: true }),
				]);
			});

			lineHandler(
				JSON.stringify({
					id: "duplicate-boundary",
					type: "resolve_task_boundary",
					requestId,
					resolution: "stay",
				}),
			);
			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "duplicate-boundary", "resolve_task_boundary")).toEqual([
					expect.objectContaining({ success: false, error: "Task-boundary request is not pending" }),
				]);
			});
			expect(runtimeHost.setTaskBoundaryResolver).toHaveBeenCalledTimes(1);
		} finally {
			await cleanup();
		}
	});

	it("cancels a pending task boundary on session rebind and rejects stale resolution", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			taskBoundaryProposal: taskBoundaryProposal(),
			newSessionCancelled: false,
		});

		try {
			lineHandler(JSON.stringify({ id: "cancelled-prompt", type: "prompt", message: "Review evidence" }));
			let requestId = "";
			await vi.waitFor(() => {
				const event = parseOutputLines(rpcIo.outputLines).find((record) => record.type === "task_boundary_request");
				requestId = event?.requestId as string;
				expect(requestId).not.toBe("");
			});

			lineHandler(JSON.stringify({ id: "new-session", type: "new_session" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "cancelled-prompt")).toEqual([
					expect.objectContaining({ success: false, error: "Task boundary switch cancelled" }),
				]);
			});

			lineHandler(
				JSON.stringify({
					id: "stale-boundary",
					type: "resolve_task_boundary",
					requestId,
					resolution: "switch",
				}),
			);
			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "stale-boundary", "resolve_task_boundary")).toEqual([
					expect.objectContaining({ success: false, error: "Task-boundary request is not pending" }),
				]);
			});
		} finally {
			await cleanup();
		}
	});

	it.each([
		["steer", "steer"],
		["follow_up", "followUp"],
	] as const)("does not request task-boundary routing for an idle %s command", async (command, behavior) => {
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			taskBoundaryProposal: taskBoundaryProposal(),
		});

		try {
			lineHandler(JSON.stringify({ id: `idle-${command}`, type: command, message: "Start another task" }));
			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, `idle-${command}`, command)).toEqual([
					expect.objectContaining({ success: true }),
				]);
			});
			expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "task_boundary_request")).toBe(
				false,
			);
			expect(runtimeHost.prompt).toHaveBeenCalledWith("Start another task", {
				images: undefined,
				streamingBehavior: behavior,
				source: "rpc",
				preflightResult: expect.any(Function),
			});
		} finally {
			await cleanup();
		}
	});

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

	it.each([
		["steer", "steer"],
		["follow_up", "followUp"],
	] as const)("routes a distinct %s command during streaming and delivers it once", async (command, behavior) => {
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: `${command}-start`, type: "prompt", message: "Start coding" }));
			await vi.waitFor(() => expect(runtimeHost.session.isStreaming).toBe(true));
			vi.mocked(runtimeHost.prompt).mockClear();
			rpcIo.outputLines = [];

			const message = `Start a separate ${command} finance task`;
			lineHandler(JSON.stringify({ id: `${command}-1`, type: command, message }));

			await vi.waitFor(() => {
				const responses = getCommandResponses(rpcIo.outputLines, `${command}-1`, command);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: `${command}-1`,
					type: "response",
					command,
					success: true,
				});
			});
			expect(runtimeHost.prompt).toHaveBeenCalledTimes(1);
			expect(runtimeHost.prompt).toHaveBeenCalledWith(message, {
				images: undefined,
				streamingBehavior: behavior,
				source: "rpc",
				preflightResult: expect.any(Function),
			});
			const delivered = [
				...runtimeHost.session.getSteeringMessages(),
				...runtimeHost.session.getFollowUpMessages(),
			].filter((queued) => queued === message);
			expect(delivered).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});
