import type { Container, EditorComponent } from "@diffexai/diffex-tui";
import { visibleWidth } from "@diffexai/diffex-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { goalControls } from "./goal-harness.ts";
import { createHarness, type Harness } from "./harness.ts";

type InteractiveState = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: EditorComponent;
	chatContainer: Container;
	footerContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	directBashCommandsInProgress: number;
	setupEditorSubmitHandler(): void;
};

describe("interactive /goal", () => {
	const harnesses: Harness[] = [];
	const modes: InteractiveMode[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		while (modes.length) modes.pop()?.stop();
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function setup(tuiMode: "regular" | "fullscreen") {
		const harness = await createHarness();
		harnesses.push(harness);
		const runtime = {
			session: harness.session,
			setBeforeSessionInvalidate: () => {},
			setRebindSession: () => {},
		} as unknown as AgentSessionRuntime;
		const mode = new InteractiveMode(runtime, { tuiMode });
		modes.push(mode);
		const state = mode as unknown as InteractiveState;
		state.setupEditorSubmitHandler();
		return { harness, state };
	}

	it.each(["regular", "fullscreen"] as const)(
		"toggles and renders the persistent indicator in %s mode",
		async (tuiMode) => {
			const { harness, state } = await setup(tuiMode);
			const goal = goalControls(harness);
			state.editor.setText("/goal");
			await state.defaultEditor.onSubmit?.("/goal");
			expect(goal.isGoalModeEnabled).toBe(true);
			expect(harness.faux.state.callCount).toBe(0);
			expect(stripAnsi(state.chatContainer.render(100).join("\n"))).toContain(
				"Goal mode enabled (experimental). Self-evolution is disabled for this session.",
			);
			for (const width of [40, 80]) {
				const lines = [state.statusContainer, state.widgetContainerAbove, state.footerContainer].flatMap(
					(component) => component.render(width),
				);
				expect(stripAnsi(lines.join("\n"))).toContain("Goal");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			await state.defaultEditor.onSubmit?.("/goal");
			expect(goal.isGoalModeEnabled).toBe(false);
			expect(
				stripAnsi(
					[state.statusContainer, state.widgetContainerAbove, state.footerContainer]
						.flatMap((component) => component.render(80))
						.join("\n"),
				),
			).not.toContain("Goal");
		},
	);

	it("preserves the command in the editor while direct shell handling is busy", async () => {
		const { harness, state } = await setup("regular");
		const goal = goalControls(harness);
		state.directBashCommandsInProgress = 1;
		state.editor.setText("/goal");
		await state.defaultEditor.onSubmit?.("/goal");
		expect(goal.isGoalModeEnabled).toBe(false);
		expect(state.editor.getText()).toBe("/goal");
		expect(harness.faux.state.callCount).toBe(0);
	});
});
