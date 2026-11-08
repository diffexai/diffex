import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import type { Container, EditorComponent } from "@diffexai/diffex-tui";
import { visibleWidth } from "@diffexai/diffex-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createSpawnAgentTool } from "../../src/core/tools/subagents.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../extension-test-utils.ts";
import { goalControls } from "./goal-harness.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

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

	async function setup(tuiMode: "regular" | "fullscreen", options: HarnessOptions = {}) {
		const harness = await createHarness(options);
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

	it.each(["default", "custom", "extension"] as const)(
		"restricts subagent spawning only while /goal is enabled with %s prompts",
		async (promptSource) => {
			const spawned: string[] = [];
			const extensionsResult = await createTestExtensionsResult([
				(extension) => {
					extension.registerTool(createSpawnAgentTool((name) => spawned.push(name)));
					if (promptSource === "extension") {
						extension.on("before_agent_start", () => ({ systemPrompt: "Extension prompt." }));
					}
				},
			]);
			const resourceLoader = createTestResourceLoader({ extensionsResult });
			if (promptSource === "custom") resourceLoader.getSystemPrompt = () => "Custom prompt.";
			const { harness, state } = await setup("regular", { resourceLoader });
			const prompts: Array<string | undefined> = [];
			const schemas: unknown[] = [];
			const capture = (context: Context) => {
				prompts.push(context.systemPrompt);
				schemas.push(structuredClone(context.tools?.find((tool) => tool.name === "spawn_agent")?.parameters));
				return fauxAssistantMessage("Done.");
			};
			harness.setResponses([
				capture,
				(context) => {
					capture(context);
					return fauxAssistantMessage(
						[
							fauxToolCall("spawn_agent", { name: "frontend", task: "Inspect the frontend." }),
							fauxToolCall("spawn_agent", { name: "backend", task: "Inspect the backend." }),
						],
						{ stopReason: "toolUse" },
					);
				},
				capture,
				capture,
			]);
			await harness.session.prompt("Review the frontend and backend.");
			await state.defaultEditor.onSubmit?.("/goal");
			await harness.session.prompt("Use two subagents: one to inspect the frontend and one to inspect the backend.");
			await state.defaultEditor.onSubmit?.("/goal");
			await harness.session.prompt("Continue the review.");

			expect(prompts).toHaveLength(4);
			for (const prompt of [prompts[0], prompts[3]]) {
				expect(prompt).not.toContain("Do not spawn subagents on your own initiative.");
			}
			for (const prompt of [prompts[1], prompts[2]]) {
				expect(prompt).toContain("Do not spawn subagents on your own initiative.");
				expect(prompt).toContain("Only call spawn_agent when the user explicitly instructs you");
				expect(prompt).toContain("Follow the user's specified subagent count and purpose for each subagent.");
				expect(prompt).toContain("infer the missing details from the conversation context");
			}
			if (promptSource !== "default") {
				for (const prompt of prompts) {
					expect(prompt).toContain(promptSource === "custom" ? "Custom prompt." : "Extension prompt.");
				}
			}
			expect(spawned).toEqual(["frontend", "backend"]);
			expect(schemas[0]).toBeDefined();
			for (const schema of schemas) expect(schema).toEqual(schemas[0]);
			expect(harness.getPendingResponseCount()).toBe(0);
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
