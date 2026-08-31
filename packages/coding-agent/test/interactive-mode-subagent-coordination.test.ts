import { Container, Markdown, type TUI } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class ProgressTerminal extends VirtualTerminal {
	progressActive = false;

	override setProgress(active: boolean): void {
		this.progressActive = active;
	}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

describe("InteractiveMode subagent coordination", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders deterministic notices as assistant content while showing a wait indicator", async () => {
		const terminal = new ProgressTerminal(80, 12);
		const ui = new TuiMainScreen(terminal);
		ui.setClearOnShrink(false);
		const chatContainer = new Container();
		const statusContainer = new Container();
		const settingsManager = {
			getShowTerminalProgress: () => true,
			getCodeBlockIndent: () => 0,
		};
		ui.addChild(chatContainer);
		ui.addChild(statusContainer);
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: { settingsManager } },
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui,
			chatContainer,
			statusContainer,
			activeStatusIndicator: undefined,
			outputPad: 1,
			options: { tuiMode: "regular" },
		});
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof context,
			event: unknown,
		) => Promise<void>;

		ui.start();
		try {
			await handleEvent.call(context, { type: "subagent_wait_start", names: ["alpha", "beta"] });
			await flushTui(ui, terminal);
			expect(terminal.getViewport().join("\n")).toContain("Waiting for 2 subagents");
			expect(terminal.progressActive).toBe(true);

			await handleEvent.call(context, {
				type: "subagent_notice",
				name: "beta",
				status: "idle",
				attempt: "initial",
				retryAvailable: false,
				text: "beta has finished execution.",
			});
			await flushTui(ui, terminal);
			expect(terminal.getViewport().join("\n")).toContain("beta has finished execution.");
			expect(chatContainer.children.at(-1)).toBeInstanceOf(Markdown);

			await handleEvent.call(context, {
				type: "subagent_wait_end",
				names: ["alpha", "beta"],
				cancelled: false,
			});
			await flushTui(ui, terminal);
			expect(statusContainer.children).toEqual([]);
			expect(terminal.progressActive).toBe(false);
		} finally {
			ui.stop();
		}
	});

	it("restores queued input and cancels the session on Escape", () => {
		const abort = vi.fn().mockResolvedValue(undefined);
		const editor = {
			getText: vi.fn(() => "draft"),
			setText: vi.fn(),
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				session: {
					clearQueue: vi.fn(() => ({ steering: ["steer"], followUp: ["follow up"] })),
					abort,
				},
			},
			compactionQueuedMessages: [],
			editor,
			updatePendingMessagesDisplay: vi.fn(),
		});
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof context,
			options: { abort: boolean },
		) => number;

		expect(restoreQueuedMessagesToEditor.call(context, { abort: true })).toBe(2);
		expect(editor.setText).toHaveBeenCalledWith("steer\n\nfollow up\n\ndraft");
		expect(abort).toHaveBeenCalledOnce();
	});

	it.each([
		{
			terminalProgressEnabled: true,
			workingVisible: true,
			expectedProgressCalls: [[false], [true]],
			expectedWorkingIndicator: true,
		},
		{
			terminalProgressEnabled: false,
			workingVisible: true,
			expectedProgressCalls: [],
			expectedWorkingIndicator: true,
		},
		{
			terminalProgressEnabled: true,
			workingVisible: false,
			expectedProgressCalls: [[false], [true]],
			expectedWorkingIndicator: false,
		},
	])(
		"restores nested wait state with terminal progress $terminalProgressEnabled and visibility $workingVisible",
		async ({ terminalProgressEnabled, workingVisible, expectedProgressCalls, expectedWorkingIndicator }) => {
			const setProgress = vi.fn();
			const showStatusIndicator = vi.fn();
			const context = Object.assign(Object.create(InteractiveMode.prototype), {
				runtimeHost: {
					session: {
						isStreaming: true,
						settingsManager: { getShowTerminalProgress: () => terminalProgressEnabled },
					},
				},
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				workingVisible,
				workingMessage: "Responding",
				workingIndicatorOptions: undefined,
				activeStatusIndicator: { kind: "subagentWait", dispose: vi.fn() },
				statusContainer: { clear: vi.fn(), addChild: vi.fn() },
				showStatusIndicator,
				options: { tuiMode: "regular" },
				ui: {
					terminal: { setProgress },
					getClearOnShrink: () => false,
					requestRender: vi.fn(),
				},
			});
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof context,
				event: unknown,
			) => Promise<void>;

			await handleEvent.call(context, {
				type: "subagent_wait_end",
				names: ["alpha"],
				cancelled: false,
			});

			expect(setProgress.mock.calls).toEqual(expectedProgressCalls);
			expect(showStatusIndicator).toHaveBeenCalledTimes(expectedWorkingIndicator ? 1 : 0);
			if (expectedWorkingIndicator) {
				expect(showStatusIndicator.mock.calls[0]?.[0]).toMatchObject({ kind: "working" });
			}
			(showStatusIndicator.mock.calls[0]?.[0] as { dispose(): void } | undefined)?.dispose();
		},
	);
});
