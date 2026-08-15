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

});
