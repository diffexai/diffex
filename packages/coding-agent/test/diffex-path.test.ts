import { visibleWidth } from "@earendil-works/diffex-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
	DiffexPathDockRail,
	DiffexPathHinge,
	DiffexPathLabel,
	DiffexPathRail,
	formatDiffexPathPrefix,
} from "../src/modes/interactive/components/diffex-path.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const originalAscii = process.env.DIFFEX_ASCII;
const originalTerm = process.env.TERM;

describe("Diffex path", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		if (originalAscii === undefined) {
			delete process.env.DIFFEX_ASCII;
		} else {
			process.env.DIFFEX_ASCII = originalAscii;
		}
		if (originalTerm === undefined) {
			delete process.env.TERM;
		} else {
			process.env.TERM = originalTerm;
		}
	});

	test("renders the curved activity and rail vocabulary", () => {
		delete process.env.DIFFEX_ASCII;
		process.env.TERM = "xterm-256color";

		expect(stripAnsi(new DiffexPathLabel("Reasoning", { marker: "start" }).render(80)[0] ?? "")).toBe(" ╭ Reasoning");
		expect(stripAnsi(new DiffexPathRail().render(80)[0] ?? "")).toBe(" │");
		expect(stripAnsi(formatDiffexPathPrefix("branch"))).toBe("├ ");
	});

	test("turns the Diffex endpoint into a responsive rule", () => {
		delete process.env.DIFFEX_ASCII;
		process.env.TERM = "xterm-256color";
		const endpoint = new DiffexPathLabel("Diffex", { marker: "end", fill: true });
		const wide = endpoint.render(80)[0] ?? "";
		const compact = endpoint.render(60)[0] ?? "";

		expect(stripAnsi(wide)).toMatch(/^ ╰─ Diffex ─+$/);
		expect(visibleWidth(wide)).toBe(80);
		expect(stripAnsi(compact)).toBe(" ╰─ Diffex");
	});

	test("renders a compact transmitter hinge and one response rail", () => {
		delete process.env.DIFFEX_ASCII;
		process.env.TERM = "xterm-256color";
		const hinge = new DiffexPathHinge();
		const dockRail = new DiffexPathDockRail();

		expect(stripAnsi(hinge.render(60)[0] ?? "")).toBe("╭");
		hinge.setExtended(true);
		expect(stripAnsi(hinge.render(80)[0] ?? "")).toBe("╭──");
		expect(stripAnsi(dockRail.render(80)[0] ?? "")).toBe(" │");
	});

	test("uses the same hierarchy in ASCII mode", () => {
		process.env.DIFFEX_ASCII = "1";

		expect(stripAnsi(new DiffexPathLabel("Reasoning", { marker: "start" }).render(80)[0] ?? "")).toBe(" + Reasoning");
		expect(stripAnsi(new DiffexPathLabel("Diffex", { marker: "end", fill: true }).render(60)[0] ?? "")).toBe(
			" \\- Diffex",
		);
		expect(stripAnsi(new DiffexPathRail().render(80)[0] ?? "")).toBe(" |");
		const hinge = new DiffexPathHinge();
		hinge.setExtended(true);
		expect(stripAnsi(hinge.render(80)[0] ?? "")).toBe("+--");
		expect(stripAnsi(new DiffexPathDockRail().render(80)[0] ?? "")).toBe(" |");
	});

	test.each([1, 2, 8, 60, 80, 120])("never exceeds a %d-column viewport", (width) => {
		const components = [
			new DiffexPathDockRail(),
			new DiffexPathHinge(),
			new DiffexPathLabel("A deliberately long activity label", { marker: "branch" }),
			new DiffexPathLabel("Diffex", { marker: "end", fill: true }),
			new DiffexPathRail(),
		];

		for (const component of components) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
