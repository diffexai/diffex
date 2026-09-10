import { getGlyphs, setKeybindings, TuiMainScreen } from "@diffexai/diffex-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderPlain(component: { render(width: number): string[] }, width = 80): string[] {
	return component.render(width).map((line) => stripAnsi(line));
}

describe("secondary dialogs", () => {
	beforeEach(() => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager());
	});

	it("renders extension input as an open title and input stack", () => {
		const component = new ExtensionInputComponent(
			"Enter a value",
			"type something...",
			() => {},
			() => {},
		);

		const output = renderPlain(component, 40);

		expect(output[0]).toContain("Enter a value");
		expect(output[1]).toBe("");
		expect(output[2]).toMatch(/^> /);
		expect(output.at(-1)).toContain("submit");
		expect(output.some((line) => /^\s*─+\s*$/.test(line))).toBe(false);
	});

	it("preserves extension input submit and cancel callbacks", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new ExtensionInputComponent("Enter a value", undefined, onSubmit, onCancel);

		component.handleInput("answer");
		component.handleInput("\r");
		component.handleInput("\x1b");

		expect(onSubmit).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledWith("answer");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("renders extension editor with one composer boundary", () => {
		const keybindings = new KeybindingsManager();
		const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const component = new ExtensionEditorComponent(
			tui,
			keybindings,
			"Edit response",
			"draft",
			() => {},
			() => {},
		);

		const output = renderPlain(component, 40);
		const boundaries = output.filter((line) => line === getGlyphs().separator.repeat(40));

		expect(output[0]).toContain("Edit response");
		expect(output[1]).toBe("");
		expect(boundaries).toHaveLength(1);
		expect(output.join("\n")).toContain("draft");
		expect(output.at(-1)).toContain("external editor");
	});

	it("preserves extension editor submit and cancel callbacks", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const keybindings = new KeybindingsManager();
		const tui = new TuiMainScreen(new VirtualTerminal(80, 24));
		const component = new ExtensionEditorComponent(tui, keybindings, "Edit response", "draft", onSubmit, onCancel);

		component.handleInput("\r");
		component.handleInput("\x1b");

		expect(onSubmit).toHaveBeenCalledOnce();
		expect(onSubmit).toHaveBeenCalledWith("draft");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("keeps a multiline selector title, every trust choice, and its key hint at 60x12", () => {
		const tui = new TuiMainScreen(new VirtualTerminal(60, 12));
		const component = new ExtensionSelectorComponent(
			"Trust project folder?\n/workspace/project\n\nThis description is secondary at short heights.",
			[
				"Trust",
				"Trust parent folder",
				"Trust (this session only)",
				"Do not trust",
				"Do not trust (this session only)",
			],
			() => {},
			() => {},
			{ tui },
		);

		const output = renderPlain(component, 60);

		expect(output[0]).toContain("Trust project folder?");
		expect(output[1]).toContain("/workspace/project");
		expect(output.filter((line) => line.includes("Trust") || line.includes("trust"))).toHaveLength(6);
		expect(output.at(-1)).toContain("navigate");
		expect(output.at(-1)).toContain("select");
		expect(output.at(-1)).toContain("cancel");
		expect(output).toHaveLength(10);
		expect(output.every((line) => Array.from(line).length <= 60)).toBe(true);
	});
});
