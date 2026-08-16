import { type Component, Container, type Focusable, type TUI, TuiMainScreen } from "@earendil-works/diffex-tui";
import { vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { PlanContinuation } from "../src/core/agent-session.ts";
import type { PlanArtifact } from "../src/core/plan-mode.ts";
import type { PlanEntry, SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

export const PLAN: PlanArtifact = {
	id: "plan-1",
	title: "Add native plan mode",
	markdown: "1. Inspect the current session.\n2. Implement the approved changes.\n3. Run focused verification.",
};

export interface PlanDecisionSession {
	pendingPlan: PlanArtifact | undefined;
	pendingPlanContinuation?: PlanContinuation;
	collaborationMode: "default" | "plan";
	isStreaming?: boolean;
	resolvePlan: ReturnType<typeof vi.fn>;
	promptPlanContinuation: ReturnType<typeof vi.fn>;
	setCollaborationMode: ReturnType<typeof vi.fn>;
}

export interface PlanDecisionContext {
	session: PlanDecisionSession;
	runtimeHost: { promptPlanContinuation: ReturnType<typeof vi.fn> };
	planDecisionAbortController?: AbortController;
	suppressedPlanDecisionId?: string;
	showExtensionSelector: ReturnType<typeof vi.fn>;
	showExtensionConfirm: ReturnType<typeof vi.fn>;
	openPendingPlanDecision: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	mountEditorUi: ReturnType<typeof vi.fn>;
	closeEditorUi: ReturnType<typeof vi.fn>;
	startPlanContinuation: (continuation: PlanContinuation, onPromptOwned?: () => void) => Promise<void>;
	editor: {
		getText: () => string;
		setText: ReturnType<typeof vi.fn>;
	};
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

export const showPendingPlanDecision = Reflect.get(InteractiveMode.prototype, "showPendingPlanDecision") as (
	this: PlanDecisionContext,
	plan: PlanArtifact,
) => Promise<void>;

export interface OpenPlanDecisionContext {
	session: { pendingPlan: PlanArtifact | undefined; isIdle: boolean; isStreaming: boolean };
	planDecisionAbortController?: AbortController;
	suppressedPlanDecisionId?: string;
	activeEditorUi?: { token: object; cancel: () => void; exclusive?: boolean };
	showPendingPlanDecision: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	renderer: { hasOverlayEntries: boolean };
}

export interface PlanSubmittedEventContext {
	isInitialized: boolean;
	footer: { invalidate: ReturnType<typeof vi.fn> };
	renderPlanArtifact: ReturnType<typeof vi.fn>;
}

export const openPendingPlanDecision = Reflect.get(InteractiveMode.prototype, "openPendingPlanDecision") as (
	this: OpenPlanDecisionContext,
	options?: { explicit?: boolean },
) => void;

export const startPlanContinuation = Reflect.get(InteractiveMode.prototype, "startPlanContinuation") as (
	this: PlanDecisionContext,
	continuation: PlanContinuation,
	onPromptOwned?: () => void,
) => Promise<void>;

export const togglePlanMode = Reflect.get(InteractiveMode.prototype, "togglePlanMode") as (
	this: PlanDecisionContext,
) => Promise<void>;

export const handlePlanCommand = Reflect.get(InteractiveMode.prototype, "handlePlanCommand") as (
	this: PlanDecisionContext,
	instructions?: string,
) => Promise<string | undefined>;

export const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: PlanSubmittedEventContext,
	event: { type: "plan_submitted"; plan: PlanArtifact },
) => Promise<void>;

export interface RunFlowContext {
	init: ReturnType<typeof vi.fn>;
	version: string;
	isInitialized: boolean;
	options: {
		initialMessage?: string;
		initialImages?: unknown[];
		initialMessages?: string[];
	};
	session: {
		modelRuntime: { getError: () => undefined };
		pendingPlan?: PlanArtifact;
		pendingPlanContinuation?: PlanContinuation;
	};
	checkForPackageUpdates: ReturnType<typeof vi.fn>;
	checkTmuxKeyboardSetup: ReturnType<typeof vi.fn>;
	maybeWarnAboutAnthropicSubscriptionAuth: ReturnType<typeof vi.fn>;
	showNewVersionNotification: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	updateTerminalTitle: ReturnType<typeof vi.fn>;
	openPendingPlanDecision: ReturnType<typeof vi.fn>;
	promptUser: ReturnType<typeof vi.fn>;
	getUserInput: ReturnType<typeof vi.fn>;
	editor: { getText: () => string; setText: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

export const runInteractive = Reflect.get(InteractiveMode.prototype, "run") as (this: RunFlowContext) => Promise<void>;

export interface RebindContext {
	session: { pendingPlanContinuation?: PlanContinuation };
	activeEditorUi?: { preserveOnSessionRebind: boolean };
	unsubscribe?: () => void;
	applyRuntimeSettings: ReturnType<typeof vi.fn>;
	renderCurrentSessionState: ReturnType<typeof vi.fn>;
	subscribeToAgent: ReturnType<typeof vi.fn>;
	bindCurrentSessionExtensions: ReturnType<typeof vi.fn>;
	updateAvailableProviderCount: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
	updateTerminalTitle: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	openPendingPlanDecision: ReturnType<typeof vi.fn>;
}

export const rebindCurrentSession = Reflect.get(InteractiveMode.prototype, "rebindCurrentSession") as (
	this: RebindContext,
	options?: { renderBeforeBind?: boolean },
) => Promise<void>;

export interface TreeNavigationStatusContext {
	session: { pendingPlanContinuation?: PlanContinuation };
	showStatus: ReturnType<typeof vi.fn>;
}

export const showTreeNavigationStatus = Reflect.get(InteractiveMode.prototype, "showTreeNavigationStatus") as (
	this: TreeNavigationStatusContext,
) => void;

export interface StreamingSubmitContext {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
	};
	promptUser: ReturnType<typeof vi.fn>;
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
	openPendingPlanDecision: ReturnType<typeof vi.fn>;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

export const setupEditorSubmitHandler = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
	this: StreamingSubmitContext,
) => void;

export interface AgentSettledEventContext {
	isInitialized: boolean;
	footer: { invalidate: ReturnType<typeof vi.fn> };
	checkShutdownRequested: ReturnType<typeof vi.fn>;
	openPendingPlanDecision: ReturnType<typeof vi.fn>;
}

export const handleAgentSettled = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: AgentSettledEventContext,
	event: { type: "agent_settled" },
) => Promise<void>;

export interface RenderPlanEntryContext {
	pendingTools: Map<string, unknown>;
	settingsManager: { getShowCacheMissNotices: () => boolean };
	sessionManager: { getEntries: () => SessionEntry[] };
	session: { modelRuntime: unknown };
	renderPlanArtifact: ReturnType<typeof vi.fn>;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

export const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as (
	this: RenderPlanEntryContext,
	items: PlanEntry[],
) => void;

export interface RenderSessionEntriesContext {
	session: { pendingPlan: PlanArtifact | undefined };
	renderSessionItems: ReturnType<typeof vi.fn>;
	renderPlanArtifact: ReturnType<typeof vi.fn>;
}

export const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
	this: RenderSessionEntriesContext,
	entries: SessionEntry[],
) => void;

export interface EditorUiContext {
	activeEditorUi?: {
		token: object;
		cancel: () => void;
		exclusive: boolean;
		preserveOnSessionRebind: boolean;
	};
	editorContainer: Container;
	editor: Component;
	ui: TUI;
	restoreEditorUi: () => void;
	cancelActiveEditorUi: (restoreEditor?: boolean) => void;
	closeEditorUi: (token: object) => boolean;
	replaceEditorUi: (
		token: object,
		component: Component,
		focus: Component,
		options?: { cancel?: () => void; preserveOnSessionRebind?: boolean },
	) => boolean;
	cancelEditorUi: (token: object) => void;
	mountEditorUi: (
		component: Component,
		focus: Component,
		cancel: () => void,
		options?: { exclusive?: boolean; preserveOnSessionRebind?: boolean },
	) => object;
}

export const restoreEditorUi = Reflect.get(InteractiveMode.prototype, "restoreEditorUi") as (
	this: EditorUiContext,
) => void;
export const cancelActiveEditorUi = Reflect.get(InteractiveMode.prototype, "cancelActiveEditorUi") as (
	this: EditorUiContext,
	restoreEditor?: boolean,
) => void;
export const closeEditorUi = Reflect.get(InteractiveMode.prototype, "closeEditorUi") as (
	this: EditorUiContext,
	token: object,
) => boolean;
export const replaceEditorUi = Reflect.get(InteractiveMode.prototype, "replaceEditorUi") as (
	this: EditorUiContext,
	token: object,
	component: Component,
	focus: Component,
	options?: { cancel?: () => void; preserveOnSessionRebind?: boolean },
) => boolean;
export const cancelEditorUi = Reflect.get(InteractiveMode.prototype, "cancelEditorUi") as (
	this: EditorUiContext,
	token: object,
) => void;
export const mountEditorUi = Reflect.get(InteractiveMode.prototype, "mountEditorUi") as (
	this: EditorUiContext,
	component: Component,
	focus: Component,
	cancel: () => void,
	options?: { exclusive?: boolean; preserveOnSessionRebind?: boolean },
) => object;
export const showExtensionSelector = Reflect.get(InteractiveMode.prototype, "showExtensionSelector") as (
	this: EditorUiContext & { toggleToolOutputExpansion: () => void },
	title: string,
	options: string[],
	opts?: { signal?: AbortSignal },
) => Promise<string | undefined>;
export const showSelector = Reflect.get(InteractiveMode.prototype, "showSelector") as (
	this: EditorUiContext,
	create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
) => void;
export const showExtensionCustom = Reflect.get(InteractiveMode.prototype, "showExtensionCustom") as <T>(
	this: EditorUiContext & { keybindings: object },
	factory: (tui: TUI, theme: unknown, keybindings: object, done: (result: T) => void) => Component,
	options?: { overlay?: boolean },
) => Promise<T>;

export interface SessionRebindUiContext extends EditorUiContext {
	session: { isStreaming: boolean };
	renderer: { hasOverlayEntries: boolean };
	cancelPendingPlanDecision: ReturnType<typeof vi.fn>;
	clearExtensionTerminalInputListeners: ReturnType<typeof vi.fn>;
	setExtensionFooter: ReturnType<typeof vi.fn>;
	setExtensionHeader: ReturnType<typeof vi.fn>;
	clearExtensionWidgets: ReturnType<typeof vi.fn>;
	footerDataProvider: { clearExtensionStatuses: ReturnType<typeof vi.fn> };
	footer: { invalidate: ReturnType<typeof vi.fn> };
	autocompleteProviderWrappers: unknown[];
	setCustomEditorComponent: (factory: undefined) => void;
	setupAutocompleteProvider: ReturnType<typeof vi.fn>;
	defaultEditor: InputRecorder & { onExtensionShortcut?: (data: string) => void };
	updateTerminalTitle: ReturnType<typeof vi.fn>;
	workingMessage?: string;
	workingVisible: boolean;
	setWorkingIndicator: ReturnType<typeof vi.fn>;
	activeStatusIndicator?: { kind: string; setMessage: (message: string) => void };
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	editorComponentFactory?: unknown;
}

export const resetExtensionUI = Reflect.get(InteractiveMode.prototype, "resetExtensionUI") as (
	this: SessionRebindUiContext,
	options?: { forSessionRebind?: boolean },
) => void;
export const setCustomEditorComponent = Reflect.get(InteractiveMode.prototype, "setCustomEditorComponent") as (
	this: SessionRebindUiContext,
	factory: undefined,
) => void;

export interface LoginDialogContext extends EditorUiContext {
	session: { model: undefined };
	loginProvider: ReturnType<typeof vi.fn>;
	completeProviderAuthentication: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
}

export const showLoginDialog = Reflect.get(InteractiveMode.prototype, "showLoginDialog") as (
	this: LoginDialogContext,
	providerId: string,
	providerName: string,
) => Promise<void>;

export class InputRecorder implements Component, Focusable {
	focused = false;
	readonly inputs: string[] = [];
	private text = "";

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return ["EDITOR"];
	}

	invalidate(): void {}
}

export function installEditorUiMethods<T extends { editorContainer: Container; editor: Component; ui: TUI }>(
	context: T,
): T & EditorUiContext {
	const editorUiContext = context as T & EditorUiContext;
	editorUiContext.restoreEditorUi = () => restoreEditorUi.call(editorUiContext);
	editorUiContext.cancelActiveEditorUi = (restoreEditor) => cancelActiveEditorUi.call(editorUiContext, restoreEditor);
	editorUiContext.closeEditorUi = (token) => closeEditorUi.call(editorUiContext, token);
	editorUiContext.replaceEditorUi = (token, component, focus, options) =>
		replaceEditorUi.call(editorUiContext, token, component, focus, options);
	editorUiContext.cancelEditorUi = (token) => cancelEditorUi.call(editorUiContext, token);
	editorUiContext.mountEditorUi = (component, focus, cancel, options) =>
		mountEditorUi.call(editorUiContext, component, focus, cancel, options);
	return editorUiContext;
}

export async function flushTui(ui: TUI, terminal: VirtualTerminal): Promise<void> {
	ui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

export function createProfileSelectionContext(width: number) {
	const terminal = new VirtualTerminal(width, 24);
	const ui = new TuiMainScreen(terminal);
	const editor = new InputRecorder();
	const handoff = new InputRecorder();
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	const context = installEditorUiMethods({
		session: { isStreaming: false },
		editor,
		editorContainer,
		ui,
	});
	const handoffCancel = vi.fn();
	const handoffToken = context.mountEditorUi(handoff, handoff, handoffCancel, {
		exclusive: true,
		preserveOnSessionRebind: true,
	});
	return { terminal, ui, editor, handoff, context, handoffCancel, handoffToken };
}

export function createDecisionContext(selection: string | undefined): PlanDecisionContext {
	const session: PlanDecisionSession = {
		pendingPlan: PLAN,
		collaborationMode: "plan",
		resolvePlan: vi.fn(),
		promptPlanContinuation: vi.fn(),
		setCollaborationMode: vi.fn((mode: "default" | "plan") => {
			session.collaborationMode = mode;
		}),
	};
	const context: PlanDecisionContext = {
		session,
		runtimeHost: {
			promptPlanContinuation: vi.fn(
				(_continuation: unknown, options?: { preflightResult?: (success: boolean) => void }) => {
					session.pendingPlanContinuation = undefined;
					options?.preflightResult?.(true);
					return Promise.resolve();
				},
			),
		},
		planDecisionAbortController: undefined,
		suppressedPlanDecisionId: undefined,
		showExtensionSelector: vi.fn().mockResolvedValue(selection),
		showExtensionConfirm: vi.fn().mockResolvedValue(false),
		openPendingPlanDecision: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		mountEditorUi: vi.fn(() => ({})),
		closeEditorUi: vi.fn(() => true),
		startPlanContinuation: async () => {},
		editor: {
			getText: () => "",
			setText: vi.fn(),
		},
		ui: { requestRender: vi.fn() },
	};
	context.startPlanContinuation = (continuation, onPromptOwned) =>
		startPlanContinuation.call(context, continuation, onPromptOwned);
	return context;
}
