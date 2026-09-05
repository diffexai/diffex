import type { HarnessSkill } from "@earendil-works/diffex-harness-state";
import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { HarnessVersionSelectorComponent } from "../src/modes/interactive/components/harness-version-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const rootVersion = `sha256:${"a".repeat(64)}`;
const childVersion = `sha256:${"b".repeat(64)}`;
const rootLabel = "unknown time · 0 lessons · 0 skills · aaaaaaaaaaaa [current]";
const childLabel = "7/28 at 9:30 pm · 1 lessons · 0 skills · bbbbbbbbbbbb [current]";

const skill: HarnessSkill = {
	name: "verify-runtime",
	path: "skills/verify-runtime/SKILL.md",
	filePath: "/bundle/skills/verify-runtime/SKILL.md",
	baseDir: "/bundle/skills/verify-runtime",
	description: "Verify runtime activation.",
	content: "# Verify runtime",
	contentHash: `sha256:${"c".repeat(64)}`,
	packageVersion: `sha256:${"d".repeat(64)}`,
	workspace: { repositoryId: "repo", directoryId: "directory" },
	files: [],
	disableModelInvocation: false,
};

interface HarnessModeFixture {
	options: {
		evolution?: {
			listCurrentDirectoryHarnessVersions: ReturnType<typeof vi.fn>;
			listCurrentDirectoryHarnessVersionInfo: ReturnType<typeof vi.fn>;
			overview: ReturnType<typeof vi.fn>;
		};
	};
	session: {
		activeHarnessVersion: string | undefined;
		harnessVersionBundle?: { state: { skills: readonly HarnessSkill[] } };
		listHarnessVersions: ReturnType<typeof vi.fn>;
		switchHarnessVersion: ReturnType<typeof vi.fn>;
	};
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showSelector: (
		create: (done: () => void) => {
			component: HarnessVersionSelectorComponent;
			focus: HarnessVersionSelectorComponent;
		},
	) => void;
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
}

const interactiveHarnessMethods = (
	InteractiveMode as unknown as {
		prototype: { showHarnessVersionSelector(this: HarnessModeFixture): Promise<void> };
	}
).prototype;

function createFixture(switchHarnessVersion = vi.fn().mockResolvedValue(undefined)) {
	let selector: HarnessVersionSelectorComponent | undefined;
	const done = vi.fn();
	const listing = {
		currentVersion: rootVersion,
		versions: [
			{ manifest: { version: rootVersion, base: null }, state: { memory: "", skills: [] as HarnessSkill[] } },
			{
				manifest: { version: childVersion, base: rootVersion },
				state: { memory: "Lesson 1: Use the child memory.", skills: [] as HarnessSkill[] },
			},
		],
		diagnostics: [],
	};
	const evolution = {
		overview: vi.fn().mockResolvedValue({ activeJob: null }),
		listCurrentDirectoryHarnessVersions: vi.fn().mockResolvedValue(listing),
		listCurrentDirectoryHarnessVersionInfo: vi.fn().mockResolvedValue([
			{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null },
			{
				version: childVersion,
				kind: "evolved",
				evolvedAt: new Date(2026, 6, 28, 21, 30).toISOString(),
				evolvedIn: "/projects/child",
			},
		]),
	};
	const fixture: HarnessModeFixture = {
		options: { evolution },
		session: {
			activeHarnessVersion: rootVersion,
			listHarnessVersions: vi.fn().mockResolvedValue(listing),
			switchHarnessVersion,
		},
		ui: { requestRender: vi.fn() },
		showSelector: (create) => {
			selector = create(done).component;
		},
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	};
	return {
		fixture,
		evolution,
		listing,
		done,
		getSelector: () => {
			if (!selector) throw new Error("Harness version selector was not shown");
			return selector;
		},
	};
}

describe("InteractiveMode harness version selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("delegates even a captured matching selection to the switch API for a fresh pointer check", async () => {
		const { fixture, evolution, getSelector, done } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");
		expect(evolution.listCurrentDirectoryHarnessVersions).toHaveBeenCalledOnce();
		expect(fixture.session.listHarnessVersions).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${rootLabel}`));
		expect(done).toHaveBeenCalledOnce();
		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledExactlyOnceWith(rootVersion);
	});

	it("selects the newest activation first even when an older version is current", async () => {
		const { fixture, getSelector, done } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		const output = stripAnsi(getSelector().render(80).join("\n"));
		expect(output.indexOf("bbbbbbbbbbbb")).toBeLessThan(output.indexOf("aaaaaaaaaaaa"));
		getSelector().handleInput("\n");
		await vi.waitFor(() => {
			expect(fixture.session.switchHarnessVersion).toHaveBeenCalledWith(childVersion);
			expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${childLabel}`);
		});
		expect(done).toHaveBeenCalledOnce();
	});

	it("warns when switching harnesses during an active evolution", async () => {
		const { fixture, evolution, getSelector } = createFixture();
		evolution.overview.mockResolvedValue({ activeJob: { jobId: "job-active" } });
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\n");
		await vi.waitFor(() => {
			expect(fixture.showWarning).toHaveBeenCalledWith(
				"An evolution job is still running from its original harness. Its memory activation cannot replace this selection; separate skill work may activate later revisions.",
			);
		});
		expect(fixture.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Harness version:"));
	});

	it("marks the persisted pointer, and reselects a session version when that pointer differs", async () => {
		const { fixture, getSelector, done } = createFixture();
		fixture.session.activeHarnessVersion = childVersion;
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		const output = stripAnsi(getSelector().render(80).join("\n"));
		expect(output).toContain("aaaaaaaaaaaa [current]");
		expect(output).not.toContain("bbbbbbbbbbbb [current]");
		getSelector().handleInput("\n");
		await vi.waitFor(() => expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${childLabel}`));
		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledExactlyOnceWith(childVersion);
		expect(done).toHaveBeenCalledOnce();
	});

	it("refreshes a stale session when selecting the already-current persisted bundle", async () => {
		const { fixture, listing, getSelector } = createFixture();
		listing.currentVersion = childVersion;
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\n");
		await vi.waitFor(() => expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${childLabel}`));
		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledExactlyOnceWith(childVersion);
	});

	it("confirms skill removal relative to the newer global pointer before reselecting a stale session bundle", async () => {
		const { fixture, listing, getSelector } = createFixture();
		listing.currentVersion = childVersion;
		listing.versions[1]!.state.skills = [skill];
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\u001b[B");
		expect(stripAnsi(getSelector().render(80).join("\n"))).toContain("skills removed: 1");
		getSelector().handleInput("\n");
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
		getSelector().handleInput("\n");
		await vi.waitFor(() => expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${rootLabel}`));
		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledExactlyOnceWith(rootVersion);
	});

	it("calls the switch API when background activation moves the pointer after the picker opens", async () => {
		const { fixture, listing, getSelector } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		listing.currentVersion = childVersion;
		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");
		await vi.waitFor(() => expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${rootLabel}`));
		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledExactlyOnceWith(rootVersion);
	});

	it("confirms observed session skill losses when the pointer has already retired them", async () => {
		const { fixture, getSelector } = createFixture();
		fixture.session.activeHarnessVersion = childVersion;
		fixture.session.harnessVersionBundle = {
			state: {
				skills: [
					skill,
					{ ...skill, name: "second", path: "skills/second/SKILL.md" },
					{ ...skill, name: "third", path: "skills/third/SKILL.md" },
				],
			},
		};
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\u001b[B");
		const output = stripAnsi(getSelector().render(80).join("\n"));
		expect(output).toContain("skills removed: 3");
		expect(output).toContain("Skills removed: verify-runtime, second, third");
		getSelector().handleInput("\n");
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
		getSelector().handleInput("\n");
		await vi.waitFor(() => expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${rootLabel}`));
		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledExactlyOnceWith(rootVersion);
	});

	it("uses validated compatible membership even when display metadata is absent", async () => {
		const { fixture, evolution, getSelector } = createFixture();
		evolution.listCurrentDirectoryHarnessVersionInfo.mockResolvedValue([]);
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		const output = stripAnsi(getSelector().render(80).join("\n"));
		expect(output).toContain("aaaaaaaaaaaa");
		expect(output).toContain("bbbbbbbbbbbb");
		expect(fixture.session.listHarnessVersions).not.toHaveBeenCalled();
	});

	it("does not leak raw session versions excluded by the compatible catalog", async () => {
		const { fixture, evolution, listing, getSelector } = createFixture();
		evolution.listCurrentDirectoryHarnessVersions.mockResolvedValue({ ...listing, versions: [listing.versions[0]] });
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		const output = stripAnsi(getSelector().render(80).join("\n"));
		expect(output).toContain("aaaaaaaaaaaa");
		expect(output).not.toContain("bbbbbbbbbbbb");
		expect(fixture.session.listHarnessVersions).not.toHaveBeenCalled();
	});

	it("without evolution exposes only validated empty roots, not evolved or populated roots", async () => {
		const { fixture, listing, getSelector } = createFixture();
		fixture.options.evolution = undefined;
		listing.versions.push(
			{ manifest: { version: "memory-root", base: null }, state: { memory: "foreign", skills: [] } },
			{ manifest: { version: "skill-root", base: null }, state: { memory: "", skills: [skill] } },
		);
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		const output = stripAnsi(getSelector().render(80).join("\n"));
		expect(fixture.session.listHarnessVersions).toHaveBeenCalledOnce();
		expect(output).toContain("aaaaaaaaaaaa");
		expect(output).not.toContain("bbbbbbbbbbbb");
		expect(output).not.toContain("memory-root");
		expect(output).not.toContain("skill-root");
	});

	it.each([
		"Cannot switch harness versions while a response is streaming.",
		"Cannot switch harness versions while compaction is in progress.",
		"Cannot switch harness versions while a bash command is running.",
	])("surfaces the AgentSession operation guard: %s", async (message) => {
		const { fixture, getSelector } = createFixture(vi.fn().mockRejectedValue(new Error(message)));
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\n");
		await vi.waitFor(() => expect(fixture.showError).toHaveBeenCalledWith(message));
	});

	it("cancels without changing the active revision", async () => {
		const { fixture, getSelector, done } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);
		getSelector().handleInput("\u001b");
		expect(done).toHaveBeenCalledOnce();
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
	});
});
