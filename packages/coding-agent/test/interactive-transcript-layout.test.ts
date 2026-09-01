import type { AgentMessage } from "@earendil-works/diffex-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/diffex-ai";
import { Container, getGlyphs, Text, type TUI } from "@earendil-works/diffex-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-transcript";
const TOOL_NAME = "inspect";

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
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	toolOutputExpanded: boolean;
	agentResponseStartMs: number | undefined;
	session: {
		isStreaming: boolean;
		retryAttempt: number;
		extensionRunner: { getEntryRenderer(customType: string): (() => Text) | undefined };
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	clearStatusIndicator(): void;
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
		streamingComponent: undefined,
		streamingMessage: undefined,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		agentResponseStartMs: undefined,
		session: {
			isStreaming: false,
			retryAttempt: 0,
			extensionRunner: {
				getEntryRenderer: (customType) =>
					customType === "turn-note" ? () => new Text("next turn note", 0, 0) : undefined,
			},
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
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

describe("Interactive transcript layout", () => {
	beforeAll(() => {
		initTheme("dark");
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
		expect(rendered.match(/Inspect .* complete/g)).toHaveLength(1);
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
