import type { ThinkingLevel } from "@earendil-works/diffex-agent-core";
import { getModel } from "@earendil-works/diffex-ai/compat";
import type { Component } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const reasoningModel = getModel("anthropic", "claude-sonnet-4-5")!;

type ThinkingSelectionContext = {
	session: {
		thinkingLevel: ThinkingLevel;
		getAvailableThinkingLevels: () => ThinkingLevel[];
		setThinkingLevel: ReturnType<typeof vi.fn>;
	};
	footer: { invalidate: ReturnType<typeof vi.fn> };
	showSelector: (create: (done: () => void) => { component: Component; focus: Component }) => void;
	completeModelSelection: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
};

const showModelThinkingSelector = Reflect.get(InteractiveMode.prototype, "showModelThinkingSelector") as (
	this: ThinkingSelectionContext,
	model: typeof reasoningModel,
) => void;

beforeAll(() => initTheme("dark"));

describe("interactive model thinking selection", () => {
	test("opens thinking effort after selecting a reasoning model", () => {
		let selector: ThinkingSelectorComponent | undefined;
		const done = vi.fn();
		const context: ThinkingSelectionContext = {
			session: {
				thinkingLevel: "medium",
				getAvailableThinkingLevels: () => ["off", "medium", "high"],
				setThinkingLevel: vi.fn(),
			},
			footer: { invalidate: vi.fn() },
			showSelector: (create) => {
				selector = create(done).component as ThinkingSelectorComponent;
			},
			completeModelSelection: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		showModelThinkingSelector.call(context, reasoningModel);
		selector?.getSelectList().onSelect?.({ value: "high", label: "high" });

		expect(context.session.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(context.footer.invalidate).toHaveBeenCalledOnce();
		expect(context.updateEditorBorderColor).toHaveBeenCalledOnce();
		expect(done).toHaveBeenCalledOnce();
		expect(context.completeModelSelection).toHaveBeenCalledWith(reasoningModel);
	});

	test("skips thinking effort for a model without reasoning support", () => {
		const model = { ...reasoningModel, id: "plain-model", reasoning: false };
		const context: ThinkingSelectionContext = {
			session: {
				thinkingLevel: "off",
				getAvailableThinkingLevels: () => ["off"],
				setThinkingLevel: vi.fn(),
			},
			footer: { invalidate: vi.fn() },
			showSelector: vi.fn(),
			completeModelSelection: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		showModelThinkingSelector.call(context, model);

		expect(context.showSelector).not.toHaveBeenCalled();
		expect(context.completeModelSelection).toHaveBeenCalledWith(model);
	});
});
