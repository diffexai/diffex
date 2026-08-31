import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/diffex-tui";
import { getGlyphs, visibleWidth } from "@earendil-works/diffex-tui";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	DIFFEX_LOGO_ART,
	DIFFEX_WELCOME_ANIMATION_TICKS,
	DIFFEX_WELCOME_BOOT_TICKS,
	DIFFEX_WELCOME_MIN_ROWS,
	DIFFEX_WELCOME_TRAVEL_TICKS,
	DiffexWelcomeHeader,
	diffexIntroAccent,
	diffexIntroText,
	renderDiffexWelcomeBoundary,
	renderDiffexWelcomeFrame,
} from "../src/modes/interactive/components/diffex-welcome.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const originalNoColor = process.env.NO_COLOR;
const originalDiffexAscii = process.env.DIFFEX_ASCII;
const originalTerm = process.env.TERM;

function createTui(rows = 24): TUI {
	return { requestRender() {}, terminal: { rows } } as unknown as TUI;
}

beforeEach(() => {
	process.env.NO_COLOR = "";
	process.env.TERM = "xterm-256color";
	delete process.env.DIFFEX_ASCII;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

afterAll(() => {
	if (originalNoColor === undefined) {
		delete process.env.NO_COLOR;
	} else {
		process.env.NO_COLOR = originalNoColor;
	}
	if (originalDiffexAscii === undefined) {
		delete process.env.DIFFEX_ASCII;
	} else {
		process.env.DIFFEX_ASCII = originalDiffexAscii;
	}
	if (originalTerm === undefined) {
		delete process.env.TERM;
	} else {
		process.env.TERM = originalTerm;
	}
	initTheme("dark", false);
});

describe("renderDiffexWelcomeFrame", () => {
	test("settles into the Diffex logo", () => {
		expect(renderDiffexWelcomeFrame(DIFFEX_WELCOME_ANIMATION_TICKS, 76)).toEqual(DIFFEX_LOGO_ART);
	});

	test("holds the boat at the far right before moving it to the logo position", () => {
		const firstFrame = renderDiffexWelcomeFrame(0, 76).join("\n");
		const heldFrame = renderDiffexWelcomeFrame(DIFFEX_WELCOME_BOOT_TICKS - 1, 76).join("\n");
		const finalBoatFrame = renderDiffexWelcomeFrame(
			DIFFEX_WELCOME_BOOT_TICKS + DIFFEX_WELCOME_TRAVEL_TICKS - 1,
			76,
		).join("\n");

		expect(firstFrame.indexOf("___")).toBe(heldFrame.indexOf("___"));
		expect(firstFrame.indexOf("___")).toBeGreaterThan(finalBoatFrame.indexOf("___"));
		expect(finalBoatFrame.indexOf("___")).toBeGreaterThanOrEqual(0);
	});

	test("changes the boat pose while it waits", () => {
		expect(renderDiffexWelcomeFrame(0, 76)).not.toEqual(renderDiffexWelcomeFrame(1, 76));
	});
});

describe("renderDiffexWelcomeBoundary", () => {
	test("draws a right-aligned trail behind the moving boat and settles full width", () => {
		const width = 76;
		const firstTravelTick = DIFFEX_WELCOME_BOOT_TICKS;
		const middleTravelTick = firstTravelTick + Math.floor(DIFFEX_WELCOME_TRAVEL_TICKS / 2);
		const firstBoundary = renderDiffexWelcomeBoundary(firstTravelTick, width);
		const middleBoundary = renderDiffexWelcomeBoundary(middleTravelTick, width);
		const settledBoundary = renderDiffexWelcomeBoundary(DIFFEX_WELCOME_ANIMATION_TICKS, width);

		expect(renderDiffexWelcomeBoundary(firstTravelTick - 1, width)).toBe("");
		expect(firstBoundary.trim()).toBe("");
		expect(visibleWidth(firstBoundary)).toBe(width);
		expect(middleBoundary.startsWith(" ")).toBe(true);
		expect(middleBoundary.trimStart()).toMatch(/^─+$/);
		expect(visibleWidth(middleBoundary)).toBe(width);
		expect(settledBoundary).toBe(getGlyphs("unicode").separator.repeat(width));
	});

	test("uses the ASCII separator when requested", () => {
		process.env.DIFFEX_ASCII = "1";

		expect(renderDiffexWelcomeBoundary(DIFFEX_WELCOME_ANIMATION_TICKS, 40)).toBe("-".repeat(40));
	});
});

describe("DiffexWelcomeHeader", () => {
	test("stops its render timer when the entrance animation completes", () => {
		let renderRequests = 0;
		const ui = {
			requestRender() {
				renderRequests++;
			},
			terminal: { rows: 24 },
		} as unknown as TUI;
		new DiffexWelcomeHeader(
			ui,
			() => "Diffex",
			() => "Diffex",
		);

		vi.runAllTimers();
		expect(renderRequests).toBe(DIFFEX_WELCOME_ANIMATION_TICKS);

		vi.advanceTimersByTime(1000);
		expect(renderRequests).toBe(DIFFEX_WELCOME_ANIMATION_TICKS);
	});

	test("shows the boot message while the boat waits at the right edge", () => {
		initTheme("dark", false);
		const ui = createTui();
		const getDetails = () =>
			[diffexIntroAccent("Diffex") + diffexIntroText(" v1.0.0"), diffexIntroText("~/project")].join("\n");
		const header = new DiffexWelcomeHeader(ui, getDetails, getDetails);
		header.dispose();

		const rendered = header.render(60);
		const plain = rendered.map(stripVTControlCharacters);

		expect(rendered).toHaveLength(DIFFEX_LOGO_ART.length + 1);
		expect(plain[0]).toContain("Booting Diffex…");
		expect(plain.join("\n")).not.toContain("~/project");
		expect(plain.at(-1)).toBe("");
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	test("keeps the boot sequence readable in monochrome ASCII terminals", () => {
		process.env.NO_COLOR = "1";
		process.env.DIFFEX_ASCII = "1";
		initTheme("dark", false);
		const header = new DiffexWelcomeHeader(
			createTui(),
			() => "Diffex v1.0.0\n~/project",
			() => "Diffex v1.0.0\n~/project",
		);

		const animated = header.render(60).join("\n");
		vi.runAllTimers();
		const settled = header.render(60).join("\n");

		expect(animated).toContain("Booting Diffex...");
		expect(settled).toContain("-".repeat(60));
		expect(`${animated}${settled}`).not.toContain("\u001b[");
	});

	test("settles into a centered side-by-side layout over the completed boundary", () => {
		initTheme("dark", false);
		const ui = createTui();
		const getDetails = () =>
			[diffexIntroAccent("Diffex") + diffexIntroText(" v1.0.0"), diffexIntroText("~/project")].join("\n");
		const header = new DiffexWelcomeHeader(ui, getDetails, getDetails);
		vi.runAllTimers();

		const rendered = header.render(60);
		const plain = rendered.map(stripVTControlCharacters);

		expect(rendered).toHaveLength(DIFFEX_LOGO_ART.length + 1);
		expect(rendered.some((line) => line.includes(theme.getFgAnsi("startupIntroAccent")))).toBe(true);
		expect(rendered.some((line) => line.includes(theme.getFgAnsi("startupIntroText")))).toBe(true);
		expect(plain[2]).toContain("Diffex v1.0.0");
		expect(plain[3]).toContain("~/project");
		expect(plain.at(-1)).toBe("─".repeat(60));
		expect(plain.join("\n")).not.toMatch(/[┌┐└┘│]/);
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	test("collapses the settled mark to three rows at narrow widths", () => {
		initTheme("dark", false);
		const ui = createTui();
		const getDetails = () =>
			[diffexIntroAccent("Diffex") + diffexIntroText(" v1.0.0"), diffexIntroText("~/project")].join("\n");
		const header = new DiffexWelcomeHeader(ui, getDetails, getDetails);
		vi.runAllTimers();

		const rendered = header.render(36);

		expect(rendered).toHaveLength(6);
		expect(rendered.some((line) => line.includes("Diffex"))).toBe(true);
		expect(stripVTControlCharacters(rendered.at(-1) ?? "")).toBe("─".repeat(36));
		for (const line of rendered) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(36);
		}
	});

	test("refreshes detail colors when the active theme changes", () => {
		initTheme("dark", false);
		const ui = createTui();
		const getDetails = () =>
			[diffexIntroAccent("Diffex") + diffexIntroText(" v1.0.0"), diffexIntroText("~/project")].join("\n");
		const header = new DiffexWelcomeHeader(ui, getDetails, getDetails);
		vi.runAllTimers();

		const darkDetails = header.render(60).find((line) => line.includes("Diffex"));
		const darkAccent = theme.getFgAnsi("startupIntroAccent");
		const darkText = theme.getFgAnsi("startupIntroText");
		expect(darkDetails).toContain(darkAccent);
		expect(darkDetails).toContain(darkText);

		initTheme("light", false);
		const lightDetails = header.render(60).find((line) => line.includes("Diffex"));
		expect(lightDetails).toContain(theme.getFgAnsi("startupIntroAccent"));
		expect(lightDetails).toContain(theme.getFgAnsi("startupIntroText"));
		expect(lightDetails).not.toContain(darkAccent);
		expect(lightDetails).not.toContain(darkText);
	});

	test("suppresses the startup mark when the supported viewport is too short", () => {
		const shortHeader = new DiffexWelcomeHeader(
			createTui(DIFFEX_WELCOME_MIN_ROWS - 1),
			() => "Diffex",
			() => "Diffex",
		);
		const visibleHeader = new DiffexWelcomeHeader(
			createTui(DIFFEX_WELCOME_MIN_ROWS),
			() => "Diffex",
			() => "Diffex",
		);
		shortHeader.dispose();
		vi.runAllTimers();

		expect(shortHeader.render(60)).toEqual([]);
		expect(visibleHeader.render(60)).toHaveLength(DIFFEX_LOGO_ART.length + 1);
	});
});
