import { setKeybindings, visibleWidth } from "@diffexai/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SkillReference } from "../src/core/skills.ts";
import { SkillSelectorComponent } from "../src/modes/interactive/components/skill-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const references: SkillReference[] = [
	{
		skillId: `skill:${"a".repeat(64)}`,
		version: `sha256:${"1".repeat(64)}`,
		contentDigest: `sha256:${"1".repeat(64)}`,
		name: "workflow-evolved",
		description: "General workflow",
		sourceKind: "evolved",
		scope: "workspace",
		reference: "<first/>",
		group: "evolved-workspace",
		enabled: true,
	},
	{
		skillId: `skill:${"b".repeat(64)}`,
		version: `sha256:${"2".repeat(64)}`,
		contentDigest: `sha256:${"2".repeat(64)}`,
		name: "deploy",
		description: "Special deployment workflow",
		sourceKind: "installed",
		scope: "workspace",
		reference: "<second/>",
		group: "installed-workspace",
		enabled: true,
	},
	{
		skillId: `skill:${"c".repeat(64)}`,
		version: `sha256:${"3".repeat(64)}`,
		contentDigest: `sha256:${"3".repeat(64)}`,
		name: "review",
		description: "Review code changes",
		sourceKind: "installed",
		scope: "global",
		reference: "<third/>",
		group: "installed-global",
		enabled: true,
	},
];

describe("SkillSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("opens with skill source categories instead of individual skill commands", () => {
		const selector = new SkillSelectorComponent(
			references,
			() => {},
			() => {},
			() => {},
		);
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Installed Workspace Skills");
		expect(output).toContain("Installed Global Skills");
		expect(output).toContain("Evolved Skills");
		expect(output).not.toContain("Special deployment workflow");
		expect(output).not.toContain("Review code changes");
	});

	it("opens a category and filters its skills by name or description", () => {
		const selector = new SkillSelectorComponent(
			references,
			() => {},
			() => {},
			() => {},
		);

		selector.handleInput("\r");
		selector.handleInput("deployment");
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Installed Workspace Skills");
		expect(output).toContain("deploy");
		expect(output).toContain("Special deployment workflow");
		expect(output).not.toContain("Review code changes");
	});

	it("returns to the category menu before cancelling", () => {
		const onCancel = vi.fn();
		const selector = new SkillSelectorComponent(
			references,
			() => {},
			() => {},
			onCancel,
		);

		selector.handleInput("\r");
		selector.handleInput("\u001b");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Choose where the skill is installed");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("\u001b");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("toggles skill enablement without changing Enter reference behavior", () => {
		const onSelect = vi.fn();
		const onToggle = vi.fn();
		const selector = new SkillSelectorComponent(references, onSelect, onToggle, () => {});

		selector.handleInput("\r");
		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("[x] deploy");
		expect(output).not.toContain("✓");

		selector.handleInput(" ");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("[] deploy");
		expect(output).not.toContain("✓");
		expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ name: "deploy" }), false);

		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith([expect.objectContaining({ name: "deploy", enabled: false })]);
	});

	it("inserts the current skill on Enter", () => {
		const onSelect = vi.fn();
		const selector = new SkillSelectorComponent(
			references,
			onSelect,
			() => {},
			() => {},
		);

		selector.handleInput("\u001b[B");
		selector.handleInput("\r");
		selector.handleInput("review");
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith([references[2]]);
	});

	it("propagates focus to search only inside a category", () => {
		const selector = new SkillSelectorComponent(
			references,
			() => {},
			() => {},
			() => {},
		);

		selector.focused = true;
		expect(selector.getSearchInput().focused).toBe(false);
		selector.handleInput("\r");
		expect(selector.getSearchInput().focused).toBe(true);
	});

	it("fits category and skill views in a standard terminal", () => {
		const manyReferences = Array.from(
			{ length: 12 },
			(_, index): SkillReference => ({
				skillId: `skill:${String(index).padStart(64, "0")}`,
				version: `sha256:${String(index).padStart(64, "1")}`,
				contentDigest: `sha256:${String(index).padStart(64, "1")}`,
				name: `skill-${index}`,
				description: `Description for skill ${index}`,
				sourceKind: "installed",
				scope: "workspace",
				reference: `<reference-${index}/>`,
				group: "installed-workspace",
				enabled: true,
			}),
		);
		const selector = new SkillSelectorComponent(
			manyReferences,
			() => {},
			() => {},
			() => {},
		);

		expect(selector.render(80).every((line) => visibleWidth(line) <= 80)).toBe(true);
		selector.handleInput("\r");
		const lines = selector.render(80);
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("renders an empty search result without applying", () => {
		const onSelect = vi.fn();
		const selector = new SkillSelectorComponent(
			references,
			onSelect,
			() => {},
			() => {},
		);

		selector.handleInput("\r");
		selector.handleInput("missing");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("No matching skills");
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
	});
});
