import type { HarnessVersion } from "@diffexai/diffex-harness-state";
import type { Container } from "@diffexai/diffex-tui";
import { setKeybindings } from "@diffexai/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD, type EvolutionOverview } from "#evolution";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { EvolutionRuntimeEvent } from "../src/core/evolution-runtime.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	EvolutionMenuClient,
	EvolutionMenuComponent,
} from "../src/modes/interactive/components/evolution-menu.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";

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
	options: {
		evolution?: EvolutionMenuClient & {
			getEvolutionModel(): { provider: string; model: string } | undefined;
			setEvolutionModel(model: { provider: string; model: string }): Promise<void>;
		};
	};
	editor: { setText: ReturnType<typeof vi.fn> };
	runtimeHost: { session: { model: undefined } };
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
		unprocessedTokens: 0,
		settledInvocationCount: 0,
		automaticTokenThreshold: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
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

function client(): NonNullable<MenuFixture["options"]["evolution"]> {
	return {
		getEnabled: () => true,
		setEnabled: vi.fn(async () => {}),
		getEvolutionModel: () => undefined,
		setEvolutionModel: vi.fn(async () => {}),
		subscribe: () => () => {},
		overview: vi.fn().mockResolvedValue(overview()),
		listHarnessVersionInfo: vi.fn().mockResolvedValue([]),
		listCurrentDirectoryHarnessVersionInfo: vi.fn().mockResolvedValue([]),
		listJobs: vi.fn().mockResolvedValue([]),
		jobDetail: vi.fn().mockRejectedValue(new Error("unused")),
		proposalDetail: vi.fn().mockRejectedValue(new Error("unused")),
		skillCandidateDetail: vi.fn().mockRejectedValue(new Error("unused")),
		activateSkillCandidate: vi.fn().mockRejectedValue(new Error("unused")),
		rollbackSkillCandidate: vi.fn().mockRejectedValue(new Error("unused")),
		startManual: vi.fn().mockRejectedValue(new Error("unused")),
		resumeNewest: vi.fn().mockRejectedValue(new Error("unused")),
		cancelJob: vi.fn().mockRejectedValue(new Error("unused")),
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

	it.each([false, true])(
		"announces a selected revision without immediate adoption (streaming: %s)",
		async (streaming) => {
			const harness = await createHarness();
			const rootVersion = `sha256:${"a".repeat(64)}` as HarnessVersion;
			const evolvedVersion = `sha256:${"b".repeat(64)}` as HarnessVersion;
			const evolution = {
				...client(),
				listCurrentDirectoryHarnessVersions: vi.fn().mockResolvedValue({
					currentVersion: rootVersion,
					versions: [],
					diagnostics: [],
				}),
			};
			let listener: ((event: EvolutionRuntimeEvent) => void) | undefined;
			evolution.subscribe = (next) => {
				listener = next;
				return () => {};
			};
			vi.mocked(evolution.overview).mockResolvedValue({ ...overview(), currentHarnessVersion: rootVersion });
			const activeVersion = harness.session.activeHarnessVersion;
			const isStreaming = vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(streaming);
			const switchHarnessVersion = vi.spyOn(harness.session, "switchHarnessVersion");
			const runtimeHost = {
				session: harness.session,
				setBeforeSessionInvalidate: () => {},
				setRebindSession: () => {},
			} as unknown as AgentSessionRuntime;
			const mode = new InteractiveMode(runtimeHost, { evolution, tuiMode: "regular" });
			const state = mode as unknown as { chatContainer: Container; showStatus(message: string): void };
			const showStatus = vi.spyOn(state, "showStatus");
			try {
				await vi.waitFor(() => expect(evolution.overview).toHaveBeenCalled());
				expect(showStatus).not.toHaveBeenCalled();
				vi.mocked(evolution.overview).mockResolvedValue({ ...overview(), currentHarnessVersion: evolvedVersion });
				listener?.({
					jobId: "job-evolved",
					emittedAt: "2026-08-20T12:48:00.000Z",
					type: "completed",
					stage: "completed",
				});
				await vi.waitFor(() => expect(showStatus).toHaveBeenCalledOnce());

				const output = stripAnsi(state.chatContainer.render(200).join("\n"));
				expect(output).toContain("Evolution selected a new harness revision.");
				expect(output).toContain("Changes apply automatically after context compaction");
				expect(output).toContain("/clear");
				expect(switchHarnessVersion).not.toHaveBeenCalled();
				expect(harness.session.activeHarnessVersion).toBe(activeVersion);
			} finally {
				mode.stop();
				showStatus.mockRestore();
				isStreaming.mockRestore();
				switchHarnessVersion.mockRestore();
				await harness.cleanup();
			}
		},
	);

	it("restores editor contents and closes through Escape", async () => {
		let component: EvolutionMenuComponent | undefined;
		const done = vi.fn();
		const fixture: MenuFixture = {
			options: { evolution: client() },
			editor: { setText: vi.fn() },
			runtimeHost: { session: { model: undefined } },
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
