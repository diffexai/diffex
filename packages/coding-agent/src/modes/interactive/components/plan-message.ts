import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	stripTerminalSequences,
	Text,
} from "@earendil-works/diffex-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { PlanArtifact } from "../../../core/plan-mode.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

/** Renders a submitted plan as a first-class transcript artifact. */
export class PlanMessageComponent extends Container {
	constructor(
		plan: PlanArtifact,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.addChild(new Spacer(1));

		const box = new Box(outputPad, 1, (content) => theme.bg("customMessageBg", content));
		const title = stripTerminalSequences(plan.title).replace(/\s+/gu, " ").trim() || "Untitled plan";
		box.addChild(new Text(theme.bold(theme.fg("customMessageLabel", `Plan: ${title}`)), 0, 0));
		box.addChild(new Spacer(1));
		box.addChild(
			new Markdown(
				plan.markdown,
				0,
				0,
				markdownTheme,
				{ color: (content) => theme.fg("customMessageText", content) },
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("assistant", false, markdownTransformers),
				},
			),
		);
		this.addChild(box);
	}
}
