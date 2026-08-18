import { setKeybindings } from "@earendil-works/diffex-tui";
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
};

const child: HarnessVersionSelectorItem = {
	version: `sha256:${"b".repeat(64)}`,
	base: root.version,
	memory: "\nPrefer precise answers.\nMore detail.",
};

const branch: HarnessVersionSelectorItem = {
	version: `sha256:${"c".repeat(64)}`,
	base: root.version,
	memory: "Use branch memory.",
};

const unavailable: HarnessVersionSelectorItem = {
	version: `sha256:${"0".repeat(64)}`,
	base: child.version,
	memory: undefined,
	diagnostic: "unsupported artifact kind: skill",
};

describe("HarnessVersionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("orders the current version, its ancestors, and deterministic remainder", () => {
		expect(orderHarnessVersions([unavailable, branch, root, child], child.version)).toEqual([
			child,
			root,
			branch,
			unavailable,
		]);
	});

	it("maps valid bundles and version diagnostics without exposing pointer-only diagnostics", () => {
		expect(
			createHarnessVersionSelectorItems(
				[{ manifest: { version: child.version, base: root.version }, state: { memory: child.memory ?? "" } }],
				[
					{
						version: unavailable.version,
						message: unavailable.diagnostic!,
						manifest: { version: unavailable.version, base: child.version },
						state: { memory: "Future skill revision." },
					},
					{ version: null, message: "current.json is malformed" },
				],
			),
		).toEqual([child, { ...unavailable, memory: "Future skill revision." }]);
	});

	it("renders lineage, memory previews, current state, and unavailable diagnostics", () => {
		const selector = new HarnessVersionSelectorComponent(
			[unavailable, branch, root, child],
			child.version,
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(180).join("\n"));
		const childIndex = output.indexOf("sha256:bbbbbbbbbbbb [current]");
		const rootIndex = output.indexOf("sha256:aaaaaaaaaaaa");
		const branchIndex = output.indexOf("sha256:cccccccccccc");

		expect(childIndex).toBeGreaterThanOrEqual(0);
		expect(rootIndex).toBeGreaterThan(childIndex);
		expect(branchIndex).toBeGreaterThan(rootIndex);
		expect(output).toContain("base sha256:aaaaaaaaaaaa - Prefer precise answers.");
		expect(output).toContain("root - (empty EVOLVE.md)");
		expect(output).toContain("(EVOLVE.md unavailable)");
		expect(output).toContain("unavailable: unsupported artifact kind: skill");
	});

	it("removes terminal control sequences from memory and diagnostics", () => {
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
		expect(stripAnsi(output)).toContain("unsafe");
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
		expect(output).toContain("sha256:cccccccccccc");
		expect(output).not.toContain("sha256:bbbbbbbbbbbb");

		selector.getSearchInput().setValue("");
		selector.handleInput("branch");
		output = stripAnsi(selector.render(180).join("\n"));
		expect(output).toContain("Use branch memory.");
		expect(output).not.toContain("Prefer precise answers.");
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

	it("cancels without selecting", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new HarnessVersionSelectorComponent([root], root.version, onSelect, onCancel);

		selector.handleInput("\u001b");

		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});
});
