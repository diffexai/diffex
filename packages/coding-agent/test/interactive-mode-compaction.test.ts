import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("delivers every queued task through the runtime host in order", async () => {
		const originalSession = {
			clearQueue: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
			steer: vi.fn().mockResolvedValue(undefined),
			followUp: vi.fn().mockResolvedValue(undefined),
		};
		const replacementSession = {
			clearQueue: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
			steer: vi.fn().mockResolvedValue(undefined),
			followUp: vi.fn().mockResolvedValue(undefined),
		};
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "change direction", mode: "steer" as const },
				{ text: "then start a separate retirement portfolio task", mode: "followUp" as const },
			],
			session: originalSession,
			runtimeHost: {
				prompt: vi.fn().mockImplementation(
					async (
						text: string,
						options?: {
							streamingBehavior?: "steer" | "followUp";
							preflightResult?: (success: boolean) => void;
						},
					) => {
						fakeThis.session = replacementSession;
						options?.preflightResult?.(true);
						return {
							routing: "bypassed",
							activeProfileId: text.includes("retirement") ? "finance" : "research",
						};
					},
				),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.runtimeHost.prompt).toHaveBeenCalledWith("change direction", {
			streamingBehavior: "steer",
			preflightResult: expect.any(Function),
		});
		expect(fakeThis.runtimeHost.prompt).toHaveBeenCalledWith("then start a separate retirement portfolio task", {
			streamingBehavior: "followUp",
			preflightResult: expect.any(Function),
		});
		expect(fakeThis.runtimeHost.prompt).toHaveBeenCalledTimes(2);
		expect(fakeThis.runtimeHost.prompt.mock.calls.map(([text]) => text)).toEqual([
			"change direction",
			"then start a separate retirement portfolio task",
		]);
		expect(originalSession.prompt).not.toHaveBeenCalled();
		expect(replacementSession.followUp).not.toHaveBeenCalled();
		expect(replacementSession.steer).not.toHaveBeenCalled();
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("routes retry-queued tasks while executing extension commands directly", async () => {
		const session = {
			clearQueue: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
			steer: vi.fn().mockResolvedValue(undefined),
			followUp: vi.fn().mockResolvedValue(undefined),
		};
		const runtimePrompt = vi.fn(
			async (
				_text: string,
				options?: {
					streamingBehavior?: "steer" | "followUp";
					preflightResult?: (success: boolean) => void;
				},
			) => {
				options?.preflightResult?.(true);
				return { routing: "bypassed", activeProfileId: "finance" };
			},
		);
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "/extension-command", mode: "steer" as const },
				{ text: "Start a separate retirement task", mode: "followUp" as const },
			],
			session,
			runtimeHost: { prompt: runtimePrompt },
			isExtensionCommand: vi.fn((text: string) => text.startsWith("/extension")),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: true });

		expect(session.prompt).toHaveBeenCalledWith("/extension-command");
		expect(runtimePrompt).toHaveBeenCalledWith("Start a separate retirement task", {
			streamingBehavior: "followUp",
			preflightResult: expect.any(Function),
		});
		expect(session.followUp).not.toHaveBeenCalled();
		expect(session.steer).not.toHaveBeenCalled();
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("restores only the failed prompt and undispatched suffix after a later preflight failure", async () => {
		const session = {
			clearQueue: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
		};
		const runtimePrompt = vi.fn(
			async (
				text: string,
				options?: {
					streamingBehavior?: "steer" | "followUp";
					preflightResult?: (success: boolean) => void;
				},
			) => {
				if (text === "second fails") {
					options?.preflightResult?.(false);
					throw new Error("second preflight rejected");
				}
				options?.preflightResult?.(true);
				return { routing: "bypassed", activeProfileId: "general" };
			},
		);
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "first accepted", mode: "steer" as const },
				{ text: "second fails", mode: "followUp" as const },
				{ text: "third undispatched", mode: "steer" as const },
			],
			session,
			runtimeHost: { prompt: runtimePrompt },
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(runtimePrompt.mock.calls.map(([text]) => text)).toEqual(["first accepted", "second fails"]);
		expect(fakeThis.compactionQueuedMessages).toEqual([
			{ text: "second fails", mode: "followUp" },
			{ text: "third undispatched", mode: "steer" },
		]);
		expect(session.clearQueue).not.toHaveBeenCalled();
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("second preflight rejected"));
	});

	test("restores a failed extension command and suffix without replaying a prior accepted prompt", async () => {
		const session = {
			clearQueue: vi.fn(),
			prompt: vi.fn(async (text: string) => {
				if (text === "/broken") throw new Error("extension failed");
			}),
		};
		const runtimePrompt = vi.fn(async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
			options?.preflightResult?.(true);
			return { routing: "bypassed", activeProfileId: "general" };
		});
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "first accepted", mode: "steer" as const },
				{ text: "/broken", mode: "steer" as const },
				{ text: "third undispatched", mode: "followUp" as const },
			],
			session,
			runtimeHost: { prompt: runtimePrompt },
			isExtensionCommand: vi.fn((text: string) => text.startsWith("/")),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(runtimePrompt).toHaveBeenCalledTimes(1);
		expect(session.prompt).toHaveBeenCalledWith("/broken");
		expect(fakeThis.compactionQueuedMessages).toEqual([
			{ text: "/broken", mode: "steer" },
			{ text: "third undispatched", mode: "followUp" },
		]);
		expect(session.clearQueue).not.toHaveBeenCalled();
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("extension failed"));
	});

	test("does not restore a prompt whose response rejects after successful preflight", async () => {
		const session = {
			clearQueue: vi.fn(),
			prompt: vi.fn().mockResolvedValue(undefined),
		};
		const runtimePrompt = vi.fn(async (text: string, options?: { preflightResult?: (success: boolean) => void }) => {
			options?.preflightResult?.(true);
			if (text === "accepted then fails") throw new Error("response failed after acceptance");
			return { routing: "bypassed", activeProfileId: "general" };
		});
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "accepted then fails", mode: "steer" as const },
				{ text: "second accepted", mode: "followUp" as const },
			],
			session,
			runtimeHost: { prompt: runtimePrompt },
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(runtimePrompt.mock.calls.map(([text]) => text)).toEqual(["accepted then fails", "second accepted"]);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(session.clearQueue).not.toHaveBeenCalled();
		expect(fakeThis.showError).toHaveBeenCalledWith(expect.stringContaining("response failed after acceptance"));
	});
});
