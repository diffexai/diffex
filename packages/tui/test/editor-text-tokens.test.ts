import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";

function createTestTui(): TUI {
	return {
		terminal: { rows: 24 },
		requestRender: () => {},
		isTerminalFocused: () => true,
	} as unknown as TUI;
}

const purple = (text: string) => `\x1b[38;2;196;114;214m${text}\x1b[39m`;

describe("Editor text tokens", () => {
	it("renders a short styled label while preserving the expanded value", () => {
		const editor = new Editor(createTestTui(), defaultEditorTheme, { textTokenStyle: purple });
		const reference = '<skill-reference id="skill:abc" version="sha256:def" name="review"/>';

		editor.setTextWithTokens([{ value: reference, displayText: "review" }, "\n\ncheck this change"]);

		assert.strictEqual(editor.getExpandedText(), `${reference}\n\ncheck this change`);
		assert.ok(!editor.getText().includes(reference));
		const rendered = editor.render(40);
		assert.ok(rendered.join("\n").includes(purple("review")));
		assert.ok(stripVTControlCharacters(rendered.join("\n")).includes("review"));
		assert.ok(!stripVTControlCharacters(rendered.join("\n")).includes("skill-reference"));
		assert.ok(rendered.every((line) => visibleWidth(line) <= 40));
	});

	it("treats a token as one editable unit", () => {
		const editor = new Editor(createTestTui(), defaultEditorTheme, { textTokenStyle: purple });
		editor.setTextWithTokens([{ value: "<reference/>", displayText: "review" }]);

		editor.handleInput("\x7f");

		assert.strictEqual(editor.getText(), "");
		assert.strictEqual(editor.getExpandedText(), "");
	});

	it("submits expanded values for duplicate display labels", () => {
		const editor = new Editor(createTestTui(), defaultEditorTheme, { textTokenStyle: purple });
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setTextWithTokens([
			{ value: "<workspace/>", displayText: "duplicate" },
			"\n",
			{ value: "<global/>", displayText: "duplicate" },
		]);

		editor.handleInput("\r");

		assert.strictEqual(submitted, "<workspace/>\n<global/>");
		assert.strictEqual(editor.getText(), "");
	});
});
