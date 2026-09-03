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
		expect(active).toContain(`${glyphs.rail}  First details`);
		expect(active).toContain(`${glyphs.rail}  Second details`);
		expect(active).not.toContain(`${glyphs.rail} ${glyphs.branch}`);
		expect(active).not.toContain(`${glyphs.rail} ${glyphs.end}`);
		expect(active.indexOf("First")).toBeLessThan(active.indexOf("Second"));
		expect(active).not.toContain("Duplicate");

		group.markSettled();
		const settled = stripAnsi(group.render(80).join("\n"));
		expect(settled).toContain("Explored");
		expect(settled).not.toContain("Exploring");
	});

	test("renders a standalone tool group as one open Diffex path", () => {
		const glyphs = getGlyphs();
		const group = new ToolGroupComponent(1);
		group.addTool("single", createTool("single", "Single"));
		const lines = group.render(80).map((line) => stripAnsi(line).trimEnd());

		expect(lines[0]).toBe("");
		expect(lines[1]).toBe(` ${glyphs.start} Exploring`);
		expect(lines[2]?.startsWith(` ${glyphs.rail}  ... Single`)).toBe(true);
		expect(lines[3]).toBe(` ${glyphs.rail}  Single details`);
	});

	test("reuses an existing gap before a standalone tool group", () => {
		const glyphs = getGlyphs();
		const group = new ToolGroupComponent(1, "standalone", { reuseLeadingGap: true });
		group.addTool("single", createTool("single", "Single"));
		const lines = group.render(80).map((line) => stripAnsi(line).trimEnd());

		expect(lines[0]).toBe(` ${glyphs.start} Exploring`);
		expect(lines[1]?.startsWith(` ${glyphs.rail}  ... Single`)).toBe(true);
		expect(lines[2]).toBe(` ${glyphs.rail}  Single details`);
	});

	test("continues an assistant activity rail without adding a blank gap", () => {
		const glyphs = getGlyphs();
		const group = new ToolGroupComponent(1, "continued");
		group.addTool("continued", createTool("continued", "Continued"));
		const lines = group.render(80).map((line) => stripAnsi(line).trimEnd());

		expect(lines[0]).toBe(` ${glyphs.rail}`);
		expect(lines[1]).toBe(` ${glyphs.branch} Exploring`);
		expect(lines[2]?.startsWith(` ${glyphs.rail}  ... Continued`)).toBe(true);
		expect(lines[3]).toBe(` ${glyphs.rail}  Continued details`);
	});

	test("joins a user dock with one owned hinge", () => {
		const glyphs = getGlyphs();
		const group = new ToolGroupComponent(1, "user-dock");
		group.addTool("docked", createTool("docked", "Docked"));
		const lines = group.render(80).map((line) => stripAnsi(line).trimEnd());

		expect(lines[0]).toBe("");
		expect(lines[1]).toBe(` ${glyphs.start}${glyphs.separator.repeat(2)}`);
		expect(lines[2]).toBe(` ${glyphs.branch} Exploring`);
		expect(lines[3]?.startsWith(` ${glyphs.rail}  ... Docked`)).toBe(true);
		expect(lines[4]).toBe(` ${glyphs.rail}  Docked details`);
	});

	test("forwards display settings to existing tool components", () => {
		const group = new ToolGroupComponent(1, "user-dock");
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

	test("replaces and reorders tools to match the final assistant message", () => {
		const group = new ToolGroupComponent(1);
		const first = createTool("first", "First");
		const second = createTool("second", "Second");
		const replacement = createTool("replacement", "Replacement");
		group.addTool("first", first);
		group.addTool("second", second);

		group.replaceTools([
			["second", second],
			["first", replacement],
		]);

		const rendered = stripAnsi(group.render(80).join("\n"));
		expect(rendered.indexOf("Second")).toBeLessThan(rendered.indexOf("Replacement"));
		expect(rendered).not.toContain("First");
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
		const group = new ToolGroupComponent(1, "standalone", { reuseLeadingGap: true });
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

	test("closes a continued path when every tool renders no rows", () => {
		const definition: ToolDefinition = {
			name: "empty-continued",
			label: "Empty continued",
			description: "empty",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
		};
		const tool = new ToolExecutionComponent(
			"empty-continued",
			"empty-continued",
			{},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const group = new ToolGroupComponent(1, "continued");
		group.addTool("empty-continued", tool);

		expect(group.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual([` ${getGlyphs().rail}`]);
		group.markSettled();
		expect(group.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual([` ${getGlyphs().end}`]);
	});

	test("keeps a continued path open until a self-rendered result appears", () => {
		const definition: ToolDefinition = {
			name: "result-only",
			label: "Result only",
			description: "renders only its result",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("result became visible", 0, 0),
		};
		const tool = new ToolExecutionComponent(
			"result-only",
			"result-only",
			{},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const group = new ToolGroupComponent(1, "continued");
		group.addTool("result-only", tool);

		expect(group.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual([` ${getGlyphs().rail}`]);
		tool.updateResult({ content: [{ type: "text", text: "result" }], details: {}, isError: false });
		const visible = stripAnsi(group.render(80).join("\n"));
		expect(visible).toContain("Exploring");
		expect(visible).toContain("result became visible");
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

		expect(lines).toHaveLength(5);
		expect(lines[2]).toContain("\x1b_G");
		expect(lines.slice(3)).toEqual(["", ""]);
	});
});
