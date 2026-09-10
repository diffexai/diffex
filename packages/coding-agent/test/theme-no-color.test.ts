import { type GlyphMode, getGlyphs } from "@diffexai/diffex-tui";
import { afterEach, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const originalNoColor = process.env.NO_COLOR;
const colorSgrPattern = /\u001b\[(?:3[89]|4[89])(?:;[0-9]+)*m/;

describe.sequential("NO_COLOR theme behavior", () => {
	afterEach(() => {
		if (originalNoColor === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = originalNoColor;
		}
		initTheme("dark", false);
	});

	test("suppresses foreground and background color sequences", () => {
		process.env.NO_COLOR = "1";
		initTheme("dark", false);

		const rendered = theme.fg("accent", "foreground") + theme.bg("selectedBg", "background");

		expect(rendered).toBe("foregroundbackground");
		expect(rendered).not.toMatch(colorSgrPattern);
		expect(theme.getFgAnsi("accent")).toBe("");
		expect(theme.getBgAnsi("selectedBg")).toBe("");
	});

	test("applies NO_COLOR and bash-mode glyph replacement through the default editor options", () => {
		process.env.NO_COLOR = "1";
		const settingsManager = {
			getShowHardwareCursor: () => false,
			getClearOnShrink: () => false,
			getEditorPaddingX: () => 0,
			getAutocompleteMaxVisible: () => 5,
			getHideThinkingBlock: () => false,
			getOutputPad: () => 1,
			getThemeSetting: () => "dark",
		};
		const runtimeHost = {
			session: {
				settingsManager,
				sessionManager: { getCwd: () => process.cwd() },
				resourceLoader: { getThemes: () => ({ themes: [] }) },
			},
			setBeforeSessionInvalidate() {},
			setRebindSession() {},
		} as unknown as ConstructorParameters<typeof InteractiveMode>[0];
		const interactiveMode = new InteractiveMode(runtimeHost, { tuiMode: "regular" });
		const interactiveModeState = interactiveMode as unknown as { isBashMode: boolean; defaultEditor: unknown };
		const editorStyles = interactiveModeState.defaultEditor as {
			promptStyle: (text: string) => string;
			textTokenStyle: (text: string) => string;
		};
		interactiveModeState.isBashMode = true;

		for (const mode of ["unicode", "ascii"] satisfies GlyphMode[]) {
			const prompt = `${getGlyphs(mode).selected} `;
			expect(editorStyles.promptStyle(prompt)).toBe("! ");
		}
		expect(editorStyles.textTokenStyle("token")).toBe("token");
		expect(editorStyles.textTokenStyle("token")).not.toMatch(colorSgrPattern);
	});

	test("treats an empty NO_COLOR value as color enabled", () => {
		process.env.NO_COLOR = "";
		initTheme("dark", false);

		expect(theme.getFgAnsi("accent")).toMatch(colorSgrPattern);
		expect(theme.getBgAnsi("selectedBg")).toMatch(colorSgrPattern);
	});
});
