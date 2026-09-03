import type { AgentMessage } from "@earendil-works/diffex-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/diffex-ai";
import { Container, getGlyphs, Spacer, Text, type TUI } from "@earendil-works/diffex-tui";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { DiffexPathDockHinge } from "../src/modes/interactive/components/diffex-path.ts";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-transcript";
const TOOL_NAME = "inspect";
const originalNoColor = process.env.NO_COLOR;
const originalTerm = process.env.TERM;

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type TestContext = {
	isInitialized: boolean;
	footer: { invalidate(): void };
	settingsManager: {
		getShowTerminalProgress(): boolean;
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
		setHideThinkingBlock(hidden: boolean): void;
	};
	ui: TUI;
	chatContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
	activeToolGroup: ToolGroupComponent | undefined;
	turnBoundaryPending: boolean;
	pendingUserDock: UserMessageComponent | undefined;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	toolOutputExpanded: boolean;
	agentResponseStartMs: number | undefined;
	workingMessage: string | undefined;
	workingIndicatorOptions: { frames: string[] } | undefined;
	session: {
		isStreaming: boolean;
		retryAttempt: number;
		extensionRunner: { getEntryRenderer(customType: string): (() => Text) | undefined };
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[]; buildContextEntries(): SessionEntry[] };
	clearStatusIndicator(kind?: string): void;
	getMarkdownThemeWithSettings(): ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers(): [];
	getRegisteredToolDefinition(toolName: string): ToolDefinition | undefined;
	maybeShowCacheMissNotice(): void;
	addMessageToChat(message: AgentMessage): void;
	updateEditorBorderColor(): void;
};

type HandleEvent = (this: TestContext, event: AgentSessionEvent) => Promise<void>;
type RenderSessionItems = (
	this: TestContext,
	items: readonly (AgentMessage | Extract<SessionEntry, { type: "custom" }>)[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;
type ToggleThinkingBlockVisibility = (this: TestContext) => void;
type AddMessageToChat = (this: TestContext, message: AgentMessage, options?: { populateHistory?: boolean }) => void;

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function createToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text: "inspection complete" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createCustomEntry(): Extract<SessionEntry, { type: "custom" }> {
	return {
		type: "custom",
		customType: "turn-note",
		id: "entry-turn-note",
		parentId: null,
		timestamp: new Date().toISOString(),
	};
}

function createContext(): TestContext {
	const chatContainer = new Container();
	const context = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		settingsManager: {
			getShowTerminalProgress: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
			setHideThinkingBlock: vi.fn(),
		},
		ui: {
			terminal: { setProgress: vi.fn() },
			requestRender: vi.fn(),
		} as unknown as TUI,
		chatContainer,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		activeToolGroup: undefined,
		turnBoundaryPending: false,
		pendingUserDock: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		agentResponseStartMs: undefined,
		workingMessage: undefined,
		workingIndicatorOptions: undefined,
		session: {
			isStreaming: false,
			retryAttempt: 0,
			extensionRunner: {
				getEntryRenderer: (customType) =>
					customType === "turn-note" ? () => new Text("next turn note", 0, 0) : undefined,
			},
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [], buildContextEntries: () => [] },
		clearStatusIndicator: vi.fn(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
		maybeShowCacheMissNotice: vi.fn(),
		addMessageToChat(message: AgentMessage) {
			const text =
				message.role === "assistant"
					? message.content
							.filter((content) => content.type === "text")
							.map((content) => content.text)
							.join("\n")
					: message.role;
			chatContainer.addChild(new Text(text, 0, 0));
		},
		updateEditorBorderColor: vi.fn(),
	} as TestContext;
	Object.setPrototypeOf(context, InteractiveMode.prototype);
	return context;
}

function renderChat(context: TestContext): string {
	return stripAnsi(context.chatContainer.render(100).join("\n"));
}

function renderTranscriptBoundary(width: number): string {
	return stripAnsi(new DynamicBorder((line) => line).render(width)[0] ?? "").trimEnd();
}

function getTranscriptTopology(context: TestContext): string[] {
	return context.chatContainer.children.map((child) => {
		if (child instanceof UserMessageComponent) return "user";
		if (child instanceof CustomEntryComponent) return "custom";
		if (child instanceof DiffexPathDockHinge) return "hinge";
		if (child instanceof AssistantMessageComponent) return "assistant";
		if (child instanceof ToolGroupComponent) return "tools";
		if (child instanceof DynamicBorder) return "boundary";
		if (child instanceof Spacer) return "spacer";
		return child.constructor.name;
	});
}

function useTranscriptMessageRendering(context: TestContext): AddMessageToChat {
	const addMessageToChat = (InteractiveMode.prototype as unknown as { addMessageToChat: AddMessageToChat })
		.addMessageToChat;
	context.addMessageToChat = (message) => addMessageToChat.call(context, message);
	return addMessageToChat;
}

function expectUserAssistantGap(context: TestContext, width: number, assistantLabel: string): void {
	const renderedLines = context.chatContainer.render(width);
	const lines = renderedLines.map((line) => stripAnsi(line).trimEnd());
	const userLine = lines.findIndex((line) => line.includes("explain the theorem"));
	const assistantLine = lines.findIndex((line) => line.includes(assistantLabel));

	expect(userLine).toBeGreaterThanOrEqual(0);
	expect(assistantLine).toBeGreaterThan(userLine);
	const hinge = width >= 80 ? `${getGlyphs().start}${getGlyphs().separator.repeat(2)}` : getGlyphs().start;
	const transitionLines = ["", "", ` ${hinge}`];
	expect(lines.slice(userLine + 1, assistantLine)).toEqual(transitionLines);
	expect(renderedLines[userLine + 1]).toMatch(/\x1b\[48;/);
	expect(renderedLines[userLine + 1]).toContain("\x1b[49m");
	expect(renderedLines[userLine + 2]).not.toMatch(/\x1b\[48;/);
}

function expectConnectedTruncationPath(context: TestContext): void {
	const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
	const answerBoundaryIndex = lines.indexOf(` ${getGlyphs().branch}`);
	const noticeIndex = lines.findIndex((line) => line.includes("Response was truncated before completion."));
	const exploredIndex = lines.findIndex((line) => line.includes("Explor"));

	expect(answerBoundaryIndex).toBeGreaterThanOrEqual(0);
	expect(noticeIndex).toBeGreaterThan(answerBoundaryIndex);
	expect(exploredIndex).toBeGreaterThan(noticeIndex);
	expect(lines[exploredIndex - 1]).toBe(` ${getGlyphs().rail}`);
	expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(1);
	const toolGroup = context.chatContainer.children.find(
		(child): child is ToolGroupComponent => child instanceof ToolGroupComponent,
	);
	expect(toolGroup?.getPathOrigin()).toBe("continued");
}

describe("Interactive transcript layout", () => {
	beforeAll(() => {
		process.env.NO_COLOR = "";
		process.env.TERM = "xterm-256color";
		initTheme("dark");
	});

	afterAll(() => {
		if (originalNoColor === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNoColor;
		}
		if (originalTerm === undefined) {
			delete process.env.TERM;
		} else {
			process.env.TERM = originalTerm;
		}
	});

	test("flushes a pending turn boundary before a displayed extension entry", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		context.chatContainer.addChild(new Text("previous response", 0, 0));
		context.turnBoundaryPending = true;

		await handleEvent.call(context, {
			type: "entry_appended",
			entry: {
				type: "custom",
				customType: "turn-note",
				id: "entry-turn-note",
				parentId: null,
				timestamp: new Date().toISOString(),
			},
		});

		const boundaryIndex = context.chatContainer.children.findIndex((child) => child instanceof DynamicBorder);
		const entryIndex = context.chatContainer.children.findIndex((child) => child instanceof CustomEntryComponent);
		expect(boundaryIndex).toBeGreaterThan(0);
		expect(entryIndex).toBeGreaterThan(boundaryIndex);
		expect(context.turnBoundaryPending).toBe(false);
	});

	test("replays a displayed extension entry after a completed assistant boundary", () => {
		const context = createContext();
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const assistantMessage = createAssistantMessage([{ type: "text", text: "final answer" }], "stop");

		renderSessionItems.call(context, [assistantMessage, createCustomEntry()]);

		const answerIndex = context.chatContainer.children.findIndex(
			(child) => child instanceof Text && stripAnsi(child.render(100).join("\n")).includes("final answer"),
		);
		const boundaryIndex = context.chatContainer.children.findIndex((child) => child instanceof DynamicBorder);
		const entryIndex = context.chatContainer.children.findIndex((child) => child instanceof CustomEntryComponent);
		expect(answerIndex).toBeGreaterThanOrEqual(0);
		expect(boundaryIndex).toBeGreaterThan(answerIndex);
		expect(entryIndex).toBeGreaterThan(boundaryIndex);
	});

	test("keeps displayed extension entries inside unresolved tool turns during replay", () => {
		const context = createContext();
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const toolMessage = createAssistantMessage(
			[{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { path: "README.md" } }],
			"toolUse",
		);

		renderSessionItems.call(context, [toolMessage, createCustomEntry(), createToolResult()]);

		const groupIndex = context.chatContainer.children.findIndex((child) => child instanceof ToolGroupComponent);
		const entryIndex = context.chatContainer.children.findIndex((child) => child instanceof CustomEntryComponent);
		const boundaryIndex = context.chatContainer.children.findIndex((child) => child instanceof DynamicBorder);
		expect(groupIndex).toBeGreaterThanOrEqual(0);
		expect(entryIndex).toBeGreaterThan(groupIndex);
		expect(boundaryIndex).toBeGreaterThan(entryIndex);
	});

	test("breaks a pending user dock before a live extension entry", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const emptyAssistantMessage = createAssistantMessage([], "pending");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: emptyAssistantMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "assistant"]);
		expect(context.pendingUserDock).toBeUndefined();
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), emptyAssistantMessage]);
		expect(getTranscriptTopology(replayContext).slice(0, 3)).toEqual(getTranscriptTopology(context));
	});

	test("moves a visible live response behind an extension entry", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const assistantMessage = createAssistantMessage([{ type: "text", text: "visible response" }], "pending");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: assistantMessage });
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(true);
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "spacer", "assistant"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
		expect(renderChat(context)).not.toContain(`${getGlyphs().branch}${getGlyphs().separator} Diffex`);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), assistantMessage]);
		expect(getTranscriptTopology(replayContext).slice(0, 4)).toEqual(getTranscriptTopology(context));
	});

	test("does not duplicate extension spacing after a warning", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const assistantMessage = createAssistantMessage([{ type: "text", text: "visible response" }], "pending");

		InteractiveMode.prototype.showWarning.call(context as unknown as InteractiveMode, "intervening warning");
		await handleEvent.call(context, { type: "message_start", message: assistantMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });

		const lines = renderChat(context)
			.split("\n")
			.map((line) => line.trimEnd());
		const warningIndex = lines.findIndex((line) => line.includes("Warning: intervening warning"));
		const entryIndex = lines.indexOf("next turn note");
		expect(warningIndex).toBeGreaterThanOrEqual(0);
		expect(entryIndex).toBeGreaterThan(warningIndex);
		expect(lines.slice(warningIndex + 1, entryIndex)).toEqual([""]);
	});

	test("removes extension spacing when a final response becomes empty", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const visibleMessage = createAssistantMessage([{ type: "text", text: "visible response" }], "pending");
		const emptyMessage = createAssistantMessage([], "stop");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: visibleMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });
		await handleEvent.call(context, { type: "message_end", message: emptyMessage });

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "assistant"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), emptyMessage]);
		expect(getTranscriptTopology(replayContext).slice(0, 3)).toEqual(getTranscriptTopology(context));
	});

	test("moves extension spacing after an assistant that becomes tool-only", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const visibleMessage = createAssistantMessage(
			[{ type: "text", text: "I will inspect the file" }, toolCall],
			"pending",
		);
		const toolOnlyMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: visibleMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });
		await handleEvent.call(context, { type: "message_end", message: toolOnlyMessage });

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "assistant", "tools"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.activeToolGroup?.getPathOrigin()).toBe("standalone");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), toolOnlyMessage]);
		expect(getTranscriptTopology(replayContext)).toEqual(getTranscriptTopology(context));
	});

	test("keeps visible assistant and tool paths connected after a live extension entry", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const assistantMessage = createAssistantMessage(
			[{ type: "text", text: "I will inspect the file" }, toolCall],
			"toolUse",
		);

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: assistantMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "spacer", "assistant", "tools"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.activeToolGroup?.getPathOrigin()).toBe("continued");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toContain(` ${getGlyphs().start}`);
		expect(lines).toContain(` ${getGlyphs().branch} Exploring`);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), assistantMessage]);
		expect(getTranscriptTopology(replayContext)).toEqual(getTranscriptTopology(context));
	});

	test("makes a live tool-only path standalone after an extension entry", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "assistant", "tools"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.activeToolGroup?.getPathOrigin()).toBe("standalone");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toContain(` ${getGlyphs().start} Exploring`);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), toolMessage]);
		expect(getTranscriptTopology(replayContext)).toEqual(getTranscriptTopology(context));
	});

	test("keeps late assistant text off the user dock after an extension entry", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolOnlyMessage = createAssistantMessage([toolCall], "toolUse");
		const textAndToolMessage = createAssistantMessage(
			[{ type: "text", text: "I found the relevant file" }, toolCall],
			"toolUse",
		);

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: toolOnlyMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });
		await handleEvent.call(context, {
			type: "message_update",
			message: textAndToolMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "I found the relevant file",
				partial: textAndToolMessage,
			},
		});

		expect(getTranscriptTopology(context)).toEqual(["user", "custom", "spacer", "assistant", "tools"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.activeToolGroup?.getPathOrigin()).toBe("continued");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines.filter((line) => line.startsWith(` ${getGlyphs().start}`))).toHaveLength(1);
		expect(lines).toContain(` ${getGlyphs().branch} Exploring`);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, createCustomEntry(), textAndToolMessage]);
		expect(getTranscriptTopology(replayContext)).toEqual(getTranscriptTopology(context));
	});

	test("toggles thinking without rebuilding an active tool transcript", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toggleThinkingBlockVisibility = (
			InteractiveMode.prototype as unknown as {
				toggleThinkingBlockVisibility: ToggleThinkingBlockVisibility;
			}
		).toggleThinkingBlockVisibility;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const streamingMessage = createAssistantMessage(
			[{ type: "thinking", thinking: "inspect the relevant file" }, toolCall],
			"pending",
		);
		context.session.isStreaming = true;

		await handleEvent.call(context, { type: "message_start", message: streamingMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: streamingMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall,
				partial: streamingMessage,
			},
		});
		const children = [...context.chatContainer.children];
		const assistantComponent = context.streamingComponent;
		const toolGroup = context.activeToolGroup;
		const pendingTool = context.pendingTools.get(TOOL_CALL_ID);

		toggleThinkingBlockVisibility.call(context);

		expect(context.hideThinkingBlock).toBe(true);
		expect(context.chatContainer.children).toEqual(children);
		expect(context.streamingComponent).toBe(assistantComponent);
		expect(context.activeToolGroup).toBe(toolGroup);
		expect(context.pendingTools.get(TOOL_CALL_ID)).toBe(pendingTool);
		expect(renderChat(context)).toContain(`Reasoning ${getGlyphs().bullet} hidden`);
	});

	test("shows failures from tools whose custom renderer hides every row", () => {
		const context = createContext();
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const hiddenToolName = "hidden-error-tool";
		const definition: ToolDefinition = {
			name: hiddenToolName,
			label: "Hidden error tool",
			description: "Renders no transcript rows",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
		};
		context.getRegisteredToolDefinition = (toolName) => (toolName === hiddenToolName ? definition : undefined);
		const failedMessage = createAssistantMessage(
			[{ type: "toolCall", id: "hidden-error-call", name: hiddenToolName, arguments: {} }],
			"error",
		);
		failedMessage.errorMessage = "extension failed";

		renderSessionItems.call(context, [failedMessage]);

		const rendered = renderChat(context);
		expect(rendered).toContain("Hidden error tool");
		expect(rendered).toContain("failed");
	});

	test.each([60, 80])("keeps a two-row live user handoff at %d columns", async (width) => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const emptyAssistantMessage = createAssistantMessage([], "pending");
		const thinkingMessage = createAssistantMessage(
			[{ type: "thinking", thinking: "identify the relevant formula" }],
			"pending",
		);

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: emptyAssistantMessage });
		expect(context.chatContainer.children).toEqual([
			expect.any(UserMessageComponent),
			expect.any(AssistantMessageComponent),
		]);

		await handleEvent.call(context, {
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "identify the relevant formula",
				partial: thinkingMessage,
			},
		});
		await handleEvent.call(context, {
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "",
				partial: thinkingMessage,
			},
		});

		expect(context.chatContainer.children).toEqual([
			expect.any(UserMessageComponent),
			expect.any(DiffexPathDockHinge),
			expect.any(AssistantMessageComponent),
		]);
		expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(1);
		expectUserAssistantGap(context, width, "Reasoning");
		expect(context.clearStatusIndicator).not.toHaveBeenCalled();
	});

	test("preserves extension-controlled working status after visible output", async () => {
		const context = createContext();
		context.workingMessage = "Receiving telemetry";
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const assistantMessage = createAssistantMessage([{ type: "text", text: "signal received" }], "pending");

		await handleEvent.call(context, { type: "message_start", message: assistantMessage });

		expect(context.clearStatusIndicator).not.toHaveBeenCalled();
	});

	test("toggles thinking in place during a docked tool stream", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toggleThinkingBlockVisibility = (
			InteractiveMode.prototype as unknown as {
				toggleThinkingBlockVisibility: ToggleThinkingBlockVisibility;
			}
		).toggleThinkingBlockVisibility;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const streamingMessage = createAssistantMessage(
			[{ type: "thinking", thinking: "inspect the relevant file" }, toolCall],
			"pending",
		);

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: streamingMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: streamingMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall,
				partial: streamingMessage,
			},
		});

		const userComponent = context.chatContainer.children.find(
			(child): child is UserMessageComponent => child instanceof UserMessageComponent,
		);
		const hinge = context.chatContainer.children.find(
			(child): child is DiffexPathDockHinge => child instanceof DiffexPathDockHinge,
		);
		const assistantComponent = context.streamingComponent;
		const toolGroup = context.activeToolGroup;
		const pendingTool = context.pendingTools.get(TOOL_CALL_ID);

		toggleThinkingBlockVisibility.call(context);

		expect(context.hideThinkingBlock).toBe(true);
		expect(context.streamingComponent).toBe(assistantComponent);
		expect(context.activeToolGroup).toBe(toolGroup);
		expect(context.pendingTools.get(TOOL_CALL_ID)).toBe(pendingTool);
		expect(context.chatContainer.children).toContain(userComponent);
		expect(context.chatContainer.children).toContain(assistantComponent);
		expect(context.chatContainer.children).toContain(toolGroup);
		expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toEqual([hinge]);
		expect(renderChat(context)).toContain(`Reasoning ${getGlyphs().bullet} hidden`);
	});

	test("preserves the pending user dock when thinking is toggled before output", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toggleThinkingBlockVisibility = (
			InteractiveMode.prototype as unknown as {
				toggleThinkingBlockVisibility: ToggleThinkingBlockVisibility;
			}
		).toggleThinkingBlockVisibility;
		const emptyAssistantMessage = createAssistantMessage([], "pending");
		const thinkingMessage = createAssistantMessage(
			[{ type: "thinking", thinking: "inspect the relevant file" }],
			"pending",
		);

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: emptyAssistantMessage });
		toggleThinkingBlockVisibility.call(context);
		await handleEvent.call(context, {
			type: "message_update",
			message: thinkingMessage,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "inspect the relevant file",
				partial: thinkingMessage,
			},
		});

		expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(1);
		expect(
			context.chatContainer.children
				.find((child): child is UserMessageComponent => child instanceof UserMessageComponent)
				?.isDocked(),
		).toBe(true);
	});

	test("preserves the pending user dock when thinking is toggled before message start", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toggleThinkingBlockVisibility = (
			InteractiveMode.prototype as unknown as {
				toggleThinkingBlockVisibility: ToggleThinkingBlockVisibility;
			}
		).toggleThinkingBlockVisibility;
		const thinkingMessage = createAssistantMessage(
			[{ type: "thinking", thinking: "inspect the relevant file" }],
			"pending",
		);

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		context.session.isStreaming = true;
		toggleThinkingBlockVisibility.call(context);
		await handleEvent.call(context, { type: "message_start", message: thinkingMessage });

		expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(1);
		expect(
			context.chatContainer.children
				.find((child): child is UserMessageComponent => child instanceof UserMessageComponent)
				?.isDocked(),
		).toBe(true);
	});

	test("preserves an extension-controlled working signal for a tool-only response", async () => {
		const context = createContext();
		context.workingIndicatorOptions = { frames: ["*"] };
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");

		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: toolMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolMessage,
			},
		});

		expect(context.clearStatusIndicator).not.toHaveBeenCalled();
	});

	test("registers tools from a settled assistant start without an update event", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const settledMessage = createAssistantMessage(
			[{ type: "text", text: "I will inspect the file" }, toolCall],
			"toolUse",
		);

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: settledMessage });
		await handleEvent.call(context, { type: "message_end", message: settledMessage });
		await handleEvent.call(context, {
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			args: { path: "README.md" },
		});

		expect(context.activeToolGroup?.getPathOrigin()).toBe("continued");
		expect(context.pendingTools.has(TOOL_CALL_ID)).toBe(true);
		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines.filter((line) => line.startsWith(` ${getGlyphs().start}`))).toHaveLength(1);
	});

	test("registers a tool added by a final assistant replacement", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const initialMessage = createAssistantMessage([{ type: "text", text: "I will inspect the file" }], "pending");
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const replacementMessage = createAssistantMessage(
			[{ type: "text", text: "I will inspect the file" }, toolCall],
			"toolUse",
		);

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: initialMessage });
		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		expect(context.activeToolGroup?.getPathOrigin()).toBe("continued");
		expect(context.pendingTools.has(TOOL_CALL_ID)).toBe(true);
	});

	test("removes a streamed tool omitted by a final assistant replacement", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const streamedMessage = createAssistantMessage(
			[{ type: "text", text: "I may inspect the file" }, toolCall],
			"pending",
		);
		const replacementMessage = createAssistantMessage([{ type: "text", text: "No tool is needed" }], "stop");

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: streamedMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: streamedMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall,
				partial: streamedMessage,
			},
		});
		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		expect(context.activeToolGroup).toBeUndefined();
		expect(context.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(context.chatContainer.children.some((child) => child instanceof ToolGroupComponent)).toBe(false);
		expect(renderChat(context)).not.toContain("Exploring");
	});

	test("replaces a streamed tool when the final message changes its name", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const renderReplacementCall = vi.fn(() => new Text("Search", 0, 0));
		const replacementDefinition: ToolDefinition = {
			name: "search",
			label: "Search",
			description: "Search the workspace",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderCall: renderReplacementCall,
		};
		context.getRegisteredToolDefinition = (toolName) =>
			toolName === replacementDefinition.name ? replacementDefinition : undefined;
		const streamedTool = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: "inspect",
			arguments: { path: "README.md" },
		};
		const replacementTool = {
			...streamedTool,
			name: "search",
			arguments: { query: "Diffex" },
		};
		const streamedMessage = createAssistantMessage([streamedTool], "pending");
		const replacementMessage = createAssistantMessage([replacementTool], "toolUse");

		await handleEvent.call(context, { type: "message_start", message: streamedMessage });
		const initialComponent = context.pendingTools.get(TOOL_CALL_ID);
		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		const replacementComponent = context.pendingTools.get(TOOL_CALL_ID);
		expect(replacementComponent).not.toBe(initialComponent);
		expect(replacementComponent?.matchesToolCall(TOOL_CALL_ID, "search")).toBe(true);
		// Constructor rendering, shared display settings, and final args completion each render once.
		expect(renderReplacementCall).toHaveBeenCalledTimes(3);
		expect(renderChat(context)).toContain("Search");
		expect(renderChat(context)).not.toContain("Inspect");

		await handleEvent.call(context, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: "inspect",
			result: createToolResult(),
			isError: false,
		});
		expect(context.pendingTools.get(TOOL_CALL_ID)).toBe(replacementComponent);
	});

	test("reorders streamed tools to match the final assistant message", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const firstTool = {
			type: "toolCall" as const,
			id: "first-tool",
			name: "first_tool",
			arguments: {},
		};
		const secondTool = {
			type: "toolCall" as const,
			id: "second-tool",
			name: "second_tool",
			arguments: {},
		};
		const streamedMessage = createAssistantMessage([firstTool, secondTool], "pending");
		const replacementMessage = createAssistantMessage([secondTool, firstTool], "toolUse");

		await handleEvent.call(context, { type: "message_start", message: streamedMessage });
		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		const rendered = renderChat(context);
		expect(rendered.indexOf("Second tool")).toBeLessThan(rendered.indexOf("First tool"));
	});

	test("removes a user hinge when the final response becomes empty", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const streamedMessage = createAssistantMessage([{ type: "text", text: "temporary response" }], "pending");
		const replacementMessage = createAssistantMessage([], "stop");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: streamedMessage });
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(true);

		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		expect(getTranscriptTopology(context)).toEqual(["user", "assistant"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.pendingUserDock).toBeUndefined();
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
	});

	test("transfers a user dock to a newly introduced final tool group", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const streamedMessage = createAssistantMessage([{ type: "text", text: "temporary response" }], "pending");
		const replacementMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: streamedMessage });
		expect(context.activeToolGroup).toBeUndefined();
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(true);

		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		expect(getTranscriptTopology(context)).toEqual(["user", "assistant", "tools"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(true);
		expect(context.activeToolGroup?.getPathOrigin()).toBe("user-dock");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);

		const replayContext = createContext();
		useTranscriptMessageRendering(replayContext);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(replayContext, [userMessage, replacementMessage]);
		expect(getTranscriptTopology(replayContext)).toEqual(getTranscriptTopology(context));
	});

	test("returns a final tool-only replacement to the user dock", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const streamedMessage = createAssistantMessage(
			[{ type: "text", text: "I will inspect the file" }, toolCall],
			"pending",
		);
		const replacementMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: streamedMessage });
		expect(context.activeToolGroup?.getPathOrigin()).toBe("continued");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(true);

		await handleEvent.call(context, { type: "message_end", message: replacementMessage });

		expect(context.activeToolGroup?.getPathOrigin()).toBe("user-dock");
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines.filter((line) => line.startsWith(` ${getGlyphs().start}`))).toHaveLength(1);
		expect(lines).not.toContain(` ${getGlyphs().branch} Diffex`);
	});

	test.each([60, 80])("replays the two-row user handoff at %d columns", (width) => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const assistantMessage = createAssistantMessage(
			[{ type: "thinking", thinking: "identify the relevant formula" }],
			"stop",
		);

		addMessageToChat.call(context, userMessage);
		addMessageToChat.call(context, assistantMessage);

		expect(context.chatContainer.children).toEqual([
			expect.any(UserMessageComponent),
			expect.any(DiffexPathDockHinge),
			expect.any(AssistantMessageComponent),
		]);
		expectUserAssistantGap(context, width, "Reasoning");
	});

	test("does not double-space a replayed tool-only turn", () => {
		const context = createContext();
		useTranscriptMessageRendering(context);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolMessage = createAssistantMessage(
			[{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { path: "README.md" } }],
			"toolUse",
		);

		renderSessionItems.call(context, [userMessage, toolMessage, createToolResult()]);

		const userIndex = context.chatContainer.children.findIndex((child) => child instanceof UserMessageComponent);
		const toolGroupIndex = context.chatContainer.children.findIndex((child) => child instanceof ToolGroupComponent);
		const transitionChildren = context.chatContainer.children.slice(userIndex + 1, toolGroupIndex);
		expect(transitionChildren.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(0);
		expect(transitionChildren.filter((child) => child instanceof Spacer)).toHaveLength(0);
		expect(transitionChildren.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(1);
		expect((context.chatContainer.children[userIndex] as UserMessageComponent).isDocked()).toBe(true);
	});

	test("uses one boundary gap between consecutive replayed tool-only turns", () => {
		const context = createContext();
		useTranscriptMessageRendering(context);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const secondToolCallId = "tool-transcript-second";
		const firstToolMessage = createAssistantMessage(
			[{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { path: "README.md" } }],
			"toolUse",
		);
		const secondToolMessage = createAssistantMessage(
			[{ type: "toolCall", id: secondToolCallId, name: TOOL_NAME, arguments: { path: "package.json" } }],
			"toolUse",
		);
		const secondToolResult: ToolResultMessage = {
			...createToolResult(),
			toolCallId: secondToolCallId,
		};

		renderSessionItems.call(context, [firstToolMessage, createToolResult(), secondToolMessage, secondToolResult]);

		const width = 80;
		const lines = context.chatContainer.render(width).map((line) => stripAnsi(line).trimEnd());
		const boundaryIndex = lines.indexOf(renderTranscriptBoundary(width));
		const secondGroupIndex = lines.findIndex((line, index) => index > boundaryIndex && line.includes("Explored"));
		expect(boundaryIndex).toBeGreaterThanOrEqual(0);
		expect(secondGroupIndex).toBeGreaterThan(boundaryIndex);
		expect(lines.slice(boundaryIndex + 1, secondGroupIndex)).toEqual([""]);
	});

	test("replays a truncated tool-only response as one connected path", () => {
		const context = createContext();
		useTranscriptMessageRendering(context);
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const truncatedMessage = createAssistantMessage(
			[{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { path: "README.md" } }],
			"length",
		);

		renderSessionItems.call(context, [userMessage, truncatedMessage, createToolResult()]);

		expectConnectedTruncationPath(context);
	});

	test("docks a live tool-only response through its empty assistant placeholder", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: toolMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolMessage,
			},
		});

		expect(context.chatContainer.children).toEqual([
			expect.any(UserMessageComponent),
			expect.any(AssistantMessageComponent),
			expect.any(ToolGroupComponent),
		]);
		expect(context.clearStatusIndicator).not.toHaveBeenCalled();
		const rendered = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(rendered).toContain(` ${getGlyphs().branch} Exploring`);

		await handleEvent.call(context, { type: "agent_end", messages: [toolMessage], willRetry: false });

		expect(context.clearStatusIndicator).toHaveBeenCalledOnce();
		expect(context.clearStatusIndicator).toHaveBeenCalledWith("working");
	});

	test("restores a user dock when text follows an empty cumulative tool update", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "pending");
		const emptyMessage = createAssistantMessage([], "pending");
		const textMessage = createAssistantMessage([{ type: "text", text: "The file is ready" }], "pending");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: emptyMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: emptyMessage },
		});

		expect(getTranscriptTopology(context)).toEqual(["user", "assistant"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(false);
		expect(context.pendingUserDock).toBe(context.chatContainer.children[0]);

		await handleEvent.call(context, {
			type: "message_update",
			message: textMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "The file is ready",
				partial: textMessage,
			},
		});

		expect(getTranscriptTopology(context)).toEqual(["user", "hinge", "assistant"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(true);
		expect(context.pendingUserDock).toBeUndefined();
	});

	test("restores a user dock when tools follow an empty cumulative tool update", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "pending");
		const emptyMessage = createAssistantMessage([], "pending");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: emptyMessage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: emptyMessage },
		});
		await handleEvent.call(context, {
			type: "message_update",
			message: toolMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolMessage,
			},
		});

		expect(getTranscriptTopology(context)).toEqual(["user", "assistant", "tools"]);
		expect((context.chatContainer.children[0] as UserMessageComponent).isDocked()).toBe(true);
		expect(context.pendingUserDock).toBeUndefined();
		expect(context.activeToolGroup?.getPathOrigin()).toBe("user-dock");
	});

	test("keeps a live truncated tool-only response on its user path", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const pendingMessage = createAssistantMessage([toolCall], "pending");
		const truncatedMessage = createAssistantMessage([toolCall], "length");

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: pendingMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: pendingMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: pendingMessage,
			},
		});
		await handleEvent.call(context, { type: "message_end", message: truncatedMessage });

		expectConnectedTruncationPath(context);
	});

	test.each([60, 80])("does not show an orphan hinge for a hidden tool group at %d columns", async (width) => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const hiddenToolName = "hidden-transcript-tool";
		const definition: ToolDefinition = {
			name: hiddenToolName,
			label: "Hidden transcript tool",
			description: "Renders no transcript rows",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
		};
		context.getRegisteredToolDefinition = (toolName) => (toolName === hiddenToolName ? definition : undefined);
		const toolCall = {
			type: "toolCall" as const,
			id: "hidden-transcript-call",
			name: hiddenToolName,
			arguments: {},
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: toolMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolMessage,
			},
		});

		expect(context.activeToolGroup?.render(width)).toEqual([]);
		expect(context.chatContainer.children.some((child) => child instanceof DiffexPathDockHinge)).toBe(false);
		expect(stripAnsi(context.chatContainer.render(width).join("\n"))).not.toContain("Exploring");
	});

	test("does not leave an external gap for a hidden standalone tool group", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const hiddenToolName = "hidden-standalone-tool";
		const definition: ToolDefinition = {
			name: hiddenToolName,
			label: "Hidden standalone tool",
			description: "Renders no transcript rows",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
		};
		context.getRegisteredToolDefinition = (toolName) => (toolName === hiddenToolName ? definition : undefined);
		const toolCall = {
			type: "toolCall" as const,
			id: "hidden-standalone-call",
			name: hiddenToolName,
			arguments: {},
		};

		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });
		await handleEvent.call(context, {
			type: "message_start",
			message: createAssistantMessage([toolCall], "toolUse"),
		});

		expect(getTranscriptTopology(context)).toEqual(["custom", "assistant", "tools"]);
		expect(context.activeToolGroup?.getPathOrigin()).toBe("standalone");
		expect(context.activeToolGroup?.render(80)).toEqual([]);
		expect(stripAnsi(context.chatContainer.render(80).join("\n"))).not.toContain("Exploring");
	});

	test("keeps a late assistant text block on the tool-first user path", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolOnlyMessage = createAssistantMessage([toolCall], "toolUse");
		const textAndToolMessage = createAssistantMessage(
			[{ type: "text", text: "I found the relevant file" }, toolCall],
			"toolUse",
		);

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: toolOnlyMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: toolOnlyMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolOnlyMessage,
			},
		});
		await handleEvent.call(context, {
			type: "message_update",
			message: textAndToolMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "I found the relevant file",
				partial: textAndToolMessage,
			},
		});

		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		const pathStarts = lines.filter((line) => line.startsWith(` ${getGlyphs().start}`));
		expect(pathStarts).toHaveLength(1);
		expect(lines).toContain(` ${getGlyphs().branch}`);
		expect(lines).toContain(` ${getGlyphs().branch} Exploring`);
	});

	test("does not reconnect a response path across an intervening warning", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");

		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, {
			type: "message_update",
			message: toolMessage,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: toolMessage,
			},
		});
		await handleEvent.call(context, { type: "message_end", message: toolMessage });
		const toolGroup = context.activeToolGroup;

		InteractiveMode.prototype.showWarning.call(context as unknown as InteractiveMode, "intervening notice");
		const lateAssistant = createAssistantMessage([{ type: "text", text: "separate response" }], "pending");
		await handleEvent.call(context, { type: "message_start", message: lateAssistant });

		expect(toolGroup?.getPathOrigin()).toBe("user-dock");
		const rendered = renderChat(context);
		const lines = rendered.split("\n").map((line) => line.trimEnd());
		expect(rendered.indexOf("intervening notice")).toBeLessThan(rendered.indexOf("separate response"));
		expect(lines).toContain(` ${getGlyphs().start}`);
		expect(lines).not.toContain(` ${getGlyphs().branch}`);
	});

	test("reuses an existing transcript boundary spacer", () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		context.chatContainer.addChild(new DynamicBorder());
		context.chatContainer.addChild(new Spacer(1));

		addMessageToChat.call(
			context,
			createAssistantMessage([{ type: "text", text: "answer after the boundary" }], "stop"),
		);

		expect(context.chatContainer.children).toEqual([
			expect.any(DynamicBorder),
			expect.any(Spacer),
			expect.any(AssistantMessageComponent),
		]);
	});

	test("does not dock an assistant response across a transcript boundary", async () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const userMessage: AgentMessage = {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		};
		const assistantMessage = createAssistantMessage([{ type: "text", text: "separate response" }], "stop");

		addMessageToChat.call(context, userMessage);
		await handleEvent.call(context, { type: "turn_end", message: assistantMessage, toolResults: [] });
		await handleEvent.call(context, { type: "turn_start" });
		addMessageToChat.call(context, assistantMessage);

		const userComponent = context.chatContainer.children.find(
			(child): child is UserMessageComponent => child instanceof UserMessageComponent,
		);
		expect(userComponent?.isDocked()).toBe(false);
		expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(0);
		expect(context.chatContainer.children.filter((child) => child instanceof DynamicBorder)).toHaveLength(1);
	});

	test("does not dock an assistant response across an intervening warning", () => {
		const context = createContext();
		const addMessageToChat = useTranscriptMessageRendering(context);
		addMessageToChat.call(context, {
			role: "user",
			content: "explain the theorem",
			timestamp: Date.now(),
		});

		InteractiveMode.prototype.showWarning.call(context as unknown as InteractiveMode, "intervening notice");
		addMessageToChat.call(context, createAssistantMessage([{ type: "text", text: "separate response" }], "stop"));

		expect(context.chatContainer.children.filter((child) => child instanceof DiffexPathDockHinge)).toHaveLength(0);
		const rendered = renderChat(context);
		expect(rendered.indexOf("intervening notice")).toBeLessThan(rendered.indexOf("separate response"));
	});

	test("reuses a boundary gap when a visible live response becomes tool-only", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const firstMessage = createAssistantMessage([{ type: "text", text: "first response" }], "stop");
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const visibleToolMessage = createAssistantMessage(
			[{ type: "text", text: "temporary response" }, toolCall],
			"pending",
		);
		const toolOnlyMessage = createAssistantMessage([toolCall], "toolUse");

		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: firstMessage });
		await handleEvent.call(context, { type: "message_end", message: firstMessage });
		await handleEvent.call(context, { type: "turn_end", message: firstMessage, toolResults: [] });
		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: visibleToolMessage });
		await handleEvent.call(context, { type: "message_end", message: toolOnlyMessage });

		const width = 80;
		const lines = context.chatContainer.render(width).map((line) => stripAnsi(line).trimEnd());
		const boundaryIndex = lines.indexOf(renderTranscriptBoundary(width));
		const secondGroupIndex = lines.findIndex((line, index) => index > boundaryIndex && line.includes("Exploring"));
		expect(boundaryIndex).toBeGreaterThanOrEqual(0);
		expect(secondGroupIndex).toBeGreaterThan(boundaryIndex);
		expect(lines.slice(boundaryIndex + 1, secondGroupIndex)).toEqual([""]);
	});

	test("uses one boundary gap before a consecutive live tool-only turn", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const firstToolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const secondToolCall = {
			type: "toolCall" as const,
			id: "tool-transcript-second",
			name: TOOL_NAME,
			arguments: { path: "package.json" },
		};
		const firstToolMessage = createAssistantMessage([firstToolCall], "toolUse");
		const secondToolMessage = createAssistantMessage([secondToolCall], "toolUse");

		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: firstToolMessage });
		await handleEvent.call(context, { type: "message_end", message: firstToolMessage });
		await handleEvent.call(context, { type: "turn_end", message: firstToolMessage, toolResults: [] });
		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: secondToolMessage });

		const width = 80;
		const lines = context.chatContainer.render(width).map((line) => stripAnsi(line).trimEnd());
		const boundaryIndex = lines.indexOf(renderTranscriptBoundary(width));
		const secondGroupIndex = lines.findIndex((line, index) => index > boundaryIndex && line.includes("Exploring"));
		expect(boundaryIndex).toBeGreaterThanOrEqual(0);
		expect(secondGroupIndex).toBeGreaterThan(boundaryIndex);
		expect(lines.slice(boundaryIndex + 1, secondGroupIndex)).toEqual([""]);
	});

	test("owns a new gap when an extension entry interrupts a boundary-reusing tool group", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const firstMessage = createAssistantMessage([{ type: "text", text: "first response" }], "stop");
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");

		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: firstMessage });
		await handleEvent.call(context, { type: "message_end", message: firstMessage });
		await handleEvent.call(context, { type: "turn_end", message: firstMessage, toolResults: [] });
		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		await handleEvent.call(context, { type: "entry_appended", entry: createCustomEntry() });

		const lines = context.chatContainer.render(80).map((line) => stripAnsi(line).trimEnd());
		const entryIndex = lines.indexOf("next turn note");
		const groupIndex = lines.findIndex((line, index) => index > entryIndex && line.includes("Exploring"));
		expect(entryIndex).toBeGreaterThanOrEqual(0);
		expect(groupIndex).toBeGreaterThan(entryIndex);
		expect(lines.slice(entryIndex + 1, groupIndex)).toEqual([""]);
	});

	test("groups cumulative live tool updates and sections model turns", async () => {
		const context = createContext();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const toolCall = {
			type: "toolCall" as const,
			id: TOOL_CALL_ID,
			name: TOOL_NAME,
			arguments: { path: "README.md" },
		};
		const toolMessage = createAssistantMessage([toolCall], "toolUse");
		const toolResult = createToolResult();
		const finalMessage = createAssistantMessage([{ type: "text", text: "final answer" }], "stop");
		finalMessage.usage = { ...EMPTY_USAGE, input: 12, output: 3, totalTokens: 15 };
		context.agentResponseStartMs = Date.now() - 100;

		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: toolMessage });
		for (let index = 0; index < 2; index++) {
			await handleEvent.call(context, {
				type: "message_update",
				message: toolMessage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall,
					partial: toolMessage,
				},
			});
		}
		await handleEvent.call(context, { type: "message_end", message: toolMessage });
		await handleEvent.call(context, {
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			args: { path: "README.md" },
		});
		await handleEvent.call(context, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: toolResult,
			isError: false,
		});
		await handleEvent.call(context, { type: "turn_end", message: toolMessage, toolResults: [toolResult] });
		await handleEvent.call(context, { type: "turn_start" });
		await handleEvent.call(context, { type: "message_start", message: finalMessage });
		await handleEvent.call(context, { type: "message_end", message: finalMessage });
		await handleEvent.call(context, { type: "turn_end", message: finalMessage, toolResults: [] });
		await handleEvent.call(context, {
			type: "agent_end",
			messages: [toolMessage, toolResult, finalMessage],
			willRetry: false,
		});

		expect(context.chatContainer.children.filter((child) => child instanceof ToolGroupComponent)).toHaveLength(1);
		expect(context.chatContainer.children.filter((child) => child instanceof ToolExecutionComponent)).toHaveLength(0);
		expect(context.chatContainer.children.filter((child) => child instanceof DynamicBorder)).toHaveLength(2);
		const rendered = renderChat(context);
		expect(rendered.match(/Inspect/g)).toHaveLength(1);
		expect(rendered.indexOf("Explored")).toBeLessThan(rendered.indexOf("final answer"));
		expect(rendered.indexOf("input tokens: 12")).toBeLessThan(rendered.lastIndexOf(getGlyphs().separator.repeat(4)));
	});

	test("replays the same tool and answer section boundaries", () => {
		const context = createContext();
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const toolMessage = createAssistantMessage(
			[{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { path: "README.md" } }],
			"toolUse",
		);
		const finalMessage = createAssistantMessage([{ type: "text", text: "final answer" }], "stop");

		renderSessionItems.call(context, [toolMessage, createToolResult(), finalMessage]);

		expect(context.pendingTools.size).toBe(0);
		expect(context.chatContainer.children.filter((child) => child instanceof ToolGroupComponent)).toHaveLength(1);
		expect(context.chatContainer.children.filter((child) => child instanceof DynamicBorder)).toHaveLength(2);
		const rendered = renderChat(context);
		expect(rendered.indexOf("Explored")).toBeLessThan(rendered.indexOf("final answer"));
	});
});
