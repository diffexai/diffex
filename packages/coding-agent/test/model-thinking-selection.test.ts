import type { ThinkingLevel } from "@diffexai/diffex-agent-core";
import { type Component, Container, setKeybindings, type TUI, visibleWidth } from "@diffexai/diffex-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createInteractiveUi(harness: Harness, keybindings = new KeybindingsManager()) {
	let focused: Component | null = null;
	const ui = {
		requestRender: vi.fn(),
		setFocus: (component: Component | null) => {
			focused = component;
		},
		terminal: { columns: 80, rows: 24 },
	} as unknown as TUI;
	setKeybindings(keybindings);
	const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const mode = Object.assign(
		Object.create(InteractiveMode.prototype) as {
			setupKeyHandlers(): void;
			setupEditorSubmitHandler(): void;
			disposeActiveSelector(): void;
		},
		{
			runtimeHost: { session: harness.session },
			ui,
			editor,
			defaultEditor: editor,
			editorContainer,
			keybindings,
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
		},
	);
	mode.setupKeyHandlers();
	mode.setupEditorSubmitHandler();
	ui.setFocus(editor);
	return {
		mode,
		editor,
		editorContainer,
		get focused() {
			return focused;
		},
		input(data: string) {
			focused?.handleInput?.(data);
		},
		thinkingSelector() {
			const selector = editorContainer.children[0];
			if (!(selector instanceof ThinkingSelectorComponent)) throw new Error("Expected thinking selector");
			return selector;
		},
	};
}

describe("model thinking selection", () => {
	let harness: Harness | undefined;
	let interactive: ReturnType<typeof createInteractiveUi> | undefined;

	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		interactive?.mode.disposeActiveSelector();
		interactive = undefined;
		await harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it.each(["/model", "/model target", "ctrl+l"])("offers thinking after selection through %s", async (entry) => {
		harness = await createHarness({
			models: [
				{ id: "original", reasoning: true },
				{ id: "target-model", reasoning: true },
			],
		});
		harness.session.setThinkingLevel("medium");
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");
		interactive = createInteractiveUi(harness);
		if (entry === "ctrl+l") {
			interactive.editor.setText("Unsent draft");
			interactive.input("\u000c");
		} else {
			await interactive.editor.onSubmit?.(entry);
		}
		const picker = interactive.editorContainer.children[0];
		expect(picker).toBeInstanceOf(ModelSelectorComponent);
		if (entry !== "/model target") {
			for (const character of "target") interactive.input(character);
		}
		interactive.input("\r");
		await vi.waitFor(() =>
			expect(interactive?.editorContainer.children[0]).toBeInstanceOf(ThinkingSelectorComponent),
		);
		expect(refresh.mock.calls.at(-1)?.[0]?.signal?.aborted).toBe(true);
		expect(harness.session.model?.id).toBe("target-model");
		expect(interactive.focused).toBe(interactive.thinkingSelector().getSelectList());
		expect(interactive.thinkingSelector().getSelectList().getSelectedItem()?.value).toBe("medium");

		interactive.input("\u001b[B");
		interactive.input("\r");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({
			type: "thinking_level_change",
			thinkingLevel: "high",
		});
		expect(interactive.focused).toBe(interactive.editor);
		expect(interactive.editorContainer.children).toEqual([interactive.editor]);
		expect(interactive.mode.footer.invalidate).toHaveBeenCalled();
		expect(interactive.mode.updateEditorBorderColor).toHaveBeenCalled();
		expect(interactive.mode.showStatus).toHaveBeenLastCalledWith("Thinking level: high");
		if (entry === "ctrl+l") expect(interactive.editor.getText()).toBe("Unsent draft");
	});

	it.each(["original", "target-model", "faux/target-model"])(
		"offers thinking for exact /model %s",
		async (modelId) => {
			harness = await createHarness({
				models: [
					{ id: "original", reasoning: true },
					{ id: "target-model", reasoning: true },
				],
			});
			harness.session.setThinkingLevel("medium");
			const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");
			interactive = createInteractiveUi(harness);
			await interactive.editor.onSubmit?.(`/model ${modelId}`);
			expect(interactive.thinkingSelector().getSelectList().getSelectedItem()?.value).toBe("medium");
			expect(refresh).not.toHaveBeenCalled();
		},
	);

	it.each(["\u001b", "\u0003"])("keeps the selected model and current level on cancellation (%j)", async (cancel) => {
		harness = await createHarness({
			models: [
				{ id: "original", reasoning: true },
				{ id: "target-model", reasoning: true },
			],
		});
		harness.session.setThinkingLevel("medium");
		interactive = createInteractiveUi(harness);
		await interactive.editor.onSubmit?.("/model target-model");
		const changesBefore = harness.eventsOfType("thinking_level_changed").length;
		interactive.input("\u001b[B");
		interactive.input(cancel);
		expect(harness.session.model?.id).toBe("target-model");
		expect(harness.settingsManager.getDefaultModel()).toBe("target-model");
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
		expect(harness.eventsOfType("thinking_level_changed")).toHaveLength(changesBefore);
		expect(interactive.focused).toBe(interactive.editor);
	});

	it("uses supported levels and preselects the clamped preference", async () => {
		harness = await createHarness({
			models: [
				{ id: "original", reasoning: true },
				{ id: "target-model", reasoning: true },
			],
		});
		harness.session.setThinkingLevel("medium");
		const target = harness.session.modelRuntime.getModel("faux", "target-model");
		if (!target) throw new Error("Missing target model");
		target.thinkingLevelMap = { off: null, minimal: null, low: null, medium: null, xhigh: "xhigh", max: "max" };
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([harness.models[0], target]);
		interactive = createInteractiveUi(harness);
		await interactive.editor.onSubmit?.("/model target-model");
		const selector = interactive.thinkingSelector();
		expect(selector.getSelectList().getSelectedItem()?.value).toBe("high");
		const rendered = stripAnsi(selector.render(80).join("\n"));
		expect(rendered).toContain("Extra-high reasoning");
		expect(rendered).toContain("Maximum reasoning");
		expect(rendered).not.toContain("Moderate reasoning");
		expect(rendered).not.toContain("No reasoning");
		interactive.input("\u001b[B");
		interactive.input("\u001b[B");
		interactive.input("\r");
		expect(harness.session.thinkingLevel).toBe("max");
	});

	it.each(["non-reasoning", "single-level", "no-levels"])("skips thinking for a %s model", async (capability) => {
		harness = await createHarness({
			models: [
				{ id: "original", reasoning: true },
				{ id: "target-model", reasoning: capability !== "non-reasoning" },
			],
		});
		const target = harness.session.modelRuntime.getModel("faux", "target-model");
		if (!target) throw new Error("Missing target model");
		if (capability !== "non-reasoning") {
			target.thinkingLevelMap = {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: capability === "single-level" ? "high" : null,
				xhigh: null,
				max: null,
			};
		}
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([harness.models[0], target]);
		interactive = createInteractiveUi(harness);
		await interactive.editor.onSubmit?.("/model target-model");
		expect(harness.session.model?.id).toBe("target-model");
		expect(interactive.editorContainer.children).toEqual([interactive.editor]);
		expect(interactive.focused).toBe(interactive.editor);
	});

	it.each(["/model", "/model target-model"])(
		"does not offer thinking when model selection fails through %s",
		async (command) => {
			harness = await createHarness({
				models: [
					{ id: "original", reasoning: true },
					{ id: "target-model", reasoning: true },
				],
			});
			vi.spyOn(harness.session.modelRuntime, "checkAuth").mockRejectedValue(new Error("Authentication failed"));
			interactive = createInteractiveUi(harness);
			await interactive.editor.onSubmit?.(command);
			if (command === "/model") {
				for (const character of "target") interactive.input(character);
				interactive.input("\r");
			}
			await vi.waitFor(() => expect(interactive?.mode.showError).toHaveBeenCalledWith("Authentication failed"));
			expect(interactive.editorContainer.children).toEqual([interactive.editor]);
			expect(harness.session.model?.id).toBe("original");
		},
	);

	it("reselects the current model in the picker to change thinking", async () => {
		harness = await createHarness({ models: [{ id: "original", reasoning: true }] });
		interactive = createInteractiveUi(harness);
		await interactive.editor.onSubmit?.("/model");
		interactive.input("\r");
		await vi.waitFor(() =>
			expect(interactive?.editorContainer.children[0]).toBeInstanceOf(ThinkingSelectorComponent),
		);
		expect(harness.session.model?.id).toBe("original");
	});

	it("uses configurable navigation, confirmation, and cancellation keys", async () => {
		harness = await createHarness({ models: [{ id: "original", reasoning: true }] });
		harness.session.setThinkingLevel("medium");
		interactive = createInteractiveUi(
			harness,
			new KeybindingsManager({
				"tui.select.down": "ctrl+j",
				"tui.select.confirm": "ctrl+y",
				"tui.select.cancel": "ctrl+q",
			}),
		);
		await interactive.editor.onSubmit?.("/model original");
		const rendered = stripAnsi(interactive.thinkingSelector().render(80).join("\n"));
		expect(rendered).toContain("ctrl+y select");
		expect(rendered).toContain("ctrl+q keep current");
		interactive.input("\u000a");
		interactive.input("\u0019");
		expect(harness.session.thinkingLevel).toBe("high");
		await interactive.editor.onSubmit?.("/model original");
		interactive.input("\u0011");
		expect(interactive.focused).toBe(interactive.editor);
	});

	it.each([80, 52, 32])("keeps the thinking selector readable at width %i", (width) => {
		setKeybindings(new KeybindingsManager());
		const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const selector = new ThinkingSelectorComponent("medium", levels, vi.fn(), vi.fn());
		const lines = selector.render(width);
		expect(stripAnsi(lines.join("\n"))).toContain("Thinking level");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		for (const level of levels) {
			expect(stripAnsi(lines.join("\n"))).toContain(level);
		}
	});
});
