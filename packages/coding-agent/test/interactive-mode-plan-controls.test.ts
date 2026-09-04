import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { type Component, Container } from "@earendil-works/diffex-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	COLLABORATION_MODE_CUSTOM_TYPE,
	getCollaborationMode,
	PLAN_MODE_SYSTEM_PROMPT,
	setCollaborationMode,
} from "../src/core/collaboration-mode.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

type TestEditor = {
	setText: ReturnType<typeof vi.fn>;
	addToHistory: ReturnType<typeof vi.fn>;
};

type ControlContext = {
	session: AgentSession;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: TestEditor;
	pendingUserInputs: string[];
	directBashCommandsInProgress: number;
	onInputCallback?: (text: string) => void;
	showCollaborationModeStatus: ReturnType<typeof vi.fn<(message: string) => void>>;
	showError: ReturnType<typeof vi.fn<(message: string) => void>>;
	flushPendingBashComponents: ReturnType<typeof vi.fn>;
	isExtensionCommand: ReturnType<typeof vi.fn>;
	queueCompactionMessage: ReturnType<typeof vi.fn>;
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	handlePlanCommand(text: string): Promise<void>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: {
		defaultEditor: { onSubmit?: (text: string) => Promise<void> };
		handlePlanCommand: (text: string) => Promise<void>;
	}): void;
	handlePlanCommand(this: ControlContext, originalText: string): Promise<void>;
	handleBashCommand(
		this: {
			directBashCommandsInProgress: number;
			runBashCommand: (command: string, excludeFromContext: boolean) => Promise<void>;
		},
		command: string,
		excludeFromContext?: boolean,
	): Promise<void>;
	restoreCurrentCollaborationMode(this: { session: AgentSession }): void;
	showCollaborationModeStatus(
		this: {
			chatContainer: Container;
			pendingUserDock?: Component;
			streamingComponent?: Component;
			activeToolGroup?: Component;
			lastStatusSpacer?: Component;
			lastStatusText?: Component;
			ui: { requestRender: () => void };
		},
		message: string,
	): void;
	toggleCollaborationMode(this: {
		session: AgentSession;
		directBashCommandsInProgress?: number;
		showCollaborationModeStatus: (message: string) => void;
		showError: (message: string) => void;
	}): void;
	setupKeyHandlers(this: {
		defaultEditor: {
			onAction: (action: string, handler: () => void) => void;
			onEscape?: () => void;
			onCtrlD?: () => void;
			onChange?: (text: string) => void;
			onPasteImage?: () => void;
		};
		ui: { onDebug?: () => void };
		toggleCollaborationMode: () => void;
	}): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function getModeEntries(sessionManager: SessionManager) {
	return sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === COLLABORATION_MODE_CUSTOM_TYPE);
}

function createControlContext(session: AgentSession): ControlContext {
	const context: ControlContext = {
		session,
		defaultEditor: {},
		editor: {
			setText: vi.fn(),
			addToHistory: vi.fn(),
		},
		pendingUserInputs: [],
		directBashCommandsInProgress: 0,
		showCollaborationModeStatus: vi.fn(),
		showError: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		queueCompactionMessage: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		handlePlanCommand: async (text) => prototype.handlePlanCommand.call(context, text),
	};
	prototype.setupEditorSubmitHandler.call(context);
	return context;
}

function testComponent(label: string): Component {
	return {
		render: () => [label],
		invalidate: () => {},
	};
}

describe("Interactive Plan mode controls", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("assigns Shift+Tab to mode toggling and leaves thinking cycling unbound", () => {
		const defaults = new KeybindingsManager();
		expect(defaults.getKeys("app.mode.toggle")).toEqual(["shift+tab"]);
		expect(defaults.getKeys("app.thinking.cycle")).toEqual([]);

		const custom = new KeybindingsManager({
			"app.mode.toggle": "ctrl+m",
			"app.thinking.cycle": "shift+tab",
		});
		expect(custom.getKeys("app.mode.toggle")).toEqual(["ctrl+m"]);
		expect(custom.getKeys("app.thinking.cycle")).toEqual(["shift+tab"]);
	});

	it("registers the mode toggle through the CustomEditor action surface", () => {
		const actions = new Map<string, () => void>();
		const toggleCollaborationMode = vi.fn();
		const context = {
			defaultEditor: {
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			ui: {},
			toggleCollaborationMode,
		};

		prototype.setupKeyHandlers.call(context);
		actions.get("app.mode.toggle")?.();

		expect(toggleCollaborationMode).toHaveBeenCalledOnce();
		expect([...actions.keys()].indexOf("app.thinking.cycle")).toBeLessThan(
			[...actions.keys()].indexOf("app.mode.toggle"),
		);
	});

	it.each(["regular", "fullscreen"] as const)(
		"dispatches /plan through the shared %s submit path",
		async (tuiMode) => {
			const handlePlanCommand = vi.fn(async () => {});
			const context: {
				defaultEditor: { onSubmit?: (text: string) => Promise<void> };
				handlePlanCommand: (text: string) => Promise<void>;
				options: { tuiMode: "regular" | "fullscreen" };
			} = {
				defaultEditor: {},
				handlePlanCommand,
				options: { tuiMode },
			};
			prototype.setupEditorSubmitHandler.call(context);

			await context.defaultEditor.onSubmit?.("/plan review this");

			expect(handlePlanCommand).toHaveBeenCalledWith("/plan review this");
		},
	);

	it("transitions before submitting /plan trailing text through the normal idle path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let promptPromise: Promise<void> | undefined;
		let providerPrompt = "";
		harness.setResponses([
			(context) => {
				providerPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("planned");
			},
		]);
		const context = createControlContext(harness.session);
		context.onInputCallback = (text) => {
			promptPromise = harness.session.prompt(text);
		};

		await prototype.handlePlanCommand.call(context, "/plan inspect the repository");
		await promptPromise;

		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);
		expect(getUserTexts(harness)).toContain("inspect the repository");
		expect(providerPrompt).toContain(PLAN_MODE_SYSTEM_PROMPT);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("inspect the repository");
		expect(context.showCollaborationModeStatus).toHaveBeenCalledWith("Mode: Plan");
	});

	it("makes bare /plan idempotent without adding history or redundant records", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const context = createControlContext(harness.session);

		await prototype.handlePlanCommand.call(context, "/plan");
		await prototype.handlePlanCommand.call(context, "/plan");

		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.editor.addToHistory).not.toHaveBeenCalled();
		expect(context.showCollaborationModeStatus).toHaveBeenNthCalledWith(1, "Mode: Plan");
		expect(context.showCollaborationModeStatus).toHaveBeenNthCalledWith(2, "Mode: Plan");
	});

	it.each(["isStreaming", "isCompacting", "isRetrying", "isBashRunning"] as const)(
		"preserves rejected /plan text while %s and performs no submission or persistence",
		async (property) => {
			const harness = await createHarness();
			harnesses.push(harness);
			vi.spyOn(harness.session, property, "get").mockReturnValue(true);
			const context = createControlContext(harness.session);

			await prototype.handlePlanCommand.call(context, "/plan retry this request");

			expect(getCollaborationMode(harness.session)).toBe("default");
			expect(getModeEntries(harness.sessionManager)).toHaveLength(0);
			expect(context.editor.setText).toHaveBeenCalledWith("/plan retry this request");
			expect(context.editor.addToHistory).not.toHaveBeenCalled();
			expect(context.pendingUserInputs).toEqual([]);
			expect(context.showCollaborationModeStatus).toHaveBeenCalledWith("Cannot switch modes while Diffex is busy.");
		},
	);

	it("rejects mode controls throughout direct Bash extension handling", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const context = createControlContext(harness.session);
		context.directBashCommandsInProgress = 1;

		await prototype.handlePlanCommand.call(context, "/plan retry after bash");
		prototype.toggleCollaborationMode.call({
			session: context.session,
			directBashCommandsInProgress: context.directBashCommandsInProgress,
			showCollaborationModeStatus: (message) => context.showCollaborationModeStatus(message),
			showError: (message) => context.showError(message),
		});

		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(0);
		expect(context.editor.setText).toHaveBeenCalledWith("/plan retry after bash");
		expect(context.editor.addToHistory).not.toHaveBeenCalled();
		expect(context.showCollaborationModeStatus).toHaveBeenCalledTimes(2);
		expect(context.showCollaborationModeStatus).toHaveBeenCalledWith("Cannot switch modes while Diffex is busy.");
	});

	it("clears the direct Bash mode-switch guard after asynchronous handler errors", async () => {
		let rejectBash: ((reason: Error) => void) | undefined;
		const bash = new Promise<void>((_resolve, reject) => {
			rejectBash = reject;
		});
		const context = {
			directBashCommandsInProgress: 0,
			runBashCommand: vi.fn(() => bash),
		};

		const execution = prototype.handleBashCommand.call(context, "failing command");
		expect(context.directBashCommandsInProgress).toBe(1);
		rejectBash?.(new Error("extension failure"));
		await expect(execution).rejects.toThrow("extension failure");

		expect(context.directBashCommandsInProgress).toBe(0);
		expect(context.runBashCommand).toHaveBeenCalledWith("failing command", false);
	});

	it("preserves /plan text and Default mode when persistence fails", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "diffex-plan-controls-atomic-"));
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		sessionManager.appendMessage(fauxAssistantMessage("seed"));
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		rmSync(sessionDir, { recursive: true, force: true });
		const context = createControlContext(harness.session);

		await prototype.handlePlanCommand.call(context, "/plan keep this request");

		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(getModeEntries(sessionManager)).toHaveLength(0);
		expect(context.editor.setText).toHaveBeenCalledWith("/plan keep this request");
		expect(context.editor.addToHistory).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledOnce();
	});

	it("routes already-active Plan requests through steering without persisting again", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
		const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(undefined);
		const context = createControlContext(harness.session);

		await prototype.handlePlanCommand.call(context, "/plan change direction");

		expect(prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(context.editor.addToHistory).toHaveBeenCalledWith("change direction");
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);
		expect(context.showCollaborationModeStatus).not.toHaveBeenCalled();
	});

	it("routes already-active Plan requests through the compaction queue without persisting again", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		vi.spyOn(harness.session, "isCompacting", "get").mockReturnValue(true);
		const context = createControlContext(harness.session);

		await prototype.handlePlanCommand.call(context, "/plan preserve this for later");

		expect(context.queueCompactionMessage).toHaveBeenCalledWith("preserve this for later", "steer");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);
		expect(context.showCollaborationModeStatus).not.toHaveBeenCalled();
	});

	it("restores valid, malformed, and absent selected-branch preferences without appending", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const planEntry = harness.sessionManager.appendCustomEntry(COLLABORATION_MODE_CUSTOM_TYPE, { mode: "plan" });

		prototype.restoreCurrentCollaborationMode.call({ session: harness.session });
		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);

		harness.sessionManager.appendCustomEntry(COLLABORATION_MODE_CUSTOM_TYPE, { mode: "broken" });
		prototype.restoreCurrentCollaborationMode.call({ session: harness.session });
		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(2);

		harness.sessionManager.branch(planEntry);
		prototype.restoreCurrentCollaborationMode.call({ session: harness.session });
		expect(getCollaborationMode(harness.session)).toBe("plan");

		harness.sessionManager.resetLeaf();
		prototype.restoreCurrentCollaborationMode.call({ session: harness.session });
		expect(getCollaborationMode(harness.session)).toBe("default");
	});

	it("restores every interactive runtime replacement before rebinding its UI", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let rebind: (() => Promise<void>) | undefined;
		const runtimeHost = {
			session: harness.session,
			setBeforeSessionInvalidate: vi.fn(),
			setRebindSession: (callback: () => Promise<void>) => {
				rebind = callback;
			},
		} as unknown as AgentSessionRuntime;
		const interactiveMode = new InteractiveMode(runtimeHost, { tuiMode: "regular" });
		const rebindCurrentSession = vi.fn(async () => {});
		(interactiveMode as unknown as { rebindCurrentSession: () => Promise<void> }).rebindCurrentSession =
			rebindCurrentSession;
		harness.sessionManager.appendCustomEntry(COLLABORATION_MODE_CUSTOM_TYPE, { mode: "plan" });

		await rebind?.();

		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);
		expect(rebindCurrentSession).toHaveBeenCalledOnce();
		interactiveMode.stop();
	});

	it("shows successful mode status without reopening or closing the active response path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const chatContainer = new Container();
		const activeUserPath = testComponent("active user path");
		chatContainer.addChild(activeUserPath);
		const completeTranscriptTurn = vi.fn();
		const flushTranscriptBoundary = vi.fn();
		const context = {
			session: harness.session,
			chatContainer,
			pendingUserDock: activeUserPath,
			streamingComponent: undefined,
			activeToolGroup: undefined,
			turnBoundaryPending: true,
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
			ui: { requestRender: vi.fn() },
			showError: vi.fn(),
			completeTranscriptTurn,
			flushTranscriptBoundary,
			showCollaborationModeStatus(message: string) {
				prototype.showCollaborationModeStatus.call(this, message);
			},
		};

		prototype.toggleCollaborationMode.call(context);

		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(1);
		expect(context.pendingUserDock).toBe(activeUserPath);
		expect(context.turnBoundaryPending).toBe(true);
		expect(chatContainer.children.at(-1)).toBe(activeUserPath);
		expect(chatContainer.render(100).join("\n")).toContain("Mode: Plan");
		expect(completeTranscriptTurn).not.toHaveBeenCalled();
		expect(flushTranscriptBoundary).not.toHaveBeenCalled();

		prototype.toggleCollaborationMode.call(context);

		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(getModeEntries(harness.sessionManager)).toHaveLength(2);
		expect(chatContainer.render(100).join("\n")).toContain("Mode: Default");
		expect(context.pendingUserDock).toBe(activeUserPath);
		expect(context.turnBoundaryPending).toBe(true);
	});
});
