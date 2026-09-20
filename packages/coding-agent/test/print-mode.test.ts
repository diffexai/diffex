import { Console } from "node:console";
import type { AssistantMessage, ImageContent } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
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

function createRuntimeHost(assistantMessage: AssistantMessage, events: AgentSessionEvent[] = []): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };
	let listener: AgentSessionEventListener | undefined;

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn((callback: AgentSessionEventListener) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		}),
		prompt: vi.fn(async () => {
			for (const event of events) listener?.(event);
		}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it.each(["text", "json"] as const)(
		"delivers compaction warnings in %s mode without failing the answer",
		async (mode) => {
			const events: AgentSessionEvent[] = [
				{
					type: "compaction_end",
					reason: "threshold",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: "Preparation failed before summarization; continuing",
				},
				{
					type: "compaction_end",
					reason: "threshold",
					result: undefined,
					aborted: true,
					willRetry: false,
					errorMessage: "Compaction cancelled; continuing",
				},
				{
					type: "compaction_end",
					reason: "threshold",
					result: { summary: "retained", firstKeptEntryId: "kept", tokensBefore: 1000 },
					aborted: false,
					willRetry: false,
					errorMessage: "Context remains above the reserve threshold; continuing",
				},
			];
			const stdout: string[] = [];
			const stderr: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation(
				(chunk, encodingOrCallback: BufferEncoding | ((error?: Error | null) => void) | undefined, callback) => {
					stdout.push(String(chunk));
					if (typeof encodingOrCallback === "function") encodingOrCallback();
					else callback?.();
					return true;
				},
			);
			vi.spyOn(process.stderr, "write").mockImplementation(
				(chunk, encodingOrCallback: BufferEncoding | ((error?: Error | null) => void) | undefined, callback) => {
					stderr.push(String(chunk));
					if (typeof encodingOrCallback === "function") encodingOrCallback();
					else callback?.();
					return true;
				},
			);
			const outputConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
			vi.spyOn(console, "error").mockImplementation(outputConsole.error.bind(outputConsole));
			const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "answer only" }), events);
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode,
				initialMessage: "continue",
			});
			expect(exitCode).toBe(0);
			expect(runtimeHost.dispose).toHaveBeenCalledExactlyOnceWith("completed");
			if (mode === "text") {
				expect(stdout.join("")).toBe("answer only\n");
				expect(stderr.join("")).toBe(
					events.map((event) => ("errorMessage" in event ? `${event.errorMessage}\n` : "")).join(""),
				);
			} else {
				expect(
					stdout
						.join("")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				).toEqual(JSON.parse(JSON.stringify(events)));
				expect(stderr.join("")).toBe("");
			}
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
