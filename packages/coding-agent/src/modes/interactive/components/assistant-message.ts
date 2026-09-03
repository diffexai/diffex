import type { AssistantMessage } from "@earendil-works/diffex-ai";
import { Container, getGlyphs, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/diffex-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import {
	DiffexPathLabel,
	type DiffexPathMarker,
	DiffexPathNode,
	type DiffexPathOrigin,
	DiffexPathRail,
	DiffexPathTerminus,
} from "./diffex-path.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export interface AssistantMessagePathState {
	hasToolCalls: boolean;
	hasVisibleContent: boolean;
	hasTerminalNotice: boolean;
	hasVisibleOutput: boolean;
	continuesPathToTools: boolean;
}

export function getAssistantMessagePathState(message: AssistantMessage): AssistantMessagePathState {
	const hasToolCalls = message.content.some((content) => content.type === "toolCall");
	const hasVisibleContent = message.content.some(
		(content) =>
			(content.type === "text" && Boolean(content.text.trim())) ||
			(content.type === "thinking" && Boolean(content.thinking.trim())),
	);
	const hasTerminalNotice =
		message.stopReason === "length" ||
		(!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error"));
	const hasVisibleOutput = hasVisibleContent || hasTerminalNotice;

	return {
		hasToolCalls,
		hasVisibleContent,
		hasTerminalNotice,
		hasVisibleOutput,
		continuesPathToTools: hasToolCalls && hasVisibleOutput,
	};
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private pathContinuesToTools = false;
	private pathOrigin: Exclude<DiffexPathOrigin, "continued"> = "standalone";
	private visibleOutput = false;
	private isStreaming = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	continuesPathToTools(): boolean {
		return this.pathContinuesToTools;
	}

	containsToolCalls(): boolean {
		return this.hasToolCalls;
	}

	hasVisibleOutput(): boolean {
		return this.visibleOutput;
	}

	setPathOrigin(origin: Exclude<DiffexPathOrigin, "continued">): void {
		if (this.pathOrigin === origin) {
			return;
		}
		this.pathOrigin = origin;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.contentContainer.clear();

		const { hasToolCalls, hasTerminalNotice, hasVisibleOutput, continuesPathToTools } =
			getAssistantMessagePathState(message);
		let lastVisibleContentIndex = -1;
		for (let i = message.content.length - 1; i >= 0; i--) {
			const content = message.content[i];
			if (
				(content?.type === "text" && content.text.trim()) ||
				(content?.type === "thinking" && content.thinking.trim())
			) {
				lastVisibleContentIndex = i;
				break;
			}
		}
		this.hasToolCalls = hasToolCalls;
		this.pathContinuesToTools = continuesPathToTools;
		this.visibleOutput = hasVisibleOutput;
		let hasRenderedPath = false;
		let hasRenderedAnswerBoundary = false;
		let pathClosed = false;
		const firstPathMarker: DiffexPathMarker = this.pathOrigin === "user-dock" ? "branch" : "start";

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				if (!hasRenderedAnswerBoundary) {
					if (hasRenderedPath) {
						this.contentContainer.addChild(new DiffexPathRail(this.outputPad));
					}
					const marker: DiffexPathMarker = hasToolCalls
						? hasRenderedPath
							? "branch"
							: firstPathMarker
						: this.isStreaming
							? hasRenderedPath
								? "branch"
								: firstPathMarker
							: i === lastVisibleContentIndex
								? "end"
								: hasRenderedPath
									? "branch"
									: firstPathMarker;
					this.contentContainer.addChild(
						new DiffexPathNode({
							marker,
							padding: this.outputPad,
							markerColor: (text) => theme.fg("accent", text),
						}),
					);
					pathClosed = marker === "end";
					this.contentContainer.addChild(new Spacer(1));
					hasRenderedAnswerBoundary = true;
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad + 2, 0, this.markdownTheme, undefined, {
						tableStyle: "compact",
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
				hasRenderedPath = true;
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}
				if (hasRenderedPath) {
					this.contentContainer.addChild(new DiffexPathRail(this.outputPad));
				}

				const marker: DiffexPathMarker = hasRenderedPath ? "branch" : firstPathMarker;
				if (this.hideThinkingBlock) {
					const hiddenLabel = this.hiddenThinkingLabel === "Thinking..." ? "hidden" : this.hiddenThinkingLabel;
					this.contentContainer.addChild(
						new DiffexPathLabel(`Reasoning ${getGlyphs().bullet} ${hiddenLabel}`, {
							marker,
							padding: this.outputPad,
							labelColor: (text) => theme.fg("thinkingText", text),
						}),
					);
				} else {
					this.contentContainer.addChild(
						new DiffexPathLabel("Reasoning", {
							marker,
							padding: this.outputPad,
							labelColor: (text) => theme.fg("thinkingText", text),
						}),
					);
					this.contentContainer.addChild(new DiffexPathRail(this.outputPad));
					this.contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad + 2,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								tableStyle: "compact",
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				hasRenderedPath = true;
			}
		}

		if (!this.isStreaming && !hasRenderedAnswerBoundary && hasVisibleOutput && (!hasToolCalls || hasTerminalNotice)) {
			if (hasRenderedPath) {
				this.contentContainer.addChild(new DiffexPathRail(this.outputPad));
			}
			const marker: DiffexPathMarker = continuesPathToTools ? (hasRenderedPath ? "branch" : firstPathMarker) : "end";
			this.contentContainer.addChild(
				new DiffexPathNode({
					marker,
					padding: this.outputPad,
					markerColor: (text) => theme.fg("accent", text),
				}),
			);
			pathClosed = marker === "end";
			hasRenderedAnswerBoundary = true;
		} else if (!this.isStreaming && !hasToolCalls && hasRenderedAnswerBoundary && hasRenderedPath && !pathClosed) {
			this.contentContainer.addChild(new DiffexPathTerminus(this.outputPad));
		}

		if (message.stopReason === "length") {
			if (hasRenderedAnswerBoundary) {
				this.contentContainer.addChild(new Spacer(1));
			}
			this.contentContainer.addChild(
				new Text(theme.fg("warning", "Response was truncated before completion."), this.outputPad + 2, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("warning", abortMessage), this.outputPad + 2, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad + 2, 0));
			}
		}
	}
}
