import { setKeybindings, visibleWidth } from "@earendil-works/diffex-tui";
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
		name: "workflow-Evolved",
		description: "General workflow",
		sourceKind: "evolved",
		scope: "workspace",
		reference: "<first/>",
		group: "evolved-workspace",
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
	},
];

describe("SkillSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("filters by name or description", () => {
		const selector = new SkillSelectorComponent(
			references,
			() => {},
			() => {},
		);

		selector.handleInput("deployment");
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Installed Workspace Skills");
		expect(output).toContain("Special deployment workflow");
		expect(output).not.toContain("Evolved Workspace Skills");
		expect(output).not.toContain("General workflow");
		expect(output).not.toContain("Installed Global Skills");
		expect(output).not.toContain("Review code changes");
	});

	it("renders source groups in source order while preserving order within each group", () => {
		const selector = new SkillSelectorComponent(
			[references[2], references[1], references[0]],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output.indexOf("Evolved Workspace Skills")).toBeLessThan(output.indexOf("Installed Workspace Skills"));
		expect(output.indexOf("Installed Workspace Skills")).toBeLessThan(output.indexOf("Installed Global Skills"));
	});

	it("keeps selections across filters and returns stable identities in selector order", () => {
		const onSelect = vi.fn();
		const selector = new SkillSelectorComponent(references, onSelect, () => {});

		selector.handleInput(" ");
		selector.handleInput("deployment");
		selector.handleInput(" ");
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith([references[0], references[1]]);
	});

	it("inserts the filtered current skill when no items were toggled", () => {
		const onSelect = vi.fn();
		const selector = new SkillSelectorComponent(references, onSelect, () => {});

		selector.handleInput("review");
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith([references[2]]);
	});

	it("cancels without selecting and propagates focus to search", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new SkillSelectorComponent(references, onSelect, onCancel);

		selector.focused = true;
		expect(selector.getSearchInput().focused).toBe(true);
		selector.handleInput("\u001b");

		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("fits the selector and descriptions in a standard terminal", () => {
		const manyReferences = Array.from(
			{ length: 12 },
			(_, index): SkillReference => ({
				skillId: `skill:${String(index).padStart(64, "0")}`,
				version: `sha256:${String(index).padStart(64, "1")}`,
				contentDigest: `sha256:${String(index).padStart(64, "1")}`,
				name: `skill-${index}`,
				description: `Description for skill ${index}`,
				sourceKind: "installed",
				scope: "global",
				reference: `<reference-${index}/>`,
				group: "installed-global",
			}),
		);
		const selector = new SkillSelectorComponent(
			manyReferences,
			() => {},
			() => {},
		);

		const lines = selector.render(80);
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("renders an empty search result without applying", () => {
		const onSelect = vi.fn();
		const selector = new SkillSelectorComponent(references, onSelect, () => {});

		selector.handleInput("missing");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("No matching skills");
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
	});
});
