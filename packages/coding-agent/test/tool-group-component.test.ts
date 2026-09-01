import { getGlyphs, Text, type TUI, visibleWidth } from "@earendil-works/diffex-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createTool(id: string, label: string): ToolExecutionComponent {
	const definition: ToolDefinition = {
		name: id,
		label,
		description: label,
		parameters: Type.Any(),
		execute: async () => ({ content: [], details: {} }),
		renderCall: () => new Text(`${label} details`, 0, 0),
	};
	return new ToolExecutionComponent(id, id, {}, {}, definition, createFakeTui(), process.cwd());
}

describe("ToolGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("groups tools in source order with one lifecycle header", () => {
		const glyphs = getGlyphs();
		const group = new ToolGroupComponent(1);
		const first = createTool("first", "First");
		const second = createTool("second", "Second");

		expect(group.addTool("first", first)).toBe(first);
		expect(group.addTool("second", second)).toBe(second);
		expect(group.addTool("first", createTool("duplicate", "Duplicate"))).toBe(first);

		const active = stripAnsi(group.render(80).join("\n"));
		expect(active).toContain("Exploring");
		expect(active).toContain(glyphs.branch);
		expect(active).toContain(glyphs.end);
		expect(active.indexOf("First")).toBeLessThan(active.indexOf("Second"));
		expect(active).not.toContain("Duplicate");

		group.markSettled();
		const settled = stripAnsi(group.render(80).join("\n"));
		expect(settled).toContain("Explored");
		expect(settled).not.toContain("Exploring");
	});

	test("forwards display settings to existing tool components", () => {
		const group = new ToolGroupComponent();
		const tool = createTool("settings", "Settings");
		const setExpanded = vi.spyOn(tool, "setExpanded");
		const setShowImages = vi.spyOn(tool, "setShowImages");
		const setImageWidthCells = vi.spyOn(tool, "setImageWidthCells");
		group.addTool("settings", tool);

		group.setExpanded(true);
		group.setShowImages(false);
		group.setImageWidthCells(42);

		expect(setExpanded).toHaveBeenCalledWith(true);
		expect(setShowImages).toHaveBeenCalledWith(false);
		expect(setImageWidthCells).toHaveBeenCalledWith(42);
	});

	test.each([1, 2, 20, 80])("stays within a %d-column viewport", (width) => {
		const group = new ToolGroupComponent(1);
		group.addTool("responsive", createTool("responsive", "Responsive tool"));

		for (const line of group.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("hides the group when every tool renders no rows", () => {
		const definition: ToolDefinition = {
			name: "empty",
			label: "Empty",
			description: "empty",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
		};
		const tool = new ToolExecutionComponent("empty", "empty", {}, {}, definition, createFakeTui(), process.cwd());
		const group = new ToolGroupComponent();
		group.addTool("empty", tool);

		expect(group.render(80)).toEqual([]);

		tool.updateResult({
			content: [{ type: "text", text: "extension failed" }],
			isError: true,
		});
		const failed = stripAnsi(group.render(80).join("\n"));
		expect(failed).toContain("Empty");
		expect(failed).toContain("failed");
	});

	test("preserves reserved empty image rows", () => {
		const imageTool = {
			render: () => ["\x1b_Ga=T,f=100;AAAA\x1b\\", "", ""],
			setExpanded: () => {},
			setShowImages: () => {},
			setImageWidthCells: () => {},
		} as unknown as ToolExecutionComponent;
		const group = new ToolGroupComponent();
		group.addTool("image", imageTool);

		const lines = group.render(80);

		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("\x1b_G");
		expect(lines.slice(2)).toEqual(["", ""]);
	});
});
