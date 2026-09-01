import { getGlyphs, visibleWidth } from "@earendil-works/diffex-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	test("renders the prompt inside a full-width user surface", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(stripAnsi(lines[1])).toContain(`${getGlyphs().selected} hello`);
		expect(stripAnsi(lines.join("\n"))).not.toContain("You");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 20)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 76 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("rebuilds the prompt accent when the theme changes", () => {
		const previousNoColor = process.env.NO_COLOR;
		const previousTerm = process.env.TERM;
		delete process.env.NO_COLOR;
		process.env.TERM = "xterm-256color";

		try {
			initTheme("dark");
			const component = new UserMessageComponent("Message");
			const darkPrefix = theme.fg("accent", `${getGlyphs().selected} `);

			expect(component.render(80).join("\n")).toContain(darkPrefix);

			initTheme("light");
			const lightPrefix = theme.fg("accent", `${getGlyphs().selected} `);
			expect(lightPrefix).not.toBe(darkPrefix);
			component.invalidate();

			const rendered = component.render(80).join("\n");
			expect(rendered).toContain(lightPrefix);
			expect(rendered).not.toContain(darkPrefix);
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
			initTheme("dark");
		}
	});
});
