import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { CURSOR_MARKER, type TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";

function createTestTui(requestRender: () => void = () => {}): TUI {
	return {
		terminal: { rows: 24 },
		requestRender,
	} as unknown as TUI;
}

describe("Editor placeholder cursor", () => {
	it("renders the empty editor cursor over the first placeholder grapheme", () => {
		const placeholder = "Ask Diffex to do something for you.";
		const editor = new Editor(createTestTui(), defaultEditorTheme, {
			prompt: "> ",
			promptStyle: (text) => `\x1b[34m${text}\x1b[39m`,
			placeholder,
			placeholderStyle: (text) => `\x1b[90m${text}\x1b[39m`,
		});
		editor.focused = true;

		try {
			const contentLine = editor.render(80)[1]!;

			assert.ok(contentLine.startsWith(`\x1b[34m> \x1b[39m${CURSOR_MARKER}\x1b[7mA\x1b[0m\x1b[90msk Diffex`));
			assert.strictEqual(
				stripVTControlCharacters(contentLine.replace(CURSOR_MARKER, "")).trimEnd(),
				`> ${placeholder}`,
			);
		} finally {
			editor.focused = false;
			editor.render(80);
		}
	});

	it("blinks while the empty editor is focused", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		let renderRequests = 0;
		const editor = new Editor(
			createTestTui(() => {
				renderRequests++;
			}),
			defaultEditorTheme,
			{
				prompt: "> ",
				promptStyle: (text) => `\x1b[34m${text}\x1b[39m`,
				placeholder: "Ask Diffex to do something for you.",
				placeholderStyle: (text) => `\x1b[90m${text}\x1b[39m`,
			},
		);
		editor.focused = true;

		try {
			assert.ok(editor.render(80)[1]!.startsWith(`\x1b[34m> \x1b[39m${CURSOR_MARKER}\x1b[7mA\x1b[0m`));

			mock.timers.tick(500);
			assert.strictEqual(renderRequests, 1);
			assert.ok(editor.render(80)[1]!.startsWith(`\x1b[34m> \x1b[39m${CURSOR_MARKER}\x1b[90mAsk Diffex`));

			mock.timers.tick(500);
			assert.strictEqual(renderRequests, 2);
			assert.ok(editor.render(80)[1]!.startsWith(`\x1b[34m> \x1b[39m${CURSOR_MARKER}\x1b[7mA\x1b[0m`));
		} finally {
			editor.focused = false;
			editor.render(80);
			mock.timers.reset();
		}
	});

	it("keeps typed and wrapped text to the right of the prompt", () => {
		const editor = new Editor(createTestTui(), defaultEditorTheme, { prompt: "> " });
		editor.setText("123456789");

		const contentLines = editor
			.render(10)
			.slice(1, -1)
			.map((line) => stripVTControlCharacters(line));

		assert.ok(contentLines[0]!.startsWith("> "));
		assert.ok(contentLines.slice(1).every((line) => line.startsWith("  ")));
		assert.ok(contentLines.every((line) => !line.startsWith("123")));
	});

	it("conceals a stored input prefix without affecting deletion", () => {
		const changes: string[] = [];
		const editor = new Editor(createTestTui(), defaultEditorTheme, {
			prompt: "! ",
			concealedInputPrefix: "!",
		});
		editor.onChange = (text) => changes.push(text);
		editor.setText("!pwd");

		assert.strictEqual(editor.getText(), "!pwd");
		assert.strictEqual(stripVTControlCharacters(editor.render(80)[1]!).trimEnd(), "! pwd");

		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "!");
		assert.strictEqual(stripVTControlCharacters(editor.render(80)[1]!).trimEnd(), "!");

		editor.handleInput("\x7f");
		assert.strictEqual(editor.getText(), "");
		assert.strictEqual(changes.at(-1), "");
	});
});
