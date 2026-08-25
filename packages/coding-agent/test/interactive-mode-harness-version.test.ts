import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { HarnessVersionSelectorComponent } from "../src/modes/interactive/components/harness-version-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const rootVersion = `sha256:${"a".repeat(64)}`;
const childVersion = `sha256:${"b".repeat(64)}`;

interface HarnessModeFixture {
	options: {
		evolution: {
			listCurrentDirectoryHarnessVersionInfo: ReturnType<typeof vi.fn>;
			overview: ReturnType<typeof vi.fn>;
		};
	};
	session: {
		activeHarnessVersion: string | undefined;
		listHarnessVersions: ReturnType<typeof vi.fn>;
		switchHarnessVersion: ReturnType<typeof vi.fn>;
	};
	ui: {
		requestRender: ReturnType<typeof vi.fn>;
	};
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
		prototype: {
			showHarnessVersionSelector(this: HarnessModeFixture): Promise<void>;
			selectDefaultHarnessForLaunch(this: HarnessModeFixture): Promise<void>;
		};
	}
).prototype;

function createFixture(switchHarnessVersion = vi.fn().mockResolvedValue(undefined)): {
	fixture: HarnessModeFixture;
	getSelector: () => HarnessVersionSelectorComponent;
	done: ReturnType<typeof vi.fn>;
} {
	let selector: HarnessVersionSelectorComponent | undefined;
	const done = vi.fn();
	const fixture: HarnessModeFixture = {
		options: {
			evolution: {
				overview: vi.fn().mockResolvedValue({ activeJob: null }),
				listCurrentDirectoryHarnessVersionInfo: vi.fn().mockResolvedValue([
					{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null },
					{
						version: childVersion,
						kind: "evolved",
						evolvedAt: new Date(2026, 6, 28, 21, 30).toISOString(),
						evolvedIn: "/projects/child",
					},
				]),
			},
		},
		session: {
			activeHarnessVersion: rootVersion,
			listHarnessVersions: vi.fn().mockResolvedValue({
				currentVersion: rootVersion,
				versions: [
					{
						manifest: { version: rootVersion, base: null },
						state: { memory: "" },
					},
					{
						manifest: { version: childVersion, base: rootVersion },
						state: { memory: "Use the child memory." },
					},
				],
				diagnostics: [],
			}),
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
		getSelector: () => {
			if (!selector) throw new Error("Harness version selector was not shown");
			return selector;
		},
		done,
	};
}

describe("InteractiveMode harness version selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("treats selecting the current revision as a no-op", async () => {
		const { fixture, getSelector, done } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\n");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
		expect(fixture.showStatus).toHaveBeenCalledWith("Harness version already active: [current] Default Diffex Agent");
	});

	it("switches the active revision selected through list navigation", async () => {
		const { fixture, getSelector, done } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");

		await vi.waitFor(() => {
			expect(fixture.session.switchHarnessVersion).toHaveBeenCalledWith(childVersion);
			expect(fixture.showStatus).toHaveBeenCalledWith(
				"Harness version: [current] Evolved Diffex Agent 7/28 at 9:30 pm: /projects/child",
			);
		});
		expect(done).toHaveBeenCalledOnce();
	});

	it("warns when switching harnesses during an active evolution", async () => {
		const { fixture, getSelector } = createFixture();
		fixture.options.evolution.overview.mockResolvedValue({ activeJob: { jobId: "job-active" } });
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");

		await vi.waitFor(() => {
			expect(fixture.showWarning).toHaveBeenCalledWith(
				"An active evolution is running from its original harness and will not apply to the selected harness.",
			);
		});
		expect(fixture.showStatus).not.toHaveBeenCalledWith(expect.stringContaining("Harness version:"));
	});

	it.each([
		"Cannot switch harness versions while a response is streaming.",
		"Cannot switch harness versions while compaction is in progress.",
		"Cannot switch harness versions while a bash command is running.",
	])("surfaces the AgentSession operation guard: %s", async (message) => {
		const switchHarnessVersion = vi.fn().mockRejectedValue(new Error(message));
		const { fixture, getSelector } = createFixture(switchHarnessVersion);
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");

		await vi.waitFor(() => {
			expect(fixture.showError).toHaveBeenCalledWith(message);
		});
	});

	it("cancels without changing the active revision", async () => {
		const { fixture, getSelector, done } = createFixture();
		await interactiveHarnessMethods.showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
	});

	it("selects and announces the default harness for a Diffex launch", async () => {
		const { fixture } = createFixture();
		fixture.session.activeHarnessVersion = childVersion;

		await interactiveHarnessMethods.selectDefaultHarnessForLaunch.call(fixture);

		expect(fixture.session.switchHarnessVersion).toHaveBeenCalledWith(rootVersion);
		expect(fixture.showStatus).toHaveBeenCalledWith("Default Diffex Agent selected for this launch");
		expect(fixture.showError).not.toHaveBeenCalled();
	});
});
