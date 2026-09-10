import { getGlyphs, setKeybindings, visibleWidth } from "@diffexai/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("marks the saved trusted decision", () => {
		const selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: { path: "/project", decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Saved decision: trusted (/project)");
		expect(output).toContain("Current session: trusted");
		expect(output).toContain(`${getGlyphs().selected} Trust ✓`);
		expect(output).not.toContain("→");
		expect(output).toContain("Trust ✓");
		expect(output).not.toContain("Do not trust ✓");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: "/project", decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const selector = new TrustSelectorComponent({
			cwd: "/parent/project/nested",
			savedDecision: { path: "/parent", decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Saved decision: trusted (inherited from /parent)");
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: "/parent/project",
			savedDecision: { path: "/parent", decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Saved decision: trusted (inherited from /parent)");
		expect(output).toContain("Trust parent folder (/parent) ✓");

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: "/parent", decision: true },
				{ path: "/parent/project", decision: null },
			],
		});
	});

	it("preserves trust context, choices, and controls at 60x12", () => {
		const selector = new TrustSelectorComponent({
			cwd: "/parent/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect: () => {},
			onCancel: () => {},
			getViewportRows: () => 12,
		});

		const lines = stripAnsi(selector.render(60).join("\n")).split("\n");

		expect(lines[0]).toContain("Project trust");
		expect(lines[1]).toContain("/parent/project");
		expect(lines.join("\n")).toContain("Saved decision: none");
		expect(lines.join("\n")).toContain("Current session: untrusted");
		expect(lines.join("\n")).toContain("Trust parent folder (/parent)");
		expect(lines.join("\n")).toContain("Do not trust");
		expect(lines.at(-1)).toContain("navigate");
		expect(lines.at(-1)).toContain("save");
		expect(lines.at(-1)).toContain("cancel");
		expect(lines).toHaveLength(8);
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
	});
});
