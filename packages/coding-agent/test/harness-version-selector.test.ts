import { setKeybindings, visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	createHarnessVersionSelectorItems,
	HarnessVersionSelectorComponent,
	type HarnessVersionSelectorItem,
	orderHarnessVersions,
} from "../src/modes/interactive/components/harness-version-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const root: HarnessVersionSelectorItem = {
	version: `sha256:${"a".repeat(64)}`,
	base: null,
	memory: "",
	skills: [],
	display: {
		version: `sha256:${"a".repeat(64)}`,
		kind: "default",
		evolvedAt: null,
		evolvedIn: null,
	},
};

const child: HarnessVersionSelectorItem = {
	version: `sha256:${"b".repeat(64)}`,
	base: root.version,
	memory: "\nLesson 1: Prefer precise answers.\nMore detail.",
	skills: [],
	display: {
		version: `sha256:${"b".repeat(64)}`,
		kind: "evolved",
		evolvedAt: new Date(2026, 6, 28, 21, 30).toISOString(),
		evolvedIn: "/projects/child",
	},
};

const branch: HarnessVersionSelectorItem = {
	version: `sha256:${"c".repeat(64)}`,
	base: root.version,
	memory: "Use branch memory.",
	skills: [],
	display: {
		version: `sha256:${"c".repeat(64)}`,
		kind: "evolved",
		evolvedAt: new Date(2026, 6, 29, 10, 15).toISOString(),
		evolvedIn: "/projects/branch",
	},
};

const unavailable: HarnessVersionSelectorItem = {
	version: `sha256:${"0".repeat(64)}`,
	base: child.version,
	memory: undefined,
	skills: undefined,
	display: {
		version: `sha256:${"0".repeat(64)}`,
		kind: "evolved",
		evolvedAt: null,
		evolvedIn: null,
	},
	diagnostic: "unsupported artifact kind: skill",
};

const skill = {
	name: "verify-runtime",
	path: "skills/verify-runtime/SKILL.md",
	description: "Verify activated components.",
	content: "# Verify runtime\nRead the exact runtime artifacts.",
	packageVersion: `sha256:${"d".repeat(64)}`,
	workspace: { repositoryId: "repo", directoryId: "directory" },
	files: [
		{
			path: "references/check.md",
			filePath: "/bundle/references/check.md",
			content: "Check.",
			contentHash: `sha256:${"e".repeat(64)}`,
		},
	],
};

const skilledChild: HarnessVersionSelectorItem = { ...child, skills: [skill] };

describe("HarnessVersionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("orders activations newest first with deterministic unknowns and diagnostics last", () => {
		expect(orderHarnessVersions([unavailable, branch, root, child])).toEqual([branch, child, root, unavailable]);
	});

	it("maps valid bundles and version diagnostics without exposing pointer-only diagnostics", () => {
		expect(
			createHarnessVersionSelectorItems(
				[
					{
						manifest: { version: child.version, base: root.version },
						state: { memory: child.memory ?? "", skills: [] },
					},
				],
				[
					{
						version: unavailable.version,
						message: unavailable.diagnostic!,
						manifest: { version: unavailable.version, base: child.version },
						state: { memory: "Future skill revision.", skills: [] },
					},
					{ version: null, message: "current.json is malformed" },
				],
				[
					{
						version: child.version,
						kind: "evolved",
						evolvedAt: child.display.evolvedAt,
						evolvedIn: child.display.evolvedIn,
					},
					unavailable.display,
				],
			),
		).toEqual([child, { ...unavailable, memory: "Future skill revision.", skills: [] }]);
	});

	it("includes all validated bundles even without display provenance", () => {
		expect(
			createHarnessVersionSelectorItems(
				[
					{ manifest: { version: root.version, base: null }, state: { memory: root.memory ?? "", skills: [] } },
					{
						manifest: { version: child.version, base: root.version },
						state: { memory: child.memory ?? "", skills: [] },
					},
					{
						manifest: { version: branch.version, base: root.version },
						state: { memory: branch.memory ?? "", skills: [] },
					},
				],
				[],
				[root.display, child.display],
			).map((item) => item.version),
		).toEqual([root.version, child.version, branch.version]);
	});

	it("renders timestamps first, then counts and hashes, without pinning current state", () => {
		const selector = new HarnessVersionSelectorComponent(
			[unavailable, branch, root, child],
			child.version,
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(180).join("\n"));
		const childIndex = output.indexOf("7/28 at 9:30 pm · 1 lessons · 0 skills · bbbbbbbbbbbb [current]");
		const rootIndex = output.indexOf("unknown time · 0 lessons · 0 skills · aaaaaaaaaaaa");
		const branchIndex = output.indexOf("7/29 at 10:15 am · 0 lessons · 0 skills · cccccccccccc");

		expect(branchIndex).toBeGreaterThanOrEqual(0);
		expect(childIndex).toBeGreaterThan(branchIndex);
		expect(rootIndex).toBeGreaterThan(childIndex);
		expect(output).toContain(branch.version);
		expect(output).toContain("1 lessons · 0 skills");
		expect(output).toContain("EVOLVE.md");
		expect(output).toContain("unavailable: unsupported artifact kind: skill");
		selector.handleInput("\u001b[B");
		expect(stripAnsi(selector.render(180).join("\n"))).toContain("More detail.");
	});

	it("removes terminal control sequences from diagnostics", () => {
		const selector = new HarnessVersionSelectorComponent(
			[
				{
					...unavailable,
					memory: "\u001b]8;;https://example.com\u0007unsafe\u001b]8;;\u0007 preview",
					diagnostic: "bad\u001b[2J bundle\rdiagnostic",
				},
			],
			undefined,
			() => {},
			() => {},
		);

		const output = selector.render(180).join("\n");
		expect(output).not.toContain("\u001b]8;;https://example.com");
		expect(output).not.toContain("\u001b[2J");
		expect(output).not.toContain("\r");
		expect(stripAnsi(output)).toContain("bundle diagnostic");
	});

	it("searches the full hash and displayed memory preview", () => {
		const selector = new HarnessVersionSelectorComponent(
			[root, child, branch],
			child.version,
			() => {},
			() => {},
		);

		selector.handleInput("c".repeat(20));
		let output = stripAnsi(selector.render(180).join("\n"));
		expect(output).toContain("/projects/branch");
		expect(output).not.toContain("/projects/child");

		selector.getSearchInput().setValue("");
		selector.handleInput("Use branch memory");
		output = stripAnsi(selector.render(180).join("\n"));
		expect(output).toContain("/projects/branch");
		expect(output).not.toContain("/projects/child");
	});

	it("navigates, selects available versions, and ignores unavailable versions", () => {
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([child, unavailable], child.version, onSelect, () => {});

		selector.handleInput("\u001b[B");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();

		selector.handleInput("\u001b[A");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith(child.version);
	});

	it("uses deterministic hash ordering for equal, absent, and invalid timestamps", () => {
		const tied = { ...child, display: { ...child.display, evolvedAt: branch.display.evolvedAt } };
		const unknown = {
			...unavailable,
			diagnostic: undefined,
			display: { ...unavailable.display, evolvedAt: "bad date" },
		};
		expect(orderHarnessVersions([root, branch, unknown, tied])).toEqual([tied, branch, unknown, root]);
		expect(orderHarnessVersions([tied, unknown, branch, root])).toEqual([tied, branch, unknown, root]);
	});

	it("keeps provenance-less diagnostic rows visible but unselectable", () => {
		const items = createHarnessVersionSelectorItems([], [{ version: unavailable.version, message: "bad bundle" }]);
		expect(items).toHaveLength(1);
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent(items, unavailable.version, onSelect, () => {});
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("bad bundle");
	});

	it("does not select a diagnostic row with an empty diagnostic message", () => {
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent(
			[{ ...root, diagnostic: "" }],
			root.version,
			onSelect,
			() => {},
		);
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("restores selection after navigating an empty search result", () => {
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([root], root.version, onSelect, () => {});
		selector.handleInput("zzzzzz");
		selector.handleInput("\u001b[B");
		selector.getSearchInput().setValue("");
		selector.handleInput("\u007f");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(root.version);
	});

	it("requires explicit confirmation before removing current skills", () => {
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([skilledChild, root], child.version, onSelect, () => {});
		selector.handleInput("\u001b[B");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("skills removed: 1");
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Skills removed: verify-runtime");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("confirm changes");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(root.version);
	});

	it("cancels confirmation and clears it when navigation or search changes", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new HarnessVersionSelectorComponent([skilledChild, root], child.version, onSelect, onCancel);
		selector.handleInput("\u001b[B");
		selector.handleInput("\n");
		selector.handleInput("\u001b");
		expect(onCancel).not.toHaveBeenCalled();
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("\u001b[A");
		selector.handleInput("\u001b[B");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("a".repeat(20));
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(root.version);
	});

	it("shows same-identity package updates and skill activation provenance", () => {
		const updated = {
			...branch,
			skills: [{ ...skill, packageVersion: root.version }],
			display: { ...branch.display, origin: "skill" as const },
		};
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([skilledChild, updated], child.version, onSelect, () => {});
		const output = stripAnsi(selector.render(180).join("\n"));
		expect(output).toContain("Origin: skill activation");
		expect(output).toContain("skills removed: 0 · updated: 1");
		expect(output).toContain("Skills updated: verify-runtime");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(180).join("\n"))).toContain("confirm changes");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(branch.version);
	});

	it("detects skill losses even when the replacement has the same name and count", () => {
		const replacement = { ...branch, skills: [{ ...skill, workspace: { repositoryId: "other" } }] };
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent(
			[skilledChild, replacement],
			child.version,
			onSelect,
			() => {},
		);
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("skills removed: 1");
	});

	it("exposes the full memory and skill inventory through width-safe detail paging", () => {
		const memory = Array.from({ length: 25 }, (_, index) => `Lesson ${index + 1}: Detail ${index + 1}.`).join("\n\n");
		const selector = new HarnessVersionSelectorComponent(
			[{ ...skilledChild, memory }],
			child.version,
			() => {},
			() => {},
		);
		const pages: string[] = [];
		for (let index = 0; index < 30; index++) {
			const rendered = selector.render(60);
			expect(rendered.every((line) => visibleWidth(line) <= 60)).toBe(true);
			pages.push(stripAnsi(rendered.join("\n")));
			selector.handleInput("\u001b[6~");
		}
		const output = pages.join("\n");
		expect(output).toContain("Lesson 25: Detail 25.");
		expect(output).toContain("Skills (complete bundle inventory)");
		expect(output).toContain("Verify activated components.");
		expect(output).toContain("Read the exact runtime artifacts.");
		expect(output).toContain("references/check.md");
		for (let index = 0; index < 30; index++) selector.handleInput("\u001b[5~");
		expect(stripAnsi(selector.render(60).join("\n"))).toContain("Bundle details (1-");
	});

	it("keeps the list, warning, details and confirmation controls usable at 80x24", () => {
		const current = {
			...skilledChild,
			skills: [skill, { ...skill, name: "removed", path: "skills/removed/SKILL.md" }],
		};
		const updated = { ...branch, skills: [{ ...skill, packageVersion: root.version }] };
		const items = [
			updated,
			current,
			...Array.from({ length: 15 }, (_, index) => ({ ...root, version: `unknown-${index}` })),
		];
		const selector = new HarnessVersionSelectorComponent(
			items,
			current.version,
			() => {},
			() => {},
		);
		selector.handleInput("\n");
		const rendered = selector.render(80);
		expect(rendered.length).toBeLessThanOrEqual(22);
		expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
		const output = stripAnsi(rendered.join("\n"));
		expect(output).toContain("7/29 at 10:15 am · 0 lessons · 1 skills · cccccccccccc");
		expect(output).toContain("skills removed: 1 · updated: 1");
		expect(output).toContain("confirm changes");
		expect(output).toContain("details down");
		expect(output).toContain("cancel");
	});

	it("requires confirmation if the selected bundle inventory is missing", () => {
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([root], "missing-selected-bundle", onSelect, () => {});
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("comparison incomplete");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(root.version);
	});

	it("reports known observed losses even when the selected pointer inventory is unavailable", () => {
		const observed = [
			skill,
			{ ...skill, name: "second", path: "skills/second/SKILL.md" },
			{ ...skill, name: "third", path: "skills/third/SKILL.md" },
		];
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([root], "missing-pointer", onSelect, () => {}, observed);
		const output = stripAnsi(selector.render(80).join("\n"));
		expect(output).toContain("skills removed: 3 · updated: 0 · comparison incomplete");
		expect(output).toContain("Skills removed: verify-runtime, second, third");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("confirm changes");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(root.version);
	});

	it("deduplicates removals by skill identity across the pointer and observed session", () => {
		const onSelect = vi.fn();
		const selector = new HarnessVersionSelectorComponent([root, skilledChild], child.version, onSelect, () => {}, [
			skill,
		]);
		selector.handleInput("\u001b[B");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("skills removed: 1 · updated: 0");
		selector.handleInput("\n");
		expect(onSelect).not.toHaveBeenCalled();
	});

	it.each(["pointer", "session"])(
		"confirms an update when the target package differs from the %s baseline",
		(baseline) => {
			const different = { ...skill, packageVersion: root.version };
			const current = { ...skilledChild, skills: [baseline === "pointer" ? different : skill] };
			const target = { ...branch, skills: [skill] };
			const onSelect = vi.fn();
			const selector = new HarnessVersionSelectorComponent([current, target], current.version, onSelect, () => {}, [
				baseline === "session" ? different : skill,
			]);
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("skills removed: 0 · updated: 1");
			selector.handleInput("\n");
			expect(onSelect).not.toHaveBeenCalled();
			selector.handleInput("\n");
			expect(onSelect).toHaveBeenCalledExactlyOnceWith(target.version);
		},
	);

	it("searches skills and memory beyond the first line", () => {
		const selector = new HarnessVersionSelectorComponent(
			[root, skilledChild],
			root.version,
			() => {},
			() => {},
		);
		selector.handleInput("verify-runtime");
		expect(stripAnsi(selector.render(180).join("\n"))).toContain("1 lessons · 1 skills");
		selector.getSearchInput().setValue("");
		selector.handleInput("More detail");
		expect(stripAnsi(selector.render(180).join("\n"))).toContain(child.version);
	});

	it("cancels without selecting", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new HarnessVersionSelectorComponent([root], root.version, onSelect, onCancel);

		selector.handleInput("\u001b");

		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});
});
