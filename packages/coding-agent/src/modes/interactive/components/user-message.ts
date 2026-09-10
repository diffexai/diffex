import { Box, Container, getGlyphs, Markdown, type MarkdownTheme, Spacer } from "@diffexai/diffex-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private docked = false;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setDocked(docked: boolean): void {
		if (this.docked === docked) {
			return;
		}
		this.docked = docked;
	}

	isDocked(): boolean {
		return this.docked;
	}

	override invalidate(): void {
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const glyphs = getGlyphs();
		const surface = new Box(this.outputPad, 0, (content) => theme.bg("userMessageBg", content));
		surface.addChild(new Spacer(1));
		surface.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					firstLinePrefix: theme.fg("accent", `${glyphs.selected} `),
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					tableStyle: "compact",
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
		surface.addChild(new Spacer(1));
		this.addChild(surface);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
