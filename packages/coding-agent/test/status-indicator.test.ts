import { getGlyphs, type TUI } from "@earendil-works/diffex-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import {
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reserves one stable row while idle", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toEqual([" ".repeat(20)]);
	});

	it("renders active work on one row", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Responding");

		const lines = indicator.render(40);
		expect(lines).toHaveLength(1);
		const plain = stripAnsi(lines[0] ?? "");
		const glyphs = getGlyphs();
		expect(plain).toContain(`${glyphs.start} ${glyphs.running}${glyphs.bullet.repeat(3)} Responding`);
		const messageColumn = plain.indexOf("Responding");

		vi.advanceTimersByTime(120);
		const nextFrame = stripAnsi(indicator.render(40)[0] ?? "");
		expect(nextFrame).toContain(
			`${glyphs.start} ${glyphs.bullet}${glyphs.running}${glyphs.bullet.repeat(2)} Responding`,
		);
		expect(nextFrame.indexOf("Responding")).toBe(messageColumn);

		indicator.dispose();
	});

	it("preserves the open path when an extension replaces the animation", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Inspecting");

		indicator.setIndicator({ frames: ["*"] });
		const plain = stripAnsi(indicator.render(40)[0] ?? "");

		expect(plain).toContain(`${getGlyphs().start} * Inspecting`);
		indicator.dispose();
	});

	it("refreshes the path accent when the theme changes", () => {
		const previousNoColor = process.env.NO_COLOR;
		const previousTerm = process.env.TERM;
		delete process.env.NO_COLOR;
		process.env.TERM = "xterm-256color";
		vi.useFakeTimers();
		initTheme("dark");
		const indicator = new WorkingStatusIndicator({ requestRender: vi.fn() } as unknown as TUI, "Responding");

		try {
			indicator.invalidate();
			const darkMarker = theme.fg("borderAccent", getGlyphs().start);
			expect(indicator.render(40).join("\n")).toContain(darkMarker);

			initTheme("light");
			const lightMarker = theme.fg("borderAccent", getGlyphs().start);
			expect(lightMarker).not.toBe(darkMarker);
			indicator.invalidate();
			const rendered = indicator.render(40).join("\n");
			expect(rendered).toContain(lightMarker);
			expect(rendered).not.toContain(darkMarker);
		} finally {
			indicator.dispose();
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
			initTheme("dark");
		}
	});

	it("keeps cancellable editor loaders to one borderless row", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const loader = new BorderedLoader(tui, theme, "Preparing share");

		const lines = loader.render(60);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Preparing share");
		expect(lines[0]).toContain("cancel");
		expect(lines[0]).not.toContain("─");

		loader.dispose();
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("disposes working signal and verb updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(5000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
