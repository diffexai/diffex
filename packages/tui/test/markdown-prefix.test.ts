import assert from "node:assert";
import { describe, it } from "node:test";
import { Chalk } from "chalk";
import { Markdown } from "../src/components/markdown.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

const chalk = new Chalk({ level: 3 });

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Markdown first-line prefix", () => {
	it("reserves a hanging prefix for wrapped continuation lines", () => {
		const markdown = new Markdown("alpha beta gamma", 1, 0, defaultMarkdownTheme, undefined, {
			firstLinePrefix: chalk.cyan("› "),
		});

		const lines = markdown.render(14);
		const plainLines = lines.map((line) => stripAnsi(line));

		assert.strictEqual(visibleWidth(lines[0] ?? ""), 14);
		assert.strictEqual(visibleWidth(lines[1] ?? ""), 14);
		assert.ok(lines[0]?.includes(chalk.cyan("› ")));
		assert.ok(plainLines[0]?.startsWith(" › alpha beta"));
		assert.ok(plainLines[1]?.startsWith("   gamma"));
	});

	it("reports the body width to Markdown transforms", () => {
		const widths: number[] = [];
		const markdown = new Markdown("prompt", 1, 0, defaultMarkdownTheme, undefined, {
			firstLinePrefix: chalk.cyan("› "),
			transform: (source, availableWidth) => {
				widths.push(availableWidth);
				return source;
			},
		});

		markdown.render(20);

		assert.deepStrictEqual(widths, [16]);
	});
});
