import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RgbColor,
	resetCapabilitiesCache,
	SELECTED_LIST_PREFIX,
	setCapabilities,
} from "@earendil-works/diffex-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	detectTerminalThemeForAuto,
	getEditorTheme,
	getSelectListTheme,
	getSettingsListTheme,
	getThemeByName,
	getThemeForRgbColor,
	initTheme,
	loadThemeFromPath,
	parseAutoThemeSetting,
	resolveThemeSetting,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

afterEach(() => {
	resetCapabilitiesCache();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("detectTerminalBackgroundFromEnv", () => {
	it("uses the COLORFGBG background color index", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;15" } })).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "15;0" } })).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("uses the last COLORFGBG field as the background", () => {
		expect(detectTerminalBackgroundFromEnv({ env: { COLORFGBG: "0;7;15" } }).theme).toBe("light");
	});

	it("defaults to dark without terminal background hints", () => {
		expect(detectTerminalBackgroundFromEnv({ env: {} })).toMatchObject({
			theme: "dark",
			source: "fallback",
			confidence: "low",
		});
	});
});

describe("detectTerminalBackgroundTheme", () => {
	it("uses the queried terminal background before environment hints", async () => {
		let queriedTimeoutMs: number | undefined;
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "15;0" },
			timeoutMs: 250,
			ui: {
				async queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
					queriedTimeoutMs = timeoutMs;
					return { r: 250, g: 250, b: 250 };
				},
			},
		});

		expect(queriedTimeoutMs).toBe(250);
		expect(detection).toMatchObject({
			theme: "light",
			source: "terminal background",
			confidence: "high",
		});
	});

	it("falls back to environment hints when the terminal query returns no color", async () => {
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "15;0" },
			timeoutMs: 250,
			ui: {
				async queryTerminalBackgroundColor(): Promise<RgbColor | undefined> {
					return undefined;
				},
			},
		});

		expect(detection).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("falls back to environment hints when the terminal query fails", async () => {
		const detection = await detectTerminalBackgroundTheme({
			env: { COLORFGBG: "0;15" },
			timeoutMs: 250,
			ui: {
				async queryTerminalBackgroundColor(): Promise<RgbColor | undefined> {
					throw new Error("terminal write failed");
				},
			},
		});

		expect(detection).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
	});
});

describe("detectTerminalThemeForAuto", () => {
	it("starts both queries and returns the preferred color-scheme result without waiting", async () => {
		let resolveColorScheme!: (theme: "dark" | "light" | undefined) => void;
		let backgroundQueryStarted = false;
		const detection = detectTerminalThemeForAuto({
			timeoutMs: 100,
			ui: {
				queryTerminalColorScheme: () =>
					new Promise((resolve) => {
						resolveColorScheme = resolve;
					}),
				queryTerminalBackgroundColor: () => {
					backgroundQueryStarted = true;
					return new Promise<RgbColor | undefined>(() => {});
				},
			},
		});

		expect(backgroundQueryStarted).toBe(true);
		resolveColorScheme("dark");
		await expect(detection).resolves.toBe("dark");
	});

	it("uses the background result when the color-scheme query fails", async () => {
		await expect(
			detectTerminalThemeForAuto({
				timeoutMs: 100,
				ui: {
					async queryTerminalColorScheme(): Promise<undefined> {
						throw new Error("color-scheme query failed");
					},
					async queryTerminalBackgroundColor(): Promise<RgbColor> {
						return { r: 250, g: 250, b: 250 };
					},
				},
			}),
		).resolves.toBe("light");
	});
});

describe("theme color mode", () => {
	it("uses terminal capabilities", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const ansi256Theme = getThemeByName("dark");
		if (!ansi256Theme) throw new Error("dark theme not found");
		expect(ansi256Theme.getColorMode()).toBe("256color");
		expect(ansi256Theme.getFgAnsi("accent")).toMatch(/^\x1b\[38;5;\d+m$/);

		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const truecolorTheme = getThemeByName("dark");
		if (!truecolorTheme) throw new Error("dark theme not found");
		expect(truecolorTheme.getColorMode()).toBe("truecolor");
		expect(truecolorTheme.getFgAnsi("accent")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
	});
});

describe("theme detection from RGB", () => {
	it("classifies RGB colors by luminance", () => {
		expect(getThemeForRgbColor({ r: 8, g: 8, b: 8 })).toBe("dark");
		expect(getThemeForRgbColor({ r: 250, g: 250, b: 250 })).toBe("light");
	});
});

describe("theme setting helpers", () => {
	it("parses and resolves automatic theme settings", () => {
		expect(parseAutoThemeSetting("light/dark")).toEqual({ lightTheme: "light", darkTheme: "dark" });
		expect(resolveThemeSetting("dark", "light")).toBe("dark");
		expect(resolveThemeSetting("light/dark", "light")).toBe("light");
		expect(resolveThemeSetting("light/dark", "dark")).toBe("dark");
		expect(resolveThemeSetting("light/dark/extra", "dark")).toBeUndefined();
	});
});

describe("selection theme", () => {
	it("uses Diffex blue for every shared selector", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark", false);

		expect(theme.getFgAnsi("startupIntroText")).toBe("\x1b[38;2;205;214;244m");
		expect(theme.getFgAnsi("startupIntroAccent")).toBe("\x1b[38;2;137;180;250m");
		expect(theme.getFgAnsi("thinkingMedium")).toBe(theme.getFgAnsi("startupIntroAccent"));
		expect(theme.getFgAnsi("selectionAccent")).toBe(theme.getFgAnsi("startupIntroAccent"));
		expect(getEditorTheme().selectList.selectedText("command")).toBe(
			`${theme.getFgAnsi("selectionAccent")}command\x1b[39m`,
		);
		expect(getEditorTheme().selectList.selectedPrefix("> ")).toBe(`${theme.getFgAnsi("selectionAccent")}> \x1b[39m`);
		expect(getSelectListTheme().selectedText("command")).toBe(`${theme.getFgAnsi("selectionAccent")}command\x1b[39m`);
		expect(getSettingsListTheme().cursor).toBe(
			`${theme.getFgAnsi("selectionAccent")}${SELECTED_LIST_PREFIX}\x1b[39m`,
		);
	});

	it("falls back for themes without selection or startup intro tokens", () => {
		const themeJson = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
		) as { name: string; colors: Record<string, unknown> };
		themeJson.name = "legacy-startup-intro-theme";
		delete themeJson.colors.startupIntroText;
		delete themeJson.colors.startupIntroAccent;
		delete themeJson.colors.selectionAccent;
		delete themeJson.colors.autocompleteSelected;
		const testDir = mkdtempSync(join(tmpdir(), "diffex-startup-intro-theme-"));
		tempDirs.push(testDir);
		const themePath = join(testDir, "legacy-startup-intro-theme.json");
		writeFileSync(themePath, JSON.stringify(themeJson));

		const legacyTheme = loadThemeFromPath(themePath, "truecolor");

		expect(legacyTheme.getFgAnsi("startupIntroText")).toBe(legacyTheme.getFgAnsi("text"));
		expect(legacyTheme.getFgAnsi("startupIntroAccent")).toBe(legacyTheme.getFgAnsi("mdLink"));
		expect(legacyTheme.getFgAnsi("selectionAccent")).toBe(legacyTheme.getFgAnsi("startupIntroAccent"));
		expect(legacyTheme.getFgAnsi("autocompleteSelected")).toBe(legacyTheme.getFgAnsi("selectionAccent"));
	});

	it("uses the legacy autocomplete color as the selection fallback", () => {
		const themeJson = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
		) as { name: string; colors: Record<string, unknown> };
		themeJson.name = "legacy-autocomplete-selection-theme";
		delete themeJson.colors.selectionAccent;
		themeJson.colors.autocompleteSelected = "#123456";
		const testDir = mkdtempSync(join(tmpdir(), "diffex-legacy-selection-theme-"));
		tempDirs.push(testDir);
		const themePath = join(testDir, "legacy-autocomplete-selection-theme.json");
		writeFileSync(themePath, JSON.stringify(themeJson));

		const legacyTheme = loadThemeFromPath(themePath, "truecolor");

		expect(legacyTheme.getFgAnsi("selectionAccent")).toBe(legacyTheme.getFgAnsi("autocompleteSelected"));
	});
});

describe("editor border theme", () => {
	it("keeps the editor border independent from thinking colors", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark", false);

		const expected = "\x1b[38;2;137;180;250m";
		expect(theme.getFgAnsi("editorBorder")).toBe(expected);
		expect(getEditorTheme().borderColor("line")).toBe(`${expected}line\x1b[39m`);
		expect(theme.getThinkingBorderColor("low")("line")).not.toBe(`${expected}line\x1b[39m`);
		expect(theme.getBashModeBorderColor()("line")).toBe("\x1b[38;2;204;102;102mline\x1b[39m");
	});

	it("uses the fixed light theme color", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("light", false);

		expect(theme.getFgAnsi("editorBorder")).toBe("\x1b[38;2;60;89;122m");
		expect(theme.getBashModeBorderColor()("line")).toBe("\x1b[38;2;170;85;85mline\x1b[39m");
	});

	it("falls back to borderMuted for existing custom themes", () => {
		const themeJson = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
		) as { name: string; colors: Record<string, unknown> };
		themeJson.name = "legacy-editor-border-theme";
		delete themeJson.colors.editorBorder;
		const testDir = mkdtempSync(join(tmpdir(), "diffex-editor-border-theme-"));
		tempDirs.push(testDir);
		const themePath = join(testDir, "legacy-editor-border-theme.json");
		writeFileSync(themePath, JSON.stringify(themeJson));

		const legacyTheme = loadThemeFromPath(themePath, "truecolor");

		expect(legacyTheme.getFgAnsi("editorBorder")).toBe(legacyTheme.getFgAnsi("borderMuted"));
	});
});
