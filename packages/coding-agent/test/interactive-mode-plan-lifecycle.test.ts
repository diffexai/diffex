import { beforeAll, describe, expect, test, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	type AgentSettledEventContext,
	handleAgentSettled,
	PLAN,
	type RebindContext,
	type RunFlowContext,
	rebindCurrentSession,
	runInteractive,
	showTreeNavigationStatus,
	type TreeNavigationStatusContext,
} from "./interactive-mode-plan-test-utils.ts";

beforeAll(() => initTheme("dark"));

describe("InteractiveMode plan lifecycle", () => {
	test("opens only after startup prompts and after each serialized main-loop prompt", async () => {
		vi.stubEnv("DIFFEX_OFFLINE", "1");
		vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
		const stop = new Error("stop interactive loop");
		const order: string[] = [];
		const context: RunFlowContext = {
			init: vi.fn().mockResolvedValue(undefined),
			version: "0.0.0",
			isInitialized: true,
			options: {
				initialMessage: "initial file prompt",
				initialMessages: ["first positional prompt", "second positional prompt"],
			},
			session: { modelRuntime: { getError: () => undefined } },
			checkForPackageUpdates: vi.fn().mockResolvedValue([]),
			checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			showNewVersionNotification: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			updateTerminalTitle: vi.fn(),
			openPendingPlanDecision: vi.fn(() => order.push("open")),
			promptUser: vi.fn(async (message: string) => {
				order.push(`prompt:${message}`);
			}),
			getUserInput: vi.fn().mockResolvedValueOnce("main-loop prompt").mockRejectedValueOnce(stop),
			editor: { getText: () => "", setText: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		try {
			await expect(runInteractive.call(context)).rejects.toBe(stop);
			expect(order).toEqual([
				"prompt:initial file prompt",
				"prompt:first positional prompt",
				"prompt:second positional prompt",
				"open",
				"prompt:main-loop prompt",
				"open",
			]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("stops startup prompts when one submits a plan before opening the decision", async () => {
		vi.stubEnv("DIFFEX_OFFLINE", "1");
		vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
		const stop = new Error("stop interactive loop");
		const order: string[] = [];
		const session: RunFlowContext["session"] = { modelRuntime: { getError: () => undefined } };
		const context: RunFlowContext = {
			init: vi.fn().mockResolvedValue(undefined),
			version: "0.0.0",
			isInitialized: true,
			options: {
				initialMessage: "initial file prompt",
				initialMessages: [
					"first positional prompt",
					"must wait for plan resolution",
					"also wait for plan resolution",
				],
			},
			session,
			checkForPackageUpdates: vi.fn().mockResolvedValue([]),
			checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			showNewVersionNotification: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			updateTerminalTitle: vi.fn(),
			openPendingPlanDecision: vi.fn(() => order.push("open")),
			promptUser: vi.fn(async (message: string) => {
				order.push(`prompt:${message}`);
				if (message === "first positional prompt") session.pendingPlan = PLAN;
			}),
			getUserInput: vi.fn().mockRejectedValue(stop),
			editor: { getText: () => "", setText: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		try {
			await expect(runInteractive.call(context)).rejects.toBe(stop);
			expect(order).toEqual(["prompt:initial file prompt", "prompt:first positional prompt", "open"]);
			expect(context.editor.setText).toHaveBeenCalledWith(
				"must wait for plan resolution\n\nalso wait for plan resolution",
			);
			expect(context.showStatus).toHaveBeenCalledWith(
				"2 startup prompts are waiting in the editor for plan resolution.",
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("preserves every startup prompt when a restored session already has a pending plan", async () => {
		vi.stubEnv("DIFFEX_OFFLINE", "1");
		vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
		const stop = new Error("stop interactive loop");
		const context: RunFlowContext = {
			init: vi.fn().mockResolvedValue(undefined),
			version: "0.0.0",
			isInitialized: true,
			options: {
				initialMessage: "initial file prompt",
				initialImages: [{}],
				initialMessages: ["first positional prompt", "second positional prompt"],
			},
			session: { modelRuntime: { getError: () => undefined }, pendingPlan: PLAN },
			checkForPackageUpdates: vi.fn().mockResolvedValue([]),
			checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			showNewVersionNotification: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			updateTerminalTitle: vi.fn(),
			openPendingPlanDecision: vi.fn(),
			promptUser: vi.fn(),
			getUserInput: vi.fn().mockRejectedValue(stop),
			editor: { getText: () => "", setText: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		try {
			await expect(runInteractive.call(context)).rejects.toBe(stop);
			expect(context.promptUser).not.toHaveBeenCalled();
			expect(context.editor.setText).toHaveBeenCalledWith(
				"initial file prompt\n\nfirst positional prompt\n\nsecond positional prompt",
			);
			expect(context.showStatus).toHaveBeenCalledWith(
				"3 startup prompts are waiting in the editor for plan resolution. 1 attached startup image must be reattached after plan resolution.",
			);
			expect(context.openPendingPlanDecision).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("preserves startup input and announces a restored accepted continuation", async () => {
		vi.stubEnv("DIFFEX_OFFLINE", "1");
		vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
		const stop = new Error("stop interactive loop");
		const continuation = Object.freeze({ message: "Implement the restored accepted plan." });
		const context: RunFlowContext = {
			init: vi.fn().mockResolvedValue(undefined),
			version: "0.0.0",
			isInitialized: true,
			options: {
				initialMessage: "do not send before the accepted plan",
				initialImages: [{}],
				initialMessages: ["also wait"],
			},
			session: {
				modelRuntime: { getError: () => undefined },
				pendingPlanContinuation: continuation,
			},
			checkForPackageUpdates: vi.fn().mockResolvedValue([]),
			checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			showNewVersionNotification: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			updateTerminalTitle: vi.fn(),
			openPendingPlanDecision: vi.fn(),
			promptUser: vi.fn(),
			getUserInput: vi.fn().mockRejectedValue(stop),
			editor: { getText: () => "", setText: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		try {
			await expect(runInteractive.call(context)).rejects.toBe(stop);
			expect(context.promptUser).not.toHaveBeenCalled();
			expect(context.editor.setText).toHaveBeenCalledWith("do not send before the accepted plan\n\nalso wait");
			expect(context.showStatus).toHaveBeenCalledWith(
				"Accepted plan implementation is waiting. Use /plan to retry. 2 startup prompts are waiting in the editor. 1 attached startup image must be reattached before sending.",
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("announces an accepted continuation after session rebind without executing it", async () => {
		const continuation = Object.freeze({ message: "Implement the rebound accepted plan." });
		const context: RebindContext = {
			session: { pendingPlanContinuation: continuation },
			applyRuntimeSettings: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			subscribeToAgent: vi.fn(),
			bindCurrentSessionExtensions: vi.fn().mockResolvedValue(undefined),
			updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			showStatus: vi.fn(),
			openPendingPlanDecision: vi.fn(),
		};

		await rebindCurrentSession.call(context, { renderBeforeBind: true });

		expect(context.showStatus).toHaveBeenCalledWith("Accepted plan implementation is waiting. Use /plan to retry.");
		expect(context.openPendingPlanDecision).toHaveBeenCalledOnce();
	});

	test.each([
		{
			continuation: undefined,
			message: "Navigated to selected point",
		},
		{
			continuation: Object.freeze({ message: "Implement the restored accepted plan." }),
			message: "Navigated to selected point. Accepted plan implementation is waiting; use /plan to retry.",
		},
	])("reports accepted-plan continuation state after either tree navigation path", ({ continuation, message }) => {
		const context: TreeNavigationStatusContext = {
			session: { pendingPlanContinuation: continuation },
			showStatus: vi.fn(),
		};

		showTreeNavigationStatus.call(context);

		expect(context.showStatus).toHaveBeenCalledWith(message);
	});

	test("does not replace the harness-switch notice with a retry notice during continuation rebind", async () => {
		const continuation = Object.freeze({ message: "Implement the rebound accepted plan." });
		const context: RebindContext = {
			session: { pendingPlanContinuation: continuation },
			activeEditorUi: { preserveOnSessionRebind: true },
			applyRuntimeSettings: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			subscribeToAgent: vi.fn(),
			bindCurrentSessionExtensions: vi.fn().mockResolvedValue(undefined),
			updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			showStatus: vi.fn(),
			openPendingPlanDecision: vi.fn(),
		};

		await rebindCurrentSession.call(context, { renderBeforeBind: true });

		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.openPendingPlanDecision).toHaveBeenCalledOnce();
	});

	test("does not auto-open a pending plan from agent_settled", async () => {
		const context: AgentSettledEventContext = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
			openPendingPlanDecision: vi.fn(),
		};

		await handleAgentSettled.call(context, { type: "agent_settled" });

		expect(context.checkShutdownRequested).toHaveBeenCalledOnce();
		expect(context.openPendingPlanDecision).not.toHaveBeenCalled();
	});
});
