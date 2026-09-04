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
		contentDigest: `sha256:${"1".repeat(64)}`,
		name: "duplicate",
		description: "General workflow",
		sourceKind: "installed",
		scope: "workspace",
		reference: "<first-reference/>",
		group: "installed-workspace",
		enabled: true,
	},
	{
		skillId: `skill:${"b".repeat(64)}`,
		version: `sha256:${"2".repeat(64)}`,
		contentDigest: `sha256:${"2".repeat(64)}`,
		name: "duplicate",
		description: "Special workflow",
		sourceKind: "installed",
		scope: "global",
		reference: "<second-reference/>",
		group: "installed-global",
		enabled: true,
	},
];

interface SkillsModeFixture {
	session: {
		createSkillReferences: ReturnType<typeof vi.fn>;
		setSkillEnabled: ReturnType<typeof vi.fn>;
	};
	editor: {
		getExpandedText: ReturnType<typeof vi.fn>;
		getText: ReturnType<typeof vi.fn>;
		setText: ReturnType<typeof vi.fn>;
		setTextWithTokens: ReturnType<typeof vi.fn>;
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
		session: {
			createSkillReferences: vi.fn(() => available),
			setSkillEnabled: vi.fn(() => true),
		},
		editor: {
			getExpandedText: vi.fn(() => "existing draft"),
			getText: vi.fn(() => "existing draft"),
			setText: vi.fn(),
			setTextWithTokens: vi.fn(),
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

		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\r");
		getSelector().handleInput("Special");
		getSelector().handleInput("\r");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.editor.setTextWithTokens).toHaveBeenCalledWith([
			{ value: "<second-reference/>", displayText: "duplicate" },
			"\n\n",
			"existing draft",
		]);
	});

	it("toggles skill enablement without closing or changing the editor", () => {
		const { fixture, getSelector, done } = createFixture();
		showSkillsSelector.call(fixture);

		getSelector().handleInput("\r");
		getSelector().handleInput(" ");

		expect(fixture.session.setSkillEnabled).toHaveBeenCalledWith(references[0]?.skillId, false);
		expect(done).not.toHaveBeenCalled();
		expect(fixture.editor.setText).not.toHaveBeenCalled();
		expect(fixture.editor.setTextWithTokens).not.toHaveBeenCalled();
	});

	it("cancels without changing the editor", () => {
		const { fixture, getSelector, done } = createFixture();
		showSkillsSelector.call(fixture);

		getSelector().handleInput("\u001b");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.editor.setText).not.toHaveBeenCalled();
		expect(fixture.editor.setTextWithTokens).not.toHaveBeenCalled();
	});

	it("reports when no skills are available", () => {
		const { fixture } = createFixture([]);
		showSkillsSelector.call(fixture);

		expect(fixture.showStatus).toHaveBeenCalledWith("No skills available");
	});
});
