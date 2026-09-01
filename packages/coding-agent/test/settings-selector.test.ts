import { CURSOR_MARKER, getGlyphs, setKeybindings, Text } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	ConfigSelectorComponent,
	type ScopedResolvedPaths,
} from "../src/modes/interactive/components/config-selector.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function settingsConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		showImages: true,
		imageWidthCells: 80,
		autoResizeImages: true,
		blockImages: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "sse",
		httpIdleTimeoutMs: 300_000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "low", "medium", "high"],
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		mermaidRenderingMode: "final",
		showCacheMissNotices: true,
		collapseChangelog: true,
		enableInstallTelemetry: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		outputPad: 1,
		autocompleteMaxVisible: 7,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: true,
		tuiMode: "regular",
		fullscreenScrollbar: "auto",
		warnings: {},
		...overrides,
	};
}

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("opens installed skill inspection and controls", () => {
		const createInstalledSkillsSettings = vi.fn(() => new Text("Installed skill controls"));
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ createInstalledSkillsSettings } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Installed skills") settingsList.handleInput(character);
		settingsList.handleInput("\r");

		expect(createInstalledSkillsSettings).toHaveBeenCalledOnce();
	});

	it("routes input through the installed skills submenu", () => {
		const resolved = {
			extensions: [],
			skills: [
				{
					path: "/tmp/skills/review/SKILL.md",
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: "/tmp/skills" },
				},
				{
					path: "/tmp/skills/deploy/SKILL.md",
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: "/tmp/skills" },
				},
			],
			prompts: [],
			themes: [],
		} satisfies ScopedResolvedPaths["global"];
		const selector = new SettingsSelectorComponent(settingsConfig(), {
			createInstalledSkillsSettings: (done: () => void) =>
				new ConfigSelectorComponent(
					{ global: resolved, project: resolved },
					SettingsManager.inMemory(),
					"/tmp/workspace",
					"/tmp/agent",
					done,
					() => {},
					() => {},
					24,
					"global",
					false,
				),
		} as unknown as SettingsCallbacks);
		const settingsList = selector.getSettingsList();
		selector.focused = true;

		for (const character of "Installed skills") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		expect(selector.render(80).join("\n")).toContain(CURSOR_MARKER);
		for (const character of "review") settingsList.handleInput(character);

		const filtered = stripAnsi(selector.render(80).join("\n"));
		expect(filtered).toContain("review");
		expect(filtered).not.toContain("deploy");

		settingsList.handleInput("\u001b");
		expect(selector.render(80).join("\n")).toContain(CURSOR_MARKER);
		const restored = stripAnsi(selector.render(80).join("\n"));
		expect(restored).toContain("Installed skills");
		expect(restored).not.toContain("Global Resources");

		settingsList.handleInput("\r");
		settingsList.handleInput("\u0003");
		const ctrlCRestored = stripAnsi(selector.render(80).join("\n"));
		expect(ctrlCRestored).toContain("Installed skills");
		expect(ctrlCRestored).not.toContain("Global Resources");
	});

	it("shows installed skill scope and path while persisting disablement", () => {
		const settingsManager = SettingsManager.inMemory();
		const resolved = {
			extensions: [],
			skills: [
				{
					path: "/tmp/skills/review/SKILL.md",
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: "/tmp/skills" },
				},
			],
			prompts: [],
			themes: [],
		} satisfies ScopedResolvedPaths["global"];
		const selector = new ConfigSelectorComponent(
			{ global: resolved, project: resolved },
			settingsManager,
			"/tmp/workspace",
			"/tmp/agent",
			() => {},
			() => {},
			() => {},
			24,
			"global",
			false,
		);
		const list = selector.getResourceList();

		const output = stripAnsi(list.render(160).join("\n"));
		expect(output).toContain("Path: /tmp/skills/review/SKILL.md");
		expect(output).toContain("Source: auto · scope: user · enabled");
		list.handleInput(" ");

		expect(settingsManager.getSkillPaths()).toContain("-review/SKILL.md");
	});

	it("cycles through fullscreen scrollbar modes", () => {
		const onChange = vi.fn();
		const selector = new SettingsSelectorComponent(settingsConfig(), {
			onFullscreenScrollbarChange: onChange,
		} as unknown as SettingsCallbacks);
		const settingsList = selector.getSettingsList();

		for (const character of "Fullscreen scrollbar") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});

	it("renders an open settings surface without full-width framing", () => {
		const selector = new SettingsSelectorComponent(settingsConfig(), {} as SettingsCallbacks);
		const lines = stripAnsi(selector.render(80).join("\n"))
			.split("\n")
			.map((line) => line.trimEnd());

		expect(lines.slice(0, 3)).toEqual([" Settings", " Search and adjust how Diffex looks and behaves.", ""]);
		expect(lines.join("\n")).toContain(`${getGlyphs().selected} Auto-compact`);
		expect(lines.at(-1)).toContain("Type to search · Enter/Space to change · Esc to cancel");
		expect(lines.some((line) => /^─+$/.test(line))).toBe(false);
	});

	it("propagates focus to the settings search field", () => {
		const selector = new SettingsSelectorComponent(settingsConfig(), {} as SettingsCallbacks);

		selector.focused = true;
		expect(selector.getSettingsList().focused).toBe(true);
		expect(selector.render(80).join("\n")).toContain(CURSOR_MARKER);

		selector.focused = false;
		expect(selector.getSettingsList().focused).toBe(false);
		expect(selector.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	});

	it("keeps the hierarchy readable at narrow widths", () => {
		const selector = new SettingsSelectorComponent(settingsConfig(), {} as SettingsCallbacks);
		const lines = stripAnsi(selector.render(52).join("\n"))
			.split("\n")
			.map((line) => line.trimEnd());

		expect(lines[0]).toBe(" Settings");
		expect(lines.join("\n")).toContain("Search and adjust how Diffex looks and behaves.");
		expect(lines.at(-1)).toContain("Enter/Space change · Esc close");
		expect(lines.every((line) => Array.from(line).length <= 52)).toBe(true);
	});

	it("keeps the settings title, search field, and controls visible at 60x12", () => {
		let viewportRows = 12;
		const selector = new SettingsSelectorComponent(settingsConfig(), {} as SettingsCallbacks, {
			getViewportRows: () => viewportRows,
		});
		const compactLines = stripAnsi(selector.render(60).join("\n"))
			.split("\n")
			.map((line) => line.trimEnd());

		expect(compactLines[0]).toBe(" Settings");
		expect(compactLines[1]).toBe(">");
		expect(compactLines.join("\n")).toContain(`${getGlyphs().selected} Auto-compact`);
		expect(compactLines.join("\n")).toContain("(1/27)");
		expect(compactLines.at(-1)).toContain("Type to search · Enter/Space change · Esc close");
		expect(compactLines).toHaveLength(8);
		expect(compactLines.every((line) => Array.from(line).length <= 60)).toBe(true);

		viewportRows = 24;
		const restoredLines = stripAnsi(selector.render(80).join("\n"))
			.split("\n")
			.map((line) => line.trimEnd());
		expect(restoredLines.slice(0, 3)).toEqual([" Settings", " Search and adjust how Diffex looks and behaves.", ""]);
		expect(restoredLines.at(-1)).toContain("Type to search · Enter/Space to change · Esc to cancel");
	});

	it("opens and applies a thinking-level submenu without changing its controls", () => {
		const onThinkingLevelChange = vi.fn();
		const selector = new SettingsSelectorComponent(settingsConfig(), {
			onThinkingLevelChange,
		} as unknown as SettingsCallbacks);
		const settingsList = selector.getSettingsList();

		for (const character of "Thinking level") settingsList.handleInput(character);
		settingsList.handleInput("\r");

		const submenu = stripAnsi(selector.render(80).join("\n"))
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n");
		expect(submenu).toContain(" Thinking Level\n Select reasoning depth for thinking-capable models\n");
		expect(submenu).toContain("enter select  escape/ctrl+c back");

		settingsList.handleInput("\u001b[B");
		settingsList.handleInput("\r");

		expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("Thinking level");
	});
});
