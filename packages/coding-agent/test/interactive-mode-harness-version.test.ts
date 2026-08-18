import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { HarnessVersionSelectorComponent } from "../src/modes/interactive/components/harness-version-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const rootVersion = `sha256:${"a".repeat(64)}`;
const childVersion = `sha256:${"b".repeat(64)}`;

interface HarnessModeFixture {
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
	showError: ReturnType<typeof vi.fn>;
}

const showHarnessVersionSelector = (
	InteractiveMode as unknown as {
		prototype: {
			showHarnessVersionSelector(this: HarnessModeFixture): Promise<void>;
		};
	}
).prototype.showHarnessVersionSelector;

function createFixture(switchHarnessVersion = vi.fn().mockResolvedValue(undefined)): {
	fixture: HarnessModeFixture;
	getSelector: () => HarnessVersionSelectorComponent;
	done: ReturnType<typeof vi.fn>;
} {
	let selector: HarnessVersionSelectorComponent | undefined;
	const done = vi.fn();
	const fixture: HarnessModeFixture = {
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
		await showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\n");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
		expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version already active: ${rootVersion}`);
	});

	it("switches the active revision selected through list navigation", async () => {
		const { fixture, getSelector, done } = createFixture();
		await showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");

		await vi.waitFor(() => {
			expect(fixture.session.switchHarnessVersion).toHaveBeenCalledWith(childVersion);
			expect(fixture.showStatus).toHaveBeenCalledWith(`Harness version: ${childVersion}`);
		});
		expect(done).toHaveBeenCalledOnce();
	});

	it.each([
		"Cannot switch harness versions while a response is streaming.",
		"Cannot switch harness versions while compaction is in progress.",
		"Cannot switch harness versions while a bash command is running.",
	])("surfaces the AgentSession operation guard: %s", async (message) => {
		const switchHarnessVersion = vi.fn().mockRejectedValue(new Error(message));
		const { fixture, getSelector } = createFixture(switchHarnessVersion);
		await showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b[B");
		getSelector().handleInput("\n");

		await vi.waitFor(() => {
			expect(fixture.showError).toHaveBeenCalledWith(message);
		});
	});

	it("cancels without changing the active revision", async () => {
		const { fixture, getSelector, done } = createFixture();
		await showHarnessVersionSelector.call(fixture);

		getSelector().handleInput("\u001b");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.session.switchHarnessVersion).not.toHaveBeenCalled();
	});
});
