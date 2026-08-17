import { beforeAll, describe, expect, test, vi } from "vitest";
import type { PlanArtifact } from "../src/core/plan-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	createDecisionContext,
	handlePlanCommand,
	type OpenPlanDecisionContext,
	openPendingPlanDecision,
	PLAN,
	type PlanDecisionSession,
	type StreamingSubmitContext,
	setupEditorSubmitHandler,
	showPendingPlanDecision,
	togglePlanMode,
} from "./interactive-mode-plan-test-utils.ts";

beforeAll(() => initTheme("dark"));

describe("InteractiveMode plan resolution", () => {
	test("accepts the plan and routes the continuation through the runtime", async () => {
		const context = createDecisionContext("Implement");
		context.session.resolvePlan.mockReturnValue({ message: "Implement the accepted plan." });

		await showPendingPlanDecision.call(context, PLAN);

		expect(context.session.resolvePlan).toHaveBeenCalledWith(PLAN.id, "implement");
		expect(context.runtimeHost.promptPlanContinuation).toHaveBeenCalledWith(
			{ message: "Implement the accepted plan." },
			{
				source: "interactive",
				preflightResult: expect.any(Function),
			},
		);
		expect(context.planDecisionAbortController).toBeUndefined();
	});

	test.each([undefined, "Keep planning"])(
		"leaves the plan pending when the selector returns %s",
		async (selection) => {
			const context = createDecisionContext(selection);

			await showPendingPlanDecision.call(context, PLAN);

			expect(context.session.resolvePlan).not.toHaveBeenCalled();
			expect(context.runtimeHost.promptPlanContinuation).not.toHaveBeenCalled();
			expect(context.suppressedPlanDecisionId).toBe(PLAN.id);
			expect(context.showStatus).toHaveBeenCalledWith("Plan remains pending. Use /plan to reopen it.");
		},
	);

	test("discards the plan without submitting a continuation", async () => {
		const context = createDecisionContext("Discard");

		await showPendingPlanDecision.call(context, PLAN);

		expect(context.session.resolvePlan).toHaveBeenCalledWith(PLAN.id, "discard");
		expect(context.runtimeHost.promptPlanContinuation).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Plan discarded; plan mode disabled");
	});

	test("settles the selector without resolving the old session when invalidated", async () => {
		const context = createDecisionContext(undefined);
		context.showExtensionSelector = vi.fn(
			(_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
				new Promise<undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		);

		const decision = showPendingPlanDecision.call(context, PLAN);
		await vi.waitFor(() => expect(context.planDecisionAbortController).toBeInstanceOf(AbortController));
		context.planDecisionAbortController?.abort();
		await decision;

		expect(context.session.resolvePlan).not.toHaveBeenCalled();
		expect(context.planDecisionAbortController).toBeUndefined();
	});

	test("retains the exact accepted continuation for /plan retry when preflight fails", async () => {
		const context = createDecisionContext("Implement");
		const continuation = Object.freeze({ message: "Retry implementation." });
		context.session.pendingPlanContinuation = continuation;
		context.session.resolvePlan.mockReturnValue(continuation);
		context.runtimeHost.promptPlanContinuation.mockRejectedValue(new Error("No model is available"));

		await showPendingPlanDecision.call(context, PLAN);

		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.session.pendingPlanContinuation).toBe(continuation);
		expect(context.showError).toHaveBeenCalledWith(
			"Plan acceptance persisted, but implementation could not start: No model is available Use /plan to retry.",
		);

		context.runtimeHost.promptPlanContinuation.mockImplementation(
			(_continuation: unknown, options?: { preflightResult?: (success: boolean) => void }) => {
				context.session.pendingPlanContinuation = undefined;
				options?.preflightResult?.(true);
				return Promise.resolve();
			},
		);
		await handlePlanCommand.call(context);

		expect(context.runtimeHost.promptPlanContinuation).toHaveBeenLastCalledWith(continuation, {
			source: "interactive",
			preflightResult: expect.any(Function),
		});
		expect(context.session.pendingPlanContinuation).toBeUndefined();
	});

	test("reports a resolved continuation that remains pending after persistence failure", async () => {
		const context = createDecisionContext("Implement");
		const continuation = Object.freeze({ message: "Retry implementation." });
		context.session.pendingPlanContinuation = continuation;
		context.session.resolvePlan.mockReturnValue(continuation);
		context.runtimeHost.promptPlanContinuation.mockResolvedValue({});

		await showPendingPlanDecision.call(context, PLAN);

		expect(context.session.pendingPlanContinuation).toBe(continuation);
		expect(context.showError).toHaveBeenCalledWith(
			"Plan acceptance persisted, but implementation did not start. Use /plan to retry.",
		);
	});

	test("retries the exact restored continuation from the current rebound session", async () => {
		const context = createDecisionContext(undefined);
		const staleSession = context.session;
		const restoredContinuation = Object.freeze({ message: "Implement the restored accepted plan." });
		const reboundSession: PlanDecisionSession = {
			pendingPlan: undefined,
			pendingPlanContinuation: restoredContinuation,
			collaborationMode: "default",
			resolvePlan: vi.fn(),
			promptPlanContinuation: vi.fn(),
			setCollaborationMode: vi.fn(),
		};
		context.session = reboundSession;
		context.runtimeHost.promptPlanContinuation.mockImplementation(
			(_continuation: unknown, options?: { preflightResult?: (success: boolean) => void }) => {
				reboundSession.pendingPlanContinuation = undefined;
				options?.preflightResult?.(true);
				return Promise.resolve();
			},
		);

		await handlePlanCommand.call(context);

		expect(staleSession.promptPlanContinuation).not.toHaveBeenCalled();
		expect(reboundSession.promptPlanContinuation).not.toHaveBeenCalled();
		expect(context.runtimeHost.promptPlanContinuation).toHaveBeenCalledWith(restoredContinuation, {
			source: "interactive",
			preflightResult: expect.any(Function),
		});
		expect(reboundSession.pendingPlanContinuation).toBeUndefined();
	});

	test("toggles plan mode on and off for the keyboard shortcut", async () => {
		const context = createDecisionContext(undefined);
		context.session.pendingPlan = undefined;
		context.session.collaborationMode = "default";

		await togglePlanMode.call(context);
		expect(context.session.setCollaborationMode).toHaveBeenLastCalledWith("plan");
		expect(context.showStatus).toHaveBeenLastCalledWith("Plan mode enabled");

		await togglePlanMode.call(context);
		expect(context.session.setCollaborationMode).toHaveBeenLastCalledWith("default");
		expect(context.showStatus).toHaveBeenLastCalledWith("Plan mode disabled");
	});

	test("confirms before the keyboard shortcut discards a pending plan", async () => {
		const context = createDecisionContext(undefined);
		context.showExtensionConfirm.mockResolvedValue(true);

		await togglePlanMode.call(context);

		expect(context.showExtensionConfirm).toHaveBeenCalledWith(
			"Discard pending plan",
			"Disable plan mode and discard the pending plan?",
		);
		expect(context.session.resolvePlan).toHaveBeenCalledWith(PLAN.id, "discard");
		expect(context.showStatus).toHaveBeenLastCalledWith("Plan discarded; plan mode disabled");
	});

	test("activates plan mode and returns slash-command instructions as the prompt", async () => {
		const context = createDecisionContext(undefined);
		context.session.pendingPlan = undefined;
		context.session.collaborationMode = "default";

		const prompt = await handlePlanCommand.call(context, "inspect the authentication flow");

		expect(context.session.setCollaborationMode).toHaveBeenCalledWith("plan");
		expect(context.showStatus).toHaveBeenCalledWith("Plan mode enabled");
		expect(prompt).toBe("inspect the authentication flow");
	});

	test("keeps bare /plan active instead of toggling plan mode off", async () => {
		const context = createDecisionContext(undefined);
		context.session.pendingPlan = undefined;

		const prompt = await handlePlanCommand.call(context);

		expect(context.session.setCollaborationMode).not.toHaveBeenCalled();
		expect(prompt).toBeUndefined();
	});

	test.each(["on", "off"])("treats former /plan %s controls as planning instructions", async (instructions) => {
		const context = createDecisionContext(undefined);
		context.session.pendingPlan = undefined;
		context.session.collaborationMode = "default";

		const prompt = await handlePlanCommand.call(context, instructions);

		expect(context.session.setCollaborationMode).toHaveBeenCalledWith("plan");
		expect(prompt).toBe(instructions);
	});

	test("blocks new /plan instructions while an accepted continuation is pending", async () => {
		const context = createDecisionContext(undefined);
		const continuation = Object.freeze({ message: "Implement the accepted plan." });
		context.session.pendingPlan = undefined;
		context.session.pendingPlanContinuation = continuation;

		const prompt = await handlePlanCommand.call(context, "revise the implementation");

		expect(context.runtimeHost.promptPlanContinuation).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith(
			"Accepted plan implementation is waiting. Use /plan to retry it first.",
		);
		expect(context.session.pendingPlanContinuation).toBe(continuation);
		expect(prompt).toBeUndefined();
	});

	test("does not leave a handoff loader mounted when durable plan acceptance fails", async () => {
		const context = createDecisionContext("Implement");
		context.session.resolvePlan.mockImplementation(() => {
			throw new Error("persistence failed");
		});

		await expect(showPendingPlanDecision.call(context, PLAN)).rejects.toThrow("persistence failed");

		expect(context.mountEditorUi).not.toHaveBeenCalled();
		expect(context.planDecisionAbortController).toBeUndefined();
	});

	test("suppresses automatic reopen but allows explicit reopen and a replacement plan", () => {
		const context: OpenPlanDecisionContext = {
			session: { pendingPlan: PLAN, isIdle: true, isStreaming: false },
			suppressedPlanDecisionId: PLAN.id,
			showPendingPlanDecision: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			renderer: { hasOverlayEntries: false },
		};

		openPendingPlanDecision.call(context);
		expect(context.showPendingPlanDecision).not.toHaveBeenCalled();

		openPendingPlanDecision.call(context, { explicit: true });
		expect(context.showPendingPlanDecision).toHaveBeenCalledWith(PLAN);
		expect(context.suppressedPlanDecisionId).toBeUndefined();

		context.showPendingPlanDecision.mockClear();
		context.suppressedPlanDecisionId = PLAN.id;
		const replacement = { ...PLAN, id: "plan-2" };
		context.session.pendingPlan = replacement;
		openPendingPlanDecision.call(context);
		expect(context.showPendingPlanDecision).toHaveBeenCalledWith(replacement);
		expect(context.suppressedPlanDecisionId).toBeUndefined();
	});

	test("does not replace another editor UI and opens once the normal editor is restored", () => {
		const context: OpenPlanDecisionContext = {
			session: { pendingPlan: PLAN, isIdle: true, isStreaming: false },
			activeEditorUi: { token: {}, cancel: vi.fn() },
			showPendingPlanDecision: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			renderer: { hasOverlayEntries: false },
		};

		openPendingPlanDecision.call(context);
		expect(context.showPendingPlanDecision).not.toHaveBeenCalled();

		context.activeEditorUi = undefined;
		openPendingPlanDecision.call(context);
		expect(context.showPendingPlanDecision).toHaveBeenCalledWith(PLAN);
	});

	test("does not open beneath a capturing overlay", () => {
		const context: OpenPlanDecisionContext = {
			session: { pendingPlan: PLAN, isIdle: true, isStreaming: false },
			showPendingPlanDecision: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			renderer: { hasOverlayEntries: true },
		};

		openPendingPlanDecision.call(context);
		expect(context.showPendingPlanDecision).not.toHaveBeenCalled();
	});

	test("does not open while prompt preflight still counts as streaming", () => {
		const context: OpenPlanDecisionContext = {
			session: { pendingPlan: PLAN, isIdle: true, isStreaming: true },
			showPendingPlanDecision: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			renderer: { hasOverlayEntries: false },
		};

		openPendingPlanDecision.call(context);

		expect(context.showPendingPlanDecision).not.toHaveBeenCalled();
	});

	test("keeps the /plan command in history while dispatching only its instructions", async () => {
		const onInputCallback = vi.fn();
		const context: StreamingSubmitContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session: { isCompacting: false, isStreaming: false },
			flushPendingBashComponents: vi.fn(),
			handlePlanCommand: vi.fn().mockResolvedValue("inspect the authentication flow"),
			isExtensionCommand: vi.fn(),
			onInputCallback,
			pendingUserInputs: [],
			promptUser: vi.fn(),
			queueCompactionMessage: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			openPendingPlanDecision: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		setupEditorSubmitHandler.call(context);
		if (!context.defaultEditor.onSubmit) throw new Error("Submit handler was not installed");

		await context.defaultEditor.onSubmit("/plan inspect the authentication flow");

		expect(context.editor.addToHistory).toHaveBeenCalledWith("/plan inspect the authentication flow");
		expect(onInputCallback).toHaveBeenCalledWith("inspect the authentication flow");
	});

	test("preserves /plan history while compaction queues transformed instructions", async () => {
		const context: StreamingSubmitContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session: { isCompacting: true, isStreaming: false },
			flushPendingBashComponents: vi.fn(),
			handlePlanCommand: vi.fn().mockResolvedValue("inspect the authentication flow"),
			isExtensionCommand: vi.fn().mockReturnValue(false),
			pendingUserInputs: [],
			promptUser: vi.fn(),
			queueCompactionMessage: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			openPendingPlanDecision: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		setupEditorSubmitHandler.call(context);
		if (!context.defaultEditor.onSubmit) throw new Error("Submit handler was not installed");

		await context.defaultEditor.onSubmit("/plan inspect the authentication flow");

		expect(context.queueCompactionMessage).toHaveBeenCalledWith(
			"inspect the authentication flow",
			"steer",
			"/plan inspect the authentication flow",
		);
	});

	test("retries pending-plan admission after the last streaming submission preflight settles", async () => {
		const session = {
			isCompacting: false,
			isStreaming: true,
			isIdle: true,
			pendingPlan: PLAN as PlanArtifact | undefined,
		};
		const showPendingPlanDecision = vi.fn().mockResolvedValue(undefined);
		const openContext: OpenPlanDecisionContext = {
			session,
			showPendingPlanDecision,
			showError: vi.fn(),
			renderer: { hasOverlayEntries: false },
		};
		const releases: Array<() => void> = [];
		const context: StreamingSubmitContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session,
			flushPendingBashComponents: vi.fn(),
			handlePlanCommand: vi.fn(),
			isExtensionCommand: vi.fn(),
			pendingUserInputs: [],
			promptUser: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releases.push(resolve);
					}),
			),
			queueCompactionMessage: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			openPendingPlanDecision: vi.fn(() => openPendingPlanDecision.call(openContext)),
			ui: { requestRender: vi.fn() },
		};
		setupEditorSubmitHandler.call(context);
		if (!context.defaultEditor.onSubmit) throw new Error("Submit handler was not installed");

		const first = context.defaultEditor.onSubmit("first queued message");
		const second = context.defaultEditor.onSubmit("second queued message");
		await vi.waitFor(() => expect(releases).toHaveLength(2));

		releases[0]?.();
		await first;
		expect(showPendingPlanDecision).not.toHaveBeenCalled();

		session.isStreaming = false;
		releases[1]?.();
		await second;
		expect(showPendingPlanDecision).toHaveBeenCalledOnce();
		expect(showPendingPlanDecision).toHaveBeenCalledWith(PLAN);
	});
});
