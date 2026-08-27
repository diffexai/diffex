import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SkillReference } from "../src/core/skills.ts";
import type { SkillSelectorComponent } from "../src/modes/interactive/components/skill-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const references: SkillReference[] = [
	{
		skillId: `skill:${"a".repeat(64)}`,
		version: `sha256:${"1".repeat(64)}`,
		name: "duplicate",
		description: "General workflow",
		reference: "<first-reference/>",
	},
	{
		skillId: `skill:${"b".repeat(64)}`,
		version: `sha256:${"2".repeat(64)}`,
		name: "duplicate",
		description: "Special workflow",
		reference: "<second-reference/>",
	},
];

interface SkillsModeFixture {
	session: { createSkillReferences: ReturnType<typeof vi.fn> };
	editor: {
		getExpandedText: ReturnType<typeof vi.fn>;
		getText: ReturnType<typeof vi.fn>;
		setText: ReturnType<typeof vi.fn>;
	};
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showSelector: (
		create: (done: () => void) => { component: SkillSelectorComponent; focus: SkillSelectorComponent },
	) => void;
	showStatus: ReturnType<typeof vi.fn>;
}

const showSkillsSelector = Reflect.get(InteractiveMode.prototype, "showSkillsSelector") as (
	this: SkillsModeFixture,
) => void;

function createFixture(available: SkillReference[] = references): {
	fixture: SkillsModeFixture;
	getSelector: () => SkillSelectorComponent;
	done: ReturnType<typeof vi.fn>;
} {
	let selector: SkillSelectorComponent | undefined;
	const done = vi.fn();
	const fixture: SkillsModeFixture = {
		session: { createSkillReferences: vi.fn(() => available) },
		editor: {
			getExpandedText: vi.fn(() => "existing draft"),
			getText: vi.fn(() => "existing draft"),
			setText: vi.fn(),
		},
		ui: { requestRender: vi.fn() },
		showSelector: (create) => {
			selector = create(done).component;
		},
		showStatus: vi.fn(),
	};
	return {
		fixture,
		getSelector: () => {
			if (!selector) throw new Error("Skill selector was not shown");
			return selector;
		},
		done,
	};
}

describe("InteractiveMode skill selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("inserts the selected stable reference before the existing draft", () => {
		const { fixture, getSelector, done } = createFixture();
		showSkillsSelector.call(fixture);

		getSelector().handleInput("Special");
		getSelector().handleInput("\r");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.editor.setText).toHaveBeenCalledWith("<second-reference/>\n\nexisting draft");
	});

	it("cancels without changing the editor", () => {
		const { fixture, getSelector, done } = createFixture();
		showSkillsSelector.call(fixture);

		getSelector().handleInput("\u001b");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.editor.setText).not.toHaveBeenCalled();
	});

	it("reports when no skills are available", () => {
		const { fixture } = createFixture([]);
		showSkillsSelector.call(fixture);

		expect(fixture.showStatus).toHaveBeenCalledWith("No skills available");
	});
});
