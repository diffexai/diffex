import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "../src/components/markdown.ts";
import { getGlyphs } from "../src/glyphs.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const TABLE = `| Name | State |
| --- | --- |
| sync | done |
| ship | pending |`;

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd());
}

describe("Compact Markdown tables", () => {
	it("uses a single header rule without outer or row boxes", () => {
		const markdown = new Markdown(TABLE, 0, 0, defaultMarkdownTheme, undefined, {
			tableStyle: "compact",
		});

		assert.deepStrictEqual(plain(markdown.render(40)), [
			"Name  State",
			`${getGlyphs().separator.repeat(4)}  ${getGlyphs().separator.repeat(7)}`,
			"sync  done",
			"ship  pending",
		]);
	});

	it("keeps grid tables as the compatibility default", () => {
		const markdown = new Markdown(TABLE, 0, 0, defaultMarkdownTheme);
		const rendered = plain(markdown.render(40));

		assert.match(rendered[0]!, /^┌/);
		assert.match(rendered.at(-1)!, /┘$/);
	});
});
