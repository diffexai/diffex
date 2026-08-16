import type { AssistantMessage, ImageContent } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, PlanContinuation } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionCommandContextActions } from "../src/core/extensions/types.ts";
import type { PlanArtifact } from "../src/core/plan-mode.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	collaborationMode: "default" | "plan";
	pendingPlan: PlanArtifact | undefined;
	pendingPlanContinuation: PlanContinuation | undefined;
	sessionManager: SessionManager;
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn<(text: string, options?: unknown) => Promise<void>>>;
	waitForIdle: ReturnType<typeof vi.fn<() => Promise<void>>>;
	navigateTree: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	prompt: ReturnType<typeof vi.fn<(text: string, options?: unknown) => Promise<void>>>;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
	commandContextActions?: ExtensionCommandContextActions;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(
	assistantMessage: AssistantMessage,
	activationTarget?: { sessionManager: SessionManager; leafId: string | null },
): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };
	const sessionManager = activationTarget?.sessionManager ?? SessionManager.inMemory();

	const session: FakeSession = {
		collaborationMode: "default",
		pendingPlan: undefined,
		pendingPlanContinuation: undefined,
		sessionManager,
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		reload: vi.fn(async () => {}),
	};

	const runtimeHost: FakeRuntimeHost = {
		session,
		prompt: vi.fn(async (text: string, options?: unknown) => {
			if (options === undefined) {
				await session.prompt(text);
			} else {
				await session.prompt(text, options);
			}
		}),
		newSession: vi.fn(async (options?: Parameters<AgentSessionRuntime["newSession"]>[0]) => {
			if (activationTarget) {
				options?.validateTarget?.(activationTarget.sessionManager, activationTarget.leafId);
			}
			return { cancelled: true };
		}),
		fork: vi.fn(async (_entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]) => {
			if (activationTarget) {
				options?.validateTarget?.(activationTarget.sessionManager, activationTarget.leafId);
			}
			return { cancelled: true, selectedText: "" };
		}),
		switchSession: vi.fn(
			async (_sessionPath: string, options?: Parameters<AgentSessionRuntime["switchSession"]>[1]) => {
				if (activationTarget) {
					options?.validateTarget?.(activationTarget.sessionManager, activationTarget.leafId);
				}
				return { cancelled: true };
			},
		),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
	session.bindExtensions.mockImplementation(
		async (options: { commandContextActions?: ExtensionCommandContextActions }) => {
			runtimeHost.commandContextActions = options.commandContextActions;
		},
	);
	return runtimeHost;
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

function createPendingPlanContinuationTarget(): { sessionManager: SessionManager; leafId: string } {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCollaborationModeChange("plan");
	const plan = { id: "accepted-plan", title: "Accepted plan", markdown: "1. Implement interactively." };
	sessionManager.appendPlan(plan);
	const leafId = sessionManager.appendPlanResolution(plan.id, "implement");
	return { sessionManager, leafId };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it.each(["text", "json"] as const)("rejects an initial plan-mode session in %s mode", async (mode) => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		runtimeHost.session.collaborationMode = "plan";

		await expect(
			runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], { mode }),
		).rejects.toThrow("Plan mode is not supported in print, JSON, or RPC mode");
		expect(runtimeHost.prompt).not.toHaveBeenCalled();
		expect(runtimeHost.dispose).not.toHaveBeenCalled();
	});

	it("rejects an initial lifecycle-invalid session", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		runtimeHost.session.pendingPlan = {
			id: "orphaned-plan",
			title: "Orphaned plan",
			markdown: "1. Do not start noninteractive mode.",
		};

		await expect(
			runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" }),
		).rejects.toThrow("Plan mode is not supported in print, JSON, or RPC mode");
		expect(runtimeHost.dispose).not.toHaveBeenCalled();
	});

	it("rejects an initial session with an accepted plan awaiting continuation", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "unused" }));
		runtimeHost.session.pendingPlanContinuation = Object.freeze({ message: "Implement the accepted plan." });

		await expect(
			runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], { mode: "text" }),
		).rejects.toThrow("Plan mode is not supported in print, JSON, or RPC mode");
		expect(runtimeHost.prompt).not.toHaveBeenCalled();
		expect(runtimeHost.dispose).not.toHaveBeenCalled();
	});

	it.each(["newSession", "switchSession", "fork", "navigateTree"] as const)(
		"rejects a lifecycle-invalid %s extension target before mutation",
		async (action) => {
			const activationTarget = createLifecycleInvalidTarget();
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), activationTarget);

			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
			});
			expect(exitCode).toBe(0);
			const actions = runtimeHost.commandContextActions;
			if (!actions) throw new Error("Expected bound print extension command actions");

			const invocation =
				action === "newSession"
					? actions.newSession()
					: action === "switchSession"
						? actions.switchSession("/target/session.jsonl")
						: action === "fork"
							? actions.fork("source-entry")
							: actions.navigateTree(activationTarget.leafId);
			await expect(invocation).rejects.toThrow(/Plan entry .* is outside plan mode/);
			if (action === "navigateTree") {
				expect(runtimeHost.session.navigateTree).not.toHaveBeenCalled();
			}
		},
	);

	it.each(["newSession", "switchSession", "fork", "navigateTree"] as const)(
		"rejects an accepted-plan continuation %s extension target before mutation",
		async (action) => {
			const activationTarget = createPendingPlanContinuationTarget();
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }), activationTarget);

			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
			});
			expect(exitCode).toBe(0);
			const actions = runtimeHost.commandContextActions;
			if (!actions) throw new Error("Expected bound print extension command actions");

			const invocation =
				action === "newSession"
					? actions.newSession()
					: action === "switchSession"
						? actions.switchSession("/target/session.jsonl")
						: action === "fork"
							? actions.fork("source-entry")
							: actions.navigateTree(activationTarget.leafId);
			await expect(invocation).rejects.toThrow("Plan mode is not supported in print, JSON, or RPC mode");
			if (action === "navigateTree") {
				expect(runtimeHost.session.navigateTree).not.toHaveBeenCalled();
			}
		},
	);

	it.each(["plan mode", "accepted-plan continuation"] as const)(
		"checks %s state before every queued prompt",
		async (state) => {
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			runtimeHost.prompt.mockImplementationOnce(async () => {
				if (state === "plan mode") runtimeHost.session.collaborationMode = "plan";
				else
					runtimeHost.session.pendingPlanContinuation = Object.freeze({ message: "Implement the accepted plan." });
			});

			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				initialMessage: "first",
				messages: ["second"],
			});

			expect(exitCode).toBe(1);
			expect(runtimeHost.prompt).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledWith("Plan mode is not supported in print, JSON, or RPC mode.");
		},
	);

	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("suppresses native plan lifecycle events in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const plan = { id: "plan-1", title: "Hidden plan", markdown: "1. Keep this off the JSON wire." };
		runtimeHost.session.subscribe.mockImplementation((listener: (event: AgentSessionEvent) => void) => {
			listener({ type: "collaboration_mode_changed", mode: "plan" });
			listener({ type: "plan_submitted", plan });
			listener({ type: "plan_resolved", planId: plan.id, resolution: "discard" });
			listener({ type: "agent_start" });
			return () => {};
		});
		const output: string[] = [];
		const outputSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			callbackOrEncoding?: BufferEncoding | (() => void),
			callback?: () => void,
		) => {
			output.push(String(chunk));
			if (typeof callbackOrEncoding === "function") callbackOrEncoding();
			else callback?.();
			return true;
		}) as typeof process.stdout.write);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
		});

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain('"type":"agent_start"');
		expect(output.join("")).not.toContain("collaboration_mode_changed");
		expect(output.join("")).not.toContain("plan_submitted");
		expect(output.join("")).not.toContain("plan_resolved");
		outputSpy.mockRestore();
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
