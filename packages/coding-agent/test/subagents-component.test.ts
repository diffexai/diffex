import { visibleWidth } from "@diffexai/diffex-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { SubagentSummary } from "../src/core/subagents/types.ts";
import { SubagentsComponent } from "../src/modes/interactive/components/subagents.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const summaries: readonly SubagentSummary[] = [
	{ name: "failed", status: "failed", task: "Diagnose provider failure" },
	{ name: "idle", status: "idle", task: "Review the proposed implementation" },
	{ name: "interrupted", status: "interrupted", task: "Stop after requested cancellation" },
	{ name: "queued", status: "queued", task: "Wait for a concurrency slot" },
	{ name: "running", status: "running", task: "Investigate the command flow" },
];

describe("SubagentsComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the empty-session message", () => {
		const rendered = stripAnsi(new SubagentsComponent([]).render(80).join("\n"));

		expect(rendered).toContain("Sub-agents");
		expect(rendered).toContain("No sub-agents in this session.");
	});

	it("renders every lowercase status with the semantic theme colors", () => {
		const rendered = new SubagentsComponent(summaries).render(120).join("\n");

		expect(rendered).toContain(theme.fg("accent", "running    "));
		expect(rendered).toContain(theme.fg("warning", "queued     "));
		expect(rendered).toContain(theme.fg("success", "idle       "));
		expect(rendered).toContain(theme.fg("error", "failed     "));
		expect(rendered).toContain(theme.fg("warning", "interrupted"));
	});

	it("normalizes multiline task text and respects Unicode display width", () => {
		const component = new SubagentsComponent([
			{ name: "unicode", status: "running", task: "Inspect 漢字🙂\nacross\tlines" },
		]);
		const lines = component.render(80);
		const rendered = stripAnsi(lines.join("\n"));

		expect(rendered).toContain("Inspect 漢字🙂 across lines");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("reflows after resizing and truncates tasks with exactly three dots", () => {
		const component = new SubagentsComponent([
			{ name: "worker", status: "running", task: "Investigate a deliberately long task description" },
		]);
		const wide = stripAnsi(component.render(80).join("\n"));
		const narrowLines = component.render(24);
		const narrow = stripAnsi(narrowLines.join("\n"));

		expect(wide).toContain("Investigate a deliberately long task description");
		expect(narrow.split("\n").at(-1)).toMatch(/\.\.\.$/);
		expect(narrow).not.toContain("…");
		expect(narrowLines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	it.each([1, 2, 3, 4, 8, 9, 12])("keeps every line within a narrow width of %i", (width) => {
		const lines = new SubagentsComponent(summaries).render(width);

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});
