import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.ts";
import { detectGlyphMode, getGlyphs } from "../src/glyphs.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

describe("Editor frames", () => {
	it("keeps the legacy paired rules by default", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);

		const rendered = plain(editor.render(16));

		assert.strictEqual(rendered.length, 3);
		assert.strictEqual(rendered[0], getGlyphs().separator.repeat(16));
		assert.strictEqual(rendered[2], getGlyphs().separator.repeat(16));
	});

	it("supports a single top rule for a compact composer dock", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme, { frameStyle: "top" });

		const rendered = plain(editor.render(16));

		assert.strictEqual(rendered.length, 2);
		assert.strictEqual(rendered[0], getGlyphs().separator.repeat(16));
	});

	it("supports an open frame", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme, { frameStyle: "none" });

		assert.strictEqual(editor.render(16).length, 1);
	});

	it("honors a host-provided visible line cap", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme, {
			frameStyle: "top",
			maxVisibleLines: 2,
		});
		editor.setText("one\ntwo\nthree\nfour");

		const rendered = plain(editor.render(24));

		assert.strictEqual(rendered.length, 3);
		assert.ok(rendered[0]!.includes(`${getGlyphs().up} 2 more`));
		assert.match(rendered[1]!, /three/);
		assert.match(rendered[2]!, /four/);
	});
});

describe("TUI glyphs", () => {
	it("uses ASCII glyphs for dumb terminals and explicit fallback mode", () => {
		assert.strictEqual(detectGlyphMode({ TERM: "dumb" }), "ascii");
		assert.strictEqual(detectGlyphMode({ DIFFEX_ASCII: "1" }), "ascii");
		assert.strictEqual(getGlyphs("ascii").selected, ">");
		assert.strictEqual(getGlyphs("ascii").separator, "-");
	});

	it("honors a dumb terminal when selecting the default glyph set", () => {
		const originalTerm = process.env.TERM;
		const originalAscii = process.env.DIFFEX_ASCII;
		process.env.TERM = "dumb";
		delete process.env.DIFFEX_ASCII;

		try {
			assert.strictEqual(getGlyphs().separator, "-");
		} finally {
			if (originalTerm === undefined) delete process.env.TERM;
			else process.env.TERM = originalTerm;
			if (originalAscii === undefined) delete process.env.DIFFEX_ASCII;
			else process.env.DIFFEX_ASCII = originalAscii;
		}
	});

	it("uses the Diffex Unicode vocabulary by default", () => {
		assert.strictEqual(detectGlyphMode({ TERM: "xterm-256color" }), "unicode");
		assert.strictEqual(getGlyphs("unicode").selected, "›");
		assert.strictEqual(getGlyphs("unicode").start, "╭");
		assert.strictEqual(getGlyphs("unicode").rail, "│");
	});
});
