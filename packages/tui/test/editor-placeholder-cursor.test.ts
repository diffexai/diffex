import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";

function createTestTui(): TUI {
	return {
		terminal: { rows: 24 },
		requestRender: () => {},
	} as unknown as TUI;
}

describe("Editor placeholder cursor", () => {
	it("renders the empty editor cursor over the first placeholder grapheme", () => {
		const placeholder = "Ask Diffex to do something for you.";
		const editor = new Editor(createTestTui(), defaultEditorTheme, {
			placeholder,
			placeholderStyle: (text) => `\x1b[90m${text}\x1b[39m`,
		});

		const contentLine = editor.render(80)[1]!;

		assert.ok(contentLine.startsWith("\x1b[90m\x1b[7mA\x1b[27msk Diffex"));
		assert.strictEqual(stripVTControlCharacters(contentLine).trimEnd(), placeholder);
	});
});
