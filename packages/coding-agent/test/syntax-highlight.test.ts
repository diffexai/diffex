import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/diffex-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { highlight, renderHighlightedHtml, supportsLanguage } from "../src/utils/syntax-highlight.ts";

const originalNoColor = process.env.NO_COLOR;

describe("syntax highlight renderer", () => {
	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

describe("theme syntax highlighting", () => {
	beforeEach(() => {
		process.env.NO_COLOR = "";
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		if (originalNoColor === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNoColor;
		}
		resetCapabilitiesCache();
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe("\x1b[38;2;240;113;120m-old\x1b[39m");
		expect(lines[1]).toBe("\x1b[38;2;115;201;145m+new\x1b[39m");
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			"\x1b[38;2;230;154;117m/foo+/gi\x1b[39m",
		);
		expect(highlightCode("@decorator", "python")[0]).toBe("\x1b[38;2;160;168;184m@decorator\x1b[39m");
		expect(highlightCode("<div></div>", "html")[0]).toContain("\x1b[38;2;130;170;255mdiv\x1b[39m");
	});
});
