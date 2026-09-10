/**
 * Test that BashExecutionComponent's collapsed output respects the render-time width,
 * not a stale captured width. Regression test for #2569.
 */
import { getGlyphs, visibleWidth } from "@diffexai/diffex-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Minimal TUI stub that only exposes terminal.columns */
function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		// Loader calls ui.addInterval / ui.removeInterval
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("collapsed preview lines respect render-time width, not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		// Add output with long lines that will wrap differently at different widths
		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		// Complete the command so it enters collapsed mode
		component.setComplete(0, false);

		// Render at the narrow width (simulating a resize or split pane)
		const lines = component.render(narrowWidth);

		// Every rendered line must fit within the narrow width
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20); // 200 chars
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		// First render at width 200
		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		// Second render at width 60 (split pane scenario)
		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("renders running, success, failure, and cancellation as explicit text states", () => {
		const separator = ` ${getGlyphs().bullet} `;
		const running = new BashExecutionComponent("echo hello", createTuiStub(80).stub);
		expect(stripAnsi(running.render(80).join("\n"))).toContain(`Bash${separator}running`);
		running.setComplete(0, false);
		expect(stripAnsi(running.render(80).join("\n"))).toContain(`Bash${separator}complete`);

		const failed = new BashExecutionComponent("exit 2", createTuiStub(80).stub);
		failed.setComplete(2, false);
		expect(stripAnsi(failed.render(80).join("\n"))).toContain(`Bash${separator}failed${separator}exit 2`);

		const cancelled = new BashExecutionComponent("sleep 10", createTuiStub(80).stub);
		cancelled.setComplete(undefined, true);
		expect(stripAnsi(cancelled.render(80).join("\n"))).toContain(`Bash${separator}cancelled`);
	});

	it("aligns the stable running marker and label with the completed state", () => {
		const component = new BashExecutionComponent("sleep 8", createTuiStub(60).stub);
		const runningLine = stripAnsi(component.render(60).find((line) => line.includes("Bash")) ?? "");
		const glyphs = getGlyphs();

		expect(runningLine.indexOf(glyphs.running)).toBe(1);
		expect(runningLine.indexOf("Bash")).toBe(3);
		expect(visibleWidth(runningLine)).toBeLessThanOrEqual(60);

		component.setComplete(0, false);
		const completeLine = stripAnsi(component.render(60).find((line) => line.includes("Bash")) ?? "");
		expect(completeLine.indexOf(glyphs.success)).toBe(1);
		expect(completeLine.indexOf("Bash")).toBe(3);
		expect(visibleWidth(completeLine)).toBeLessThanOrEqual(60);
	});
});
