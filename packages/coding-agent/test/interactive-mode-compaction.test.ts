import { stripVTControlCharacters } from "node:util";
import { Container, Text } from "@diffexai/diffex-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));

	test.each([
		{ reason: "threshold", aborted: false, result: undefined, errorMessage: "Preparation failed; continuing" },
		{ reason: "threshold", aborted: true, result: undefined, errorMessage: "Compaction cancelled; continuing" },
		{
			reason: "threshold",
			aborted: false,
			result: { summary: "retained summary", firstKeptEntryId: "kept", tokensBefore: 1000 },
			errorMessage: "Context remains above the reserve threshold; continuing",
		},
		{ reason: "manual", aborted: true, result: undefined, errorMessage: "Specific cancellation reason" },
		{ reason: "manual", aborted: true, result: undefined, errorMessage: undefined },
		{ reason: "threshold", aborted: true, result: undefined, errorMessage: undefined },
	] satisfies Array<Omit<Extract<AgentSessionEvent, { type: "compaction_end" }>, "type" | "willRetry">>)(
		"shows $reason completion with aborted=$aborted and warning=$errorMessage",
		async (completion) => {
			const originalEscape = vi.fn();
			const chatContainer = new Container();
			const fakeThis = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				autoCompactionEscapeHandler: originalEscape as (() => void) | undefined,
				defaultEditor: { onEscape: vi.fn() },
				chatContainer,
				rebuildChatFromMessages: vi.fn(() => chatContainer.addChild(new Text("rebuilt history", 0, 0))),
				addMessageToChat: vi.fn(() => chatContainer.addChild(new Text("retained summary", 0, 0))),
				showError: vi.fn(),
				showStatus: vi.fn(),
				clearStatusIndicator: vi.fn(),
				restoreWorkingStatusAfterPhase: vi.fn(),
				flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
				settingsManager: { getShowTerminalProgress: () => true },
				ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			};
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof fakeThis,
				event: AgentSessionEvent,
			) => Promise<void>;
			await handleEvent.call(fakeThis, { type: "compaction_end", willRetry: false, ...completion });

			const transcript = stripVTControlCharacters(chatContainer.render(120).join("\n"));
			if (completion.errorMessage) {
				if (completion.reason === "manual") {
					expect(fakeThis.showError).toHaveBeenCalledExactlyOnceWith(completion.errorMessage);
				} else {
					expect(transcript).toContain(completion.errorMessage);
					expect(fakeThis.showError).not.toHaveBeenCalled();
				}
				expect(fakeThis.showStatus).not.toHaveBeenCalled();
			} else if (completion.reason === "manual") {
				expect(fakeThis.showError).toHaveBeenCalledExactlyOnceWith("Compaction cancelled");
			} else {
				expect(fakeThis.showStatus).toHaveBeenCalledExactlyOnceWith("Auto-compaction cancelled");
			}
			if (completion.result) {
				expect(transcript.indexOf("retained summary")).toBeGreaterThan(transcript.indexOf("rebuilt history"));
				expect(transcript.indexOf(completion.errorMessage!)).toBeGreaterThan(
					transcript.indexOf("retained summary"),
				);
				expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
					expect.objectContaining({
						summary: completion.result.summary,
						tokensBefore: completion.result.tokensBefore,
					}),
				);
			} else {
				expect(fakeThis.rebuildChatFromMessages).not.toHaveBeenCalled();
			}
			expect(fakeThis.defaultEditor.onEscape).toBe(originalEscape);
			expect(fakeThis.autoCompactionEscapeHandler).toBeUndefined();
			expect(fakeThis.clearStatusIndicator).toHaveBeenCalledWith("compaction");
			expect(fakeThis.restoreWorkingStatusAfterPhase).toHaveBeenCalledOnce();
			expect(fakeThis.flushCompactionQueue).toHaveBeenCalledExactlyOnceWith({ willRetry: false });
			expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(false);
			expect(fakeThis.ui.requestRender).toHaveBeenCalled();
		},
	);

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
			restoreWorkingStatusAfterPhase: vi.fn(),
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

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
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

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
