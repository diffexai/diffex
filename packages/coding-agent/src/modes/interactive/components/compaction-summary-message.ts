import { Container, getGlyphs, Markdown, type MarkdownTheme, Text } from "@diffexai/diffex-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 */
export class CompactionSummaryMessageComponent extends Container {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const glyphs = getGlyphs();
		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `${glyphs.branch} ${theme.bold("Context compacted")}`);
		const detail = theme.fg("customMessageText", `${tokenStr} tokens`);

		if (this.expanded) {
			this.addChild(new Text(`${label} ${glyphs.bullet} ${detail}`, 1, 0));
			this.addChild(
				new Markdown(
					this.message.summary,
					2,
					0,
					this.markdownTheme,
					{ color: (text: string) => theme.fg("customMessageText", text) },
					{ tableStyle: "compact" },
				),
			);
		} else {
			this.addChild(
				new Text(
					`${label} ${glyphs.bullet} ${detail}${theme.fg("dim", ` ${glyphs.bullet} ${keyText("app.tools.expand")} expand`)}`,
					1,
					0,
				),
			);
		}
	}
}
