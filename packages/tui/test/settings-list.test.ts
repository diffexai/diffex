import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { ACTIVE_ROW_MARKER, type Component, CURSOR_MARKER, type Focusable } from "../src/tui.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

class FocusableSubmenu implements Component, Focusable {
	focused = false;

	render(_width: number): string[] {
		return [`${this.focused ? CURSOR_MARKER : ""}submenu`];
	}

	invalidate(): void {}
}

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("uses a compact, width-safe layout in narrow terminals", () => {
		const list = new SettingsList(
			[
				{
					...items[0]!,
					description: "Choose how Diffex uses the terminal viewport.",
				},
			],
			10,
			testTheme,
			() => {},
			() => {},
		);

		const rendered = list.render(32);

		assert.ok(rendered.every((line) => line !== ""));
		assert.ok(rendered.every((line) => visibleWidth(line) <= 32));
		assert.ok(rendered[0]!.includes(ACTIVE_ROW_MARKER));
		assert.match(stripTerminalSequences(rendered[0]!), /^> TUI mode/);
		assert.match(rendered.at(-1)!, /Enter\/Space change/);
	});

	it("can compact a searchable list to a short viewport without losing its search hint", () => {
		const list = new SettingsList(
			Array.from({ length: 6 }, (_, index) => ({
				id: `setting-${index}`,
				label: `Setting ${index}`,
				description: index === 0 ? "Selected setting description" : undefined,
				currentValue: "true",
				values: ["true", "false"],
			})),
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		list.setMaxVisible(3);
		list.setCompactMode(true);

		const rendered = list.render(80);

		assert.strictEqual(rendered.length, 7);
		assert.ok(rendered.every((line) => line !== ""));
		assert.match(rendered[4]!, /\(1\/6\)/);
		assert.match(rendered.at(-1)!, /Type to search.*Enter\/Space change.*Esc close/);
	});

	it("moves focus between its search input and a focusable submenu", () => {
		let submenu: FocusableSubmenu | undefined;
		let closeSubmenu: (() => void) | undefined;
		const list = new SettingsList(
			[
				{
					id: "nested",
					label: "Nested",
					currentValue: "configure",
					submenu: (_currentValue, done) => {
						submenu = new FocusableSubmenu();
						closeSubmenu = done;
						return submenu;
					},
				},
			],
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);

		list.focused = true;
		assert.ok(list.render(80)[0]?.includes(CURSOR_MARKER));

		list.handleInput("\r");
		assert.ok(submenu);
		assert.strictEqual(submenu.focused, true);
		assert.ok(list.render(80)[0]?.includes(CURSOR_MARKER));

		list.focused = false;
		assert.strictEqual(submenu.focused, false);
		list.focused = true;
		assert.strictEqual(submenu.focused, true);

		assert.ok(closeSubmenu);
		closeSubmenu();
		assert.strictEqual(submenu.focused, false);
		assert.ok(list.render(80)[0]?.includes(CURSOR_MARKER));

		list.focused = false;
		assert.ok(!list.render(80)[0]?.includes(CURSOR_MARKER));
	});
});
