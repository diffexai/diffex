import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvolutionOverview } from "#evolution";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	EvolutionMenuClient,
	EvolutionMenuComponent,
} from "../src/modes/interactive/components/evolution-menu.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface SubmitFixture {
	defaultEditor: {
		onSubmit?: (text: string) => Promise<void>;
	};
	editor: {
		setText: ReturnType<typeof vi.fn>;
	};
	showEvolutionMenu: ReturnType<typeof vi.fn>;
}

interface MenuFixture {
	options: { evolution?: EvolutionMenuClient };
	editor: { setText: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showSelector: (
		create: (done: () => void) => {
			component: EvolutionMenuComponent;
			focus: EvolutionMenuComponent;
			dispose?: () => void;
		},
	) => void;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
}

const prototype = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: SubmitFixture): void;
	showEvolutionMenu(this: MenuFixture, editorText: string): void;
};

function overview(): EvolutionOverview {
	return {
		scope: { repositoryId: "repository", scopeId: "repository" },
		processedEvidenceCursor: 0,
		ingestionHighWaterCursor: 0,
		unprocessedEstimatedTokens: 0,
		settledInvocationCount: 0,
		automaticTokenThreshold: 1_000_000,
		automaticMinimumInvocations: 5,
		lastEvolutionAt: null,
		cooldownRemainingMs: 0,
		automaticEligibility: { eligible: false, reason: "insufficient-tokens" },
		activeJob: null,
		newestResumableJob: null,
		currentHarnessVersion: null,
		observedHarnessVersion: null,
		nextPromptWillRefresh: false,
		rollbackAction: null,
	};
}

function client(): EvolutionMenuClient {
	return {
		subscribe: () => () => {},
		overview: vi.fn().mockResolvedValue(overview()),
		listJobs: vi.fn().mockResolvedValue([]),
		jobDetail: vi.fn().mockRejectedValue(new Error("unused")),
		proposalDetail: vi.fn().mockRejectedValue(new Error("unused")),
		startManual: vi.fn().mockRejectedValue(new Error("unused")),
		resumeNewest: vi.fn().mockRejectedValue(new Error("unused")),
		cancelActive: vi.fn().mockRejectedValue(new Error("unused")),
		rollback: vi.fn().mockRejectedValue(new Error("unused")),
	};
}

describe("InteractiveMode evolution menu", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("routes only plain /evolve to the menu", async () => {
		const fixture: SubmitFixture = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			showEvolutionMenu: vi.fn(),
		};
		prototype.setupEditorSubmitHandler.call(fixture);

		await fixture.defaultEditor.onSubmit?.("/evolve");

		expect(fixture.editor.setText).toHaveBeenCalledWith("");
		expect(fixture.showEvolutionMenu).toHaveBeenCalledWith("");
	});

	it("restores editor contents and closes through Escape", async () => {
		let component: EvolutionMenuComponent | undefined;
		const done = vi.fn();
		const fixture: MenuFixture = {
			options: { evolution: client() },
			editor: { setText: vi.fn() },
			ui: { requestRender: vi.fn() },
			showSelector: (create) => {
				component = create(done).component;
			},
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		prototype.showEvolutionMenu.call(fixture, "draft input");
		await vi.waitFor(() => expect(component).toBeDefined());

		component?.handleInput("\u001b");

		expect(done).toHaveBeenCalledOnce();
		expect(fixture.editor.setText).toHaveBeenCalledWith("draft input");
		expect(fixture.ui.requestRender).toHaveBeenCalled();
	});
});
