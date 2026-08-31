import { Container, getGlyphs, Markdown, type MarkdownTheme, Text } from "@earendil-works/diffex-tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 */
export class BranchSummaryMessageComponent extends Container {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
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
		const label = theme.fg("customMessageLabel", `${glyphs.branch} ${theme.bold("Branch summary")}`);

		if (this.expanded) {
			this.addChild(new Text(`${label}${theme.fg("dim", ` ${glyphs.bullet} expanded`)}`, 1, 0));
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
				new Text(`${label}${theme.fg("dim", ` ${glyphs.bullet} ${keyText("app.tools.expand")} expand`)}`, 1, 0),
			);
		}
	}
}
