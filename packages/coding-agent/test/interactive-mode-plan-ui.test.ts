import { Container, type TUI, TuiMainScreen, visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ProfileSelectionProposal } from "../src/core/agent-session-runtime.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createProfileSelectionContext,
	flushTui,
	InputRecorder,
	installEditorUiMethods,
	PLAN,
	type PlanDecisionContext,
	type PlanDecisionSession,
	PROFILE_PROPOSAL,
	resetExtensionUI,
	resolvePlanProfileSelection,
	type SessionRebindUiContext,
	setCustomEditorComponent,
	showExtensionCustom,
	showExtensionSelector,
	showLoginDialog,
	showPendingPlanDecision,
	showSelector,
	startPlanContinuation,
} from "./interactive-mode-plan-test-utils.ts";

beforeAll(() => initTheme("dark"));

describe("InteractiveMode plan UI ownership", () => {
	test("settles a plan selector before a delayed editor UI takes ownership", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const context = installEditorUiMethods({
			session: {
				pendingPlan: PLAN,
				resolvePlan: vi.fn(),
				promptPlanContinuation: vi.fn(),
			},
			planDecisionAbortController: undefined as AbortController | undefined,
			suppressedPlanDecisionId: undefined as string | undefined,
			editor,
			editorContainer,
			ui,
			showStatus: vi.fn(),
			showError: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
		});
		const selector = (...args: Parameters<typeof showExtensionSelector>) =>
			showExtensionSelector.call(context, ...args);
		Object.assign(context, { showExtensionSelector: selector });

		ui.start();
		try {
			const decision = showPendingPlanDecision.call(context as unknown as PlanDecisionContext, PLAN);
			await vi.waitFor(() => expect(context.planDecisionAbortController).toBeInstanceOf(AbortController));

			const replacement = new InputRecorder();
			await Promise.resolve();
			showSelector.call(context, () => ({ component: replacement, focus: replacement }));
			await decision;

			expect(context.planDecisionAbortController).toBeUndefined();
			expect(context.suppressedPlanDecisionId).toBe(PLAN.id);
			expect(context.activeEditorUi).toBeDefined();
			expect(context.editorContainer.children).toEqual([replacement]);
			expect(context.session.resolvePlan).not.toHaveBeenCalled();
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("does not let delayed login completion restore over a newer selector", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		let finishLogin: (() => void) | undefined;
		const context = installEditorUiMethods({
			session: { model: undefined },
			editor,
			editorContainer,
			ui,
			loginProvider: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishLogin = resolve;
					}),
			),
			completeProviderAuthentication: vi.fn(),
			showError: vi.fn(),
		});

		ui.start();
		try {
			const login = showLoginDialog.call(context, "example", "Example");
			await vi.waitFor(() => expect(context.activeEditorUi).toBeDefined());

			const replacement = new InputRecorder();
			showSelector.call(context, () => ({ component: replacement, focus: replacement }));
			finishLogin?.();
			await login;

			expect(context.completeProviderAuthentication).not.toHaveBeenCalled();
			expect(context.showError).not.toHaveBeenCalled();
			expect(context.editorContainer.children).toEqual([replacement]);
			expect(ui.getFocusedComponent()).toBe(replacement);
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("restores plan selector focus after a capturing overlay closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const context = installEditorUiMethods({
			session: {
				pendingPlan: PLAN,
				resolvePlan: vi.fn(),
				promptPlanContinuation: vi.fn(),
			},
			planDecisionAbortController: undefined as AbortController | undefined,
			suppressedPlanDecisionId: undefined as string | undefined,
			editor,
			editorContainer,
			ui,
			keybindings: {},
			showStatus: vi.fn(),
			showError: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
		});
		const selector = (...args: Parameters<typeof showExtensionSelector>) =>
			showExtensionSelector.call(context, ...args);
		Object.assign(context, { showExtensionSelector: selector });
		const overlay = new InputRecorder();
		let closeOverlay: (result: string) => void = () => {
			throw new Error("Overlay was not initialized");
		};

		ui.start();
		try {
			const decision = showPendingPlanDecision.call(context as unknown as PlanDecisionContext, PLAN);
			await vi.waitFor(() => expect(context.activeEditorUi).toBeDefined());
			const planSelector = context.editorContainer.children[0];

			const overlayPromise = showExtensionCustom.call(
				context,
				(_tui: TUI, _theme: unknown, _keybindings: object, done: (result: string) => void) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			) as Promise<string>;
			await flushTui(ui, terminal);
			expect(ui.getFocusedComponent()).toBe(overlay);
			expect(context.editorContainer.children[0]).toBe(planSelector);

			closeOverlay("closed");
			await overlayPromise;
			await flushTui(ui, terminal);
			expect(ui.getFocusedComponent()).toBe(planSelector);
			expect(context.planDecisionAbortController).toBeInstanceOf(AbortController);

			context.planDecisionAbortController?.abort();
			await decision;
			expect(context.planDecisionAbortController).toBeUndefined();
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("preserves the exclusive implementation handoff through session rebind teardown", () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const handoff = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const cancelHandoff = vi.fn();
		const context = installEditorUiMethods({
			session: { isStreaming: false },
			renderer: { hasOverlayEntries: false },
			editor,
			defaultEditor: editor,
			editorContainer,
			ui,
			cancelPendingPlanDecision: vi.fn(),
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			autocompleteProviderWrappers: [],
			setCustomEditorComponent: (_factory: undefined) => {},
			setupAutocompleteProvider: vi.fn(),
			updateTerminalTitle: vi.fn(),
			workingMessage: undefined as string | undefined,
			workingVisible: true,
			setWorkingIndicator: vi.fn(),
			activeStatusIndicator: undefined,
			setHiddenThinkingLabel: vi.fn(),
			editorComponentFactory: undefined,
		}) as SessionRebindUiContext;
		context.setCustomEditorComponent = (factory) => setCustomEditorComponent.call(context, factory);

		const token = context.mountEditorUi(handoff, handoff, cancelHandoff, {
			exclusive: true,
			preserveOnSessionRebind: true,
		});
		resetExtensionUI.call(context, { forSessionRebind: true });

		expect(cancelHandoff).not.toHaveBeenCalled();
		expect(context.activeEditorUi?.token).toBe(token);
		expect(context.activeEditorUi?.preserveOnSessionRebind).toBe(true);
		expect(context.editorContainer.children).toEqual([handoff]);

		context.closeEditorUi(token);
		expect(context.editorContainer.children).toEqual([editor]);
	});

	test.each([80, 60])("selects an ambiguous implementation profile within %i columns", async (width) => {
		const { terminal, ui, editor, handoff, context, handoffCancel, handoffToken } =
			createProfileSelectionContext(width);
		const controller = new AbortController();

		ui.start();
		try {
			const selection = resolvePlanProfileSelection.call(
				context,
				PROFILE_PROPOSAL,
				controller.signal,
				handoffToken,
				handoff,
				handoffCancel,
			);
			await flushTui(ui, terminal);

			const selector = context.editorContainer.children[0];
			const lines = selector?.render(width) ?? [];
			const rendered = stripAnsi(lines.join("\n"));
			const normalized = rendered.replace(/\s+/gu, " ");
			expect(rendered).toContain("Choose an implementation profile");
			expect(rendered).toContain("1. Finance (recommended) - Financial research");
			expect(normalized).toContain("Safeguards: High stakes; current sources; human review; bash unavailable.");
			expect(rendered).toContain("Tools: no bash");
			expect(rendered).toContain("2. Coding - Software engineering");
			expect(normalized).toContain("Safeguards: Standard safeguards; bash/edit/write available.");
			expect(rendered).toContain("Tools: bash enabled");
			expect(rendered).toContain("navigate");
			expect(lines.length + 2).toBeLessThanOrEqual(24);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(context.activeEditorUi?.token).toBe(handoffToken);
			expect(context.activeEditorUi?.cancel).not.toBe(handoffCancel);
			expect(context.activeEditorUi?.preserveOnSessionRebind).toBe(false);

			terminal.sendInput("\r");
			expect(await selection).toEqual({ profileId: "finance" });
			expect(context.editorContainer.children).toEqual([handoff]);
			expect(ui.getFocusedComponent()).toBe(handoff);
			expect(context.activeEditorUi).toMatchObject({
				token: handoffToken,
				cancel: handoffCancel,
				preserveOnSessionRebind: true,
			});
		} finally {
			context.cancelActiveEditorUi();
			expect(ui.getFocusedComponent()).toBe(editor);
			ui.stop();
		}
	});

	test("strips terminal sequences from every profile-selection consequence", async () => {
		const { terminal, ui, handoff, context, handoffCancel, handoffToken } = createProfileSelectionContext(60);
		const proposal: ProfileSelectionProposal = {
			...PROFILE_PROPOSAL,
			options: PROFILE_PROPOSAL.options.map((option, index) =>
				index === 0
					? {
							...option,
							name: "\u001b]8;;https://example.invalid\u0007Finance\u001b]8;;\u0007",
							description: "Financial\u001b[2J research.",
							safeguardSummary: "High stakes;\u001b[31m human review\u001b[0m.",
							toolPolicy: { ...option.toolPolicy, denied: ["\u001b]0;bad\u0007bash"] },
						}
					: option,
			),
		};
		const controller = new AbortController();

		ui.start();
		try {
			const selection = resolvePlanProfileSelection.call(
				context,
				proposal,
				controller.signal,
				handoffToken,
				handoff,
				handoffCancel,
			);
			await flushTui(ui, terminal);
			const raw = context.editorContainer.children[0]?.render(60).join("\n") ?? "";
			const rendered = stripAnsi(raw);
			expect(raw).not.toContain("example.invalid");
			expect(rendered).toContain("Finance");
			expect(rendered).toContain("Financial research");
			expect(rendered).toContain("High stakes; human review.");
			expect(rendered).toContain("Tools: no bash");

			controller.abort();
			expect(await selection).toEqual({ cancelled: true });
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("restores the exclusive handoff after Escape cancels profile selection", async () => {
		const { terminal, ui, handoff, context, handoffCancel, handoffToken } = createProfileSelectionContext(60);
		const controller = new AbortController();

		ui.start();
		try {
			const selection = resolvePlanProfileSelection.call(
				context,
				PROFILE_PROPOSAL,
				controller.signal,
				handoffToken,
				handoff,
				handoffCancel,
			);
			await flushTui(ui, terminal);
			terminal.sendInput("\x1b");

			expect(await selection).toEqual({ cancelled: true });
			expect(context.editorContainer.children).toEqual([handoff]);
			expect(context.activeEditorUi).toMatchObject({
				token: handoffToken,
				cancel: handoffCancel,
				preserveOnSessionRebind: true,
			});
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("maps truncated duplicate profile names to the selected profile id", async () => {
		const { terminal, ui, handoff, context, handoffCancel, handoffToken } = createProfileSelectionContext(60);
		const repeatedName = "Specialized implementation profile ".repeat(4);
		const proposal: ProfileSelectionProposal = {
			...PROFILE_PROPOSAL,
			options: PROFILE_PROPOSAL.options.map((option) => ({
				...option,
				name: repeatedName,
				description: option.description.repeat(4),
			})),
		};
		const controller = new AbortController();

		ui.start();
		try {
			const selection = resolvePlanProfileSelection.call(
				context,
				proposal,
				controller.signal,
				handoffToken,
				handoff,
				handoffCancel,
			);
			await flushTui(ui, terminal);
			terminal.sendInput("j");
			terminal.sendInput("\r");

			expect(await selection).toEqual({ profileId: "coding" });
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test.each(["runtime abort", "owner teardown"])("settles profile selection once on %s", async (cause) => {
		const { terminal, ui, editor, handoff, context, handoffCancel, handoffToken } = createProfileSelectionContext(60);
		const controller = new AbortController();
		let settlementCount = 0;

		ui.start();
		try {
			const selection = resolvePlanProfileSelection.call(
				context,
				PROFILE_PROPOSAL,
				controller.signal,
				handoffToken,
				handoff,
				handoffCancel,
			);
			void selection.then(() => {
				settlementCount += 1;
			});
			await flushTui(ui, terminal);

			if (cause === "runtime abort") controller.abort();
			else context.cancelActiveEditorUi();
			expect(await selection).toEqual({ cancelled: true });
			controller.abort();
			context.cancelActiveEditorUi();
			await Promise.resolve();

			expect(settlementCount).toBe(1);
			expect(context.activeEditorUi).toBeUndefined();
			expect(context.editorContainer.children).toEqual([editor]);
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(handoffCancel).not.toHaveBeenCalled();
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("settles the ambiguous profile selector when session rebind invalidates it", async () => {
		const { terminal, ui, editor, handoff, context, handoffCancel, handoffToken } = createProfileSelectionContext(60);
		const rebindContext = Object.assign(context, {
			renderer: { hasOverlayEntries: false },
			defaultEditor: editor,
			cancelPendingPlanDecision: vi.fn(),
			clearExtensionTerminalInputListeners: vi.fn(),
			setExtensionFooter: vi.fn(),
			setExtensionHeader: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			footer: { invalidate: vi.fn() },
			autocompleteProviderWrappers: [] as unknown[],
			setCustomEditorComponent: (_factory: undefined) => {},
			setupAutocompleteProvider: vi.fn(),
			updateTerminalTitle: vi.fn(),
			workingMessage: undefined as string | undefined,
			workingVisible: true,
			setWorkingIndicator: vi.fn(),
			activeStatusIndicator: undefined as { kind: string; setMessage: (message: string) => void } | undefined,
			setHiddenThinkingLabel: vi.fn(),
			editorComponentFactory: undefined as unknown,
		}) as SessionRebindUiContext;
		rebindContext.setCustomEditorComponent = (factory) => setCustomEditorComponent.call(rebindContext, factory);
		const controller = new AbortController();

		ui.start();
		try {
			const selection = resolvePlanProfileSelection.call(
				rebindContext,
				PROFILE_PROPOSAL,
				controller.signal,
				handoffToken,
				handoff,
				handoffCancel,
			);
			await flushTui(ui, terminal);
			expect(rebindContext.activeEditorUi?.preserveOnSessionRebind).toBe(false);

			resetExtensionUI.call(rebindContext, { forSessionRebind: true });

			expect(await selection).toEqual({ cancelled: true });
			expect(rebindContext.activeEditorUi).toBeUndefined();
			expect(rebindContext.editorContainer.children).toEqual([editor]);
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(handoffCancel).not.toHaveBeenCalled();
		} finally {
			rebindContext.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("keeps input locked until the accepted continuation owns the prompt", async () => {
		const terminal = new VirtualTerminal(60, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const continuation = Object.freeze({ message: "Implement the accepted plan." });
		let preflightResult: ((success: boolean) => void) | undefined;
		let finishPrompt: ((result: { routing: "selected"; activeProfileId: string }) => void) | undefined;
		const promptPlanContinuation = vi.fn(
			(_continuation: unknown, options?: { preflightResult?: (success: boolean) => void }) => {
				preflightResult = options?.preflightResult;
				return new Promise<{ routing: "selected"; activeProfileId: string }>((resolve) => {
					finishPrompt = resolve;
				});
			},
		);
		const context = installEditorUiMethods({
			session: {
				pendingPlan: PLAN,
				resolvePlan: vi.fn(() => continuation),
				promptPlanContinuation: vi.fn(),
			},
			runtimeHost: { promptPlanContinuation },
			planDecisionAbortController: undefined as AbortController | undefined,
			suppressedPlanDecisionId: undefined as string | undefined,
			editor,
			editorContainer,
			ui,
			showExtensionSelector: vi.fn().mockResolvedValue("Implement"),
			showStatus: vi.fn(),
			showError: vi.fn(),
		});
		const decisionContext = context as unknown as PlanDecisionContext;
		decisionContext.startPlanContinuation = (nextContinuation, onPromptOwned) =>
			startPlanContinuation.call(decisionContext, nextContinuation, onPromptOwned);

		ui.start();
		try {
			const decision = showPendingPlanDecision.call(decisionContext, PLAN);
			await vi.waitFor(() => expect(promptPlanContinuation).toHaveBeenCalledOnce());
			const blocker = context.editorContainer.children[0];
			expect(blocker).not.toBe(editor);
			expect(ui.getFocusedComponent()).toBe(blocker);
			const rejectedReplacement = new InputRecorder();
			const rejectedDispose = vi.fn();
			showSelector.call(context, () => ({
				component: rejectedReplacement,
				focus: rejectedReplacement,
				dispose: rejectedDispose,
			}));
			expect(rejectedDispose).toHaveBeenCalledOnce();
			expect(context.editorContainer.children[0]).toBe(blocker);
			expect(ui.getFocusedComponent()).toBe(blocker);

			terminal.sendInput("second message\r/clear\r/resume\r");
			await flushTui(ui, terminal);
			expect(editor.inputs).toEqual([]);
			expect(promptPlanContinuation).toHaveBeenCalledWith(continuation, {
				source: "interactive",
				profileSelectionResolver: expect.any(Function),
				preflightResult: expect.any(Function),
			});

			preflightResult?.(true);
			expect(ui.getFocusedComponent()).toBe(editor);
			const acceptedReplacement = new InputRecorder();
			showSelector.call(context, () => ({ component: acceptedReplacement, focus: acceptedReplacement }));
			expect(context.editorContainer.children[0]).toBe(acceptedReplacement);
			expect(ui.getFocusedComponent()).toBe(acceptedReplacement);
			finishPrompt?.({ routing: "selected", activeProfileId: "coding" });
			await decision;
			expect(context.planDecisionAbortController).toBeUndefined();
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test("allows before_agent_start UI after synchronous prompt ownership is established", async () => {
		const terminal = new VirtualTerminal(60, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		const hookUi = new InputRecorder();
		let mountHookUi: () => void = () => {
			throw new Error("Hook UI was not initialized");
		};
		const session: PlanDecisionSession = {
			pendingPlan: undefined,
			resolvePlan: vi.fn(),
			promptPlanContinuation: vi.fn(),
		};
		const runtimeHost = {
			promptPlanContinuation: vi.fn(
				async (_continuation: unknown, options?: { preflightResult?: (success: boolean) => void }) => {
					session.isStreaming = true;
					await Promise.resolve();
					mountHookUi();
					options?.preflightResult?.(true);
					return { routing: "selected" as const, activeProfileId: "coding" };
				},
			),
		};
		const context = installEditorUiMethods({
			session,
			runtimeHost,
			planDecisionAbortController: undefined as AbortController | undefined,
			suppressedPlanDecisionId: undefined as string | undefined,
			editor,
			editorContainer,
			ui,
			showExtensionSelector: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		});
		mountHookUi = () => {
			showSelector.call(context, () => ({ component: hookUi, focus: hookUi }));
		};
		const decisionContext = context as unknown as PlanDecisionContext;
		decisionContext.startPlanContinuation = (nextContinuation, onPromptOwned) =>
			startPlanContinuation.call(decisionContext, nextContinuation, onPromptOwned);

		ui.start();
		try {
			await decisionContext.startPlanContinuation(Object.freeze({ message: "Implement." }));

			expect(context.editorContainer.children).toEqual([hookUi]);
			expect(ui.getFocusedComponent()).toBe(hookUi);
		} finally {
			context.cancelActiveEditorUi();
			ui.stop();
		}
	});

	test.each([80, 60])("keeps every pending-plan action visible within %i columns", async (width) => {
		const terminal = new VirtualTerminal(width, 24);
		const ui = new TuiMainScreen(terminal);
		const editor = new InputRecorder();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		const context = installEditorUiMethods({
			session: {
				pendingPlan: PLAN,
				resolvePlan: vi.fn(),
				promptPlanContinuation: vi.fn(),
			},
			planDecisionAbortController: undefined as AbortController | undefined,
			suppressedPlanDecisionId: undefined as string | undefined,
			editor,
			editorContainer,
			ui,
			showStatus: vi.fn(),
			showError: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
		});
		const selector = (...args: Parameters<typeof showExtensionSelector>) =>
			showExtensionSelector.call(context, ...args);
		Object.assign(context, { showExtensionSelector: selector });

		const decision = showPendingPlanDecision.call(context as unknown as PlanDecisionContext, PLAN);
		await vi.waitFor(() => expect(context.activeEditorUi).toBeDefined());
		const lines = context.editorContainer.children[0]?.render(width) ?? [];
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("Implement");
		expect(rendered).toContain("Keep planning");
		expect(rendered).toContain("Discard");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

		context.planDecisionAbortController?.abort();
		await decision;
	});
});
