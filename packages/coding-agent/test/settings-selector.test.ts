import { setKeybindings, Text } from "@earendil-works/diffex-tui";
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
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ onFullscreenScrollbarChange: onChange } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Fullscreen scrollbar") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});
});
