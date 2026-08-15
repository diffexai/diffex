import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/diffex-tui";
import { visibleWidth } from "@earendil-works/diffex-tui";
import { describe, expect, test } from "vitest";
import {
	DIFFEX_LOGO_ART,
	DIFFEX_WELCOME_ANIMATION_TICKS,
	DiffexWelcomeHeader,
	diffexIntroAccent,
	diffexIntroText,
	renderDiffexWelcomeFrame,
} from "../src/modes/interactive/components/diffex-welcome.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("renderDiffexWelcomeFrame", () => {
	test("settles into the Diffex logo", () => {
		expect(renderDiffexWelcomeFrame(DIFFEX_WELCOME_ANIMATION_TICKS, 76)).toEqual(DIFFEX_LOGO_ART);
	});

	test("moves the boat from the center toward the logo position", () => {
		const firstFrame = renderDiffexWelcomeFrame(0, 76).join("\n");
		const finalBoatFrame = renderDiffexWelcomeFrame(19, 76).join("\n");

		expect(firstFrame.indexOf("___")).toBeGreaterThan(finalBoatFrame.indexOf("___"));
		expect(finalBoatFrame.indexOf("___")).toBeGreaterThanOrEqual(0);
	});
});

describe("DiffexWelcomeHeader", () => {
	test("wraps the intro in a blue boundary box with light logo text", () => {
		initTheme("dark", false);
		const ui = { requestRender() {} } as unknown as TUI;
		const getDetails = () =>
			[diffexIntroAccent("Diffex") + diffexIntroText(" v1.0.0"), diffexIntroText("~/project")].join("\n");
		const header = new DiffexWelcomeHeader(ui, getDetails, getDetails);
		header.dispose();

		const rendered = header.render(60);

		expect(rendered[0]).toContain(theme.getFgAnsi("startupIntroAccent"));
		expect(rendered[1]).toContain(theme.getFgAnsi("startupIntroText"));
		expect(stripVTControlCharacters(rendered[0] ?? "")).toBe(`┌${"─".repeat(58)}┐`);
		expect(stripVTControlCharacters(rendered.at(-1) ?? "")).toBe(`└${"─".repeat(58)}┘`);
		expect(rendered.some((line) => line.includes("Diffex"))).toBe(true);
		for (const line of rendered) {
			expect(visibleWidth(line)).toBe(60);
		}
	});

	test("refreshes detail colors when the active theme changes", () => {
		initTheme("dark", false);
		const ui = { requestRender() {} } as unknown as TUI;
		const getDetails = () =>
			[diffexIntroAccent("Diffex") + diffexIntroText(" v1.0.0"), diffexIntroText("~/project")].join("\n");
		const header = new DiffexWelcomeHeader(ui, getDetails, getDetails);
		header.dispose();

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
});
