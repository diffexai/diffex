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
		expect(lines[0]).toContain("Responding");
		const plain = stripAnsi(lines[0] ?? "");
		expect(plain.indexOf(getGlyphs().start)).toBeLessThan(plain.indexOf("Responding"));

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
});
