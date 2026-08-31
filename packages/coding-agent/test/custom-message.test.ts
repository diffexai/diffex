import { getGlyphs, Text } from "@earendil-works/diffex-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CustomMessageComponent", () => {
	test("renders default custom messages as a compact timeline event", () => {
		initTheme("dark");
		const message: CustomMessage = {
			role: "custom",
			customType: "notice",
			content: "content",
			display: true,
			timestamp: Date.now(),
		};
		const raw = new CustomMessageComponent(message).render(40).join("\n");
		const rendered = stripAnsi(raw);

		expect(rendered).toContain("notice");
		expect(rendered).toContain("content");
		expect(rendered).not.toContain("[notice]");
		expect(raw).not.toContain("\x1b[48");
	});

	test("renders summaries and skills as compact expandable timeline events", () => {
		initTheme("dark");
		const branch = new BranchSummaryMessageComponent({
			role: "branchSummary",
			summary: "Branch details",
			fromId: "entry-1",
			timestamp: Date.now(),
		});
		const compaction = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Compaction details",
			tokensBefore: 12_345,
			timestamp: Date.now(),
		});
		const skill = new SkillInvocationMessageComponent({
			name: "tui-design",
			location: "/tmp/SKILL.md",
			content: "Skill details",
			userMessage: undefined,
		});

		expect(stripAnsi(branch.render(80).join("\n"))).toContain("Branch summary");
		expect(stripAnsi(compaction.render(80).join("\n"))).toContain("Context compacted");
		expect(stripAnsi(compaction.render(80).join("\n"))).toContain("12,345 tokens");
		expect(stripAnsi(skill.render(80).join("\n"))).toContain(`Skill ${getGlyphs().bullet} tui-design`);

		branch.setExpanded(true);
		compaction.setExpanded(true);
		skill.setExpanded(true);
		expect(stripAnsi(branch.render(80).join("\n"))).toContain("Branch details");
		expect(stripAnsi(compaction.render(80).join("\n"))).toContain("Compaction details");
		expect(stripAnsi(skill.render(80).join("\n"))).toContain("Skill details");
	});

	test("renders custom entry renderer failures as explicit text", () => {
		initTheme("dark");
		const component = new CustomEntryComponent(
			{
				type: "custom",
				customType: "timeline",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
			},
			() => {
				throw new Error("renderer exploded");
			},
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain(`timeline ${getGlyphs().bullet} renderer failed`);
		expect(rendered).toContain("renderer exploded");
	});

	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});
});
