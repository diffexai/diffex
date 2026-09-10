import { visibleWidth } from "@diffexai/diffex-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
	DiffexPathDockHinge,
	DiffexPathHinge,
	DiffexPathLabel,
	DiffexPathNode,
	DiffexPathRail,
	DiffexPathTerminus,
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
		expect(stripAnsi(new DiffexPathTerminus().render(80)[0] ?? "")).toBe(" ╰");
		expect(stripAnsi(formatDiffexPathPrefix("branch"))).toBe("├ ");
	});

	test("renders unlabeled output boundaries without a rule", () => {
		delete process.env.DIFFEX_ASCII;
		process.env.TERM = "xterm-256color";
		const endpoint = new DiffexPathNode({ marker: "end" });
		const wide = endpoint.render(80)[0] ?? "";
		const compact = endpoint.render(60)[0] ?? "";

		expect(stripAnsi(wide)).toBe(" ╰");
		expect(stripAnsi(compact)).toBe(" ╰");
	});

	test("renders the transmitter hinge on the external dock row", () => {
		delete process.env.DIFFEX_ASCII;
		process.env.TERM = "xterm-256color";
		const hinge = new DiffexPathHinge();
		const dockHinge = new DiffexPathDockHinge();

		expect(stripAnsi(hinge.render(60)[0] ?? "")).toBe("╭");
		hinge.setExtended(true);
		expect(stripAnsi(hinge.render(80)[0] ?? "")).toBe("╭──");
		expect(dockHinge.render(60)[0]).toBe("");
		expect(stripAnsi(dockHinge.render(60)[1] ?? "")).toBe(" ╭");
		expect(stripAnsi(dockHinge.render(80)[1] ?? "")).toBe(" ╭──");
		dockHinge.setOutputPad(2);
		expect(stripAnsi(dockHinge.render(80)[1] ?? "")).toBe("  ╭──");
	});

	test("uses the same hierarchy in ASCII mode", () => {
		process.env.DIFFEX_ASCII = "1";

		expect(stripAnsi(new DiffexPathLabel("Reasoning", { marker: "start" }).render(80)[0] ?? "")).toBe(" + Reasoning");
		expect(stripAnsi(new DiffexPathNode({ marker: "end" }).render(60)[0] ?? "")).toBe(" \\");
		expect(stripAnsi(new DiffexPathRail().render(80)[0] ?? "")).toBe(" |");
		const hinge = new DiffexPathHinge();
		hinge.setExtended(true);
		expect(stripAnsi(hinge.render(80)[0] ?? "")).toBe("+--");
		expect(stripAnsi(new DiffexPathDockHinge().render(80)[1] ?? "")).toBe(" +--");
	});

	test.each([1, 2, 8, 60, 80, 120])("never exceeds a %d-column viewport", (width) => {
		const components = [
			new DiffexPathDockHinge(),
			new DiffexPathHinge(),
			new DiffexPathLabel("A deliberately long activity label", { marker: "branch" }),
			new DiffexPathNode({ marker: "end" }),
			new DiffexPathRail(),
			new DiffexPathTerminus(),
		];

		for (const component of components) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
