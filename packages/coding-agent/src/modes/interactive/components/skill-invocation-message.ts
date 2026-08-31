import { Container, getGlyphs, Markdown, type MarkdownTheme, Text } from "@earendil-works/diffex-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Only renders the skill block itself - user message is rendered separately.
 */
export class SkillInvocationMessageComponent extends Container {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.skillBlock = skillBlock;
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
		const label =
			theme.fg("customMessageLabel", `${glyphs.branch} ${theme.bold("Skill")}`) +
			theme.fg("customMessageText", ` ${glyphs.bullet} ${this.skillBlock.name}`);

		if (this.expanded) {
			this.addChild(new Text(`${label}${theme.fg("dim", ` ${glyphs.bullet} expanded`)}`, 1, 0));
			this.addChild(
				new Markdown(
					this.skillBlock.content,
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
