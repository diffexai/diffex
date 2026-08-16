import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

type EditorBorderContext = {
	isBashMode: boolean;
	session: { collaborationMode: "default" | "plan" };
	editor: { borderColor?: (text: string) => string };
	ui: { requestRender: ReturnType<typeof vi.fn> };
};

const updateEditorBorderColor = Reflect.get(InteractiveMode.prototype, "updateEditorBorderColor") as (
	this: EditorBorderContext,
) => void;

beforeAll(() => initTheme("dark"));

describe("plan mode editor border", () => {
	test("uses plan green while plan mode is active", () => {
		const context: EditorBorderContext = {
			isBashMode: false,
			session: { collaborationMode: "plan" },
			editor: {},
			ui: { requestRender: vi.fn() },
		};

		updateEditorBorderColor.call(context);

		expect(context.editor.borderColor?.("line")).toBe(theme.getPlanModeBorderColor()("line"));
	});

	test("keeps bash mode ahead of plan mode and restores the normal border", () => {
		const context: EditorBorderContext = {
			isBashMode: true,
			session: { collaborationMode: "plan" },
			editor: {},
			ui: { requestRender: vi.fn() },
		};

		updateEditorBorderColor.call(context);
		expect(context.editor.borderColor?.("line")).toBe(theme.getBashModeBorderColor()("line"));

		context.isBashMode = false;
		context.session.collaborationMode = "default";
		updateEditorBorderColor.call(context);
		expect(context.editor.borderColor?.("line")).toBe(getEditorTheme().borderColor("line"));
	});
});
