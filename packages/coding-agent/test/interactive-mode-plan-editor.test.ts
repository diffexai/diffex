import { type Component, Container } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

class TestEditor implements Component {
	borderColor?: (text: string) => string;
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	private text: string;

	constructor(text = "") {
		this.text = text;
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
}

type EditorBorderContext = {
	isBashMode: boolean;
	session: { collaborationMode: "default" | "plan" };
	defaultEditor: { borderColor?: (text: string) => string };
	editor: { borderColor?: (text: string) => string };
	ui: { requestRender: ReturnType<typeof vi.fn> };
};

type EditorReplacementContext = Omit<EditorBorderContext, "defaultEditor" | "editor" | "ui"> & {
	activeEditorUi?: { exclusive?: boolean };
	cancelActiveEditorUi: ReturnType<typeof vi.fn>;
	defaultEditor: TestEditor;
	editor: TestEditor;
	editorComponentFactory?: undefined;
	editorContainer: Container;
	ui: {
		requestRender: ReturnType<typeof vi.fn>;
		setFocus: ReturnType<typeof vi.fn>;
	};
	updateEditorBorderColor: () => void;
};

const styleEditorPrompt = Reflect.get(InteractiveMode.prototype, "styleEditorPrompt") as (
	this: Pick<EditorBorderContext, "isBashMode" | "session">,
	text: string,
) => string;

const updateEditorBorderColor = Reflect.get(InteractiveMode.prototype, "updateEditorBorderColor") as (
	this: EditorBorderContext,
) => void;

const setCustomEditorComponent = Reflect.get(InteractiveMode.prototype, "setCustomEditorComponent") as (
	this: EditorReplacementContext,
	factory: undefined,
) => void;

beforeAll(() => initTheme("dark"));

describe("plan mode editor appearance", () => {
	test("uses plan green for the prompt pointer", () => {
		const context = {
			isBashMode: false,
			session: { collaborationMode: "plan" as const },
		};

		expect(styleEditorPrompt.call(context, "> ")).toBe(theme.fg("planMode", "> "));
	});

	test("uses plan green while plan mode is active", () => {
		const context: EditorBorderContext = {
			isBashMode: false,
			session: { collaborationMode: "plan" },
			defaultEditor: {},
			editor: {},
			ui: { requestRender: vi.fn() },
		};

		updateEditorBorderColor.call(context);

		expect(context.editor.borderColor?.("line")).toBe(theme.getPlanModeBorderColor()("line"));
		expect(context.defaultEditor.borderColor?.("line")).toBe(theme.getPlanModeBorderColor()("line"));
	});

	test("recomputes the plan border when restoring the default editor", () => {
		const defaultEditor = new TestEditor();
		const context: EditorReplacementContext = {
			isBashMode: false,
			session: { collaborationMode: "plan" },
			cancelActiveEditorUi: vi.fn(),
			defaultEditor,
			editor: new TestEditor("draft"),
			editorContainer: new Container(),
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
			updateEditorBorderColor: () => updateEditorBorderColor.call(context),
		};

		setCustomEditorComponent.call(context, undefined);

		expect(context.editor).toBe(defaultEditor);
		expect(defaultEditor.getText()).toBe("draft");
		expect(defaultEditor.borderColor?.("line")).toBe(theme.getPlanModeBorderColor()("line"));
	});

	test("keeps the default editor synchronized while a custom editor is active", () => {
		const context: EditorBorderContext = {
			isBashMode: true,
			session: { collaborationMode: "plan" },
			defaultEditor: {},
			editor: {},
			ui: { requestRender: vi.fn() },
		};

		updateEditorBorderColor.call(context);
		expect(context.editor.borderColor?.("line")).toBe(theme.getBashModeBorderColor()("line"));
		expect(context.defaultEditor.borderColor?.("line")).toBe(theme.getBashModeBorderColor()("line"));

		context.isBashMode = false;
		context.session.collaborationMode = "default";
		updateEditorBorderColor.call(context);
		expect(context.editor.borderColor?.("line")).toBe(getEditorTheme().borderColor("line"));
		expect(context.defaultEditor.borderColor?.("line")).toBe(getEditorTheme().borderColor("line"));
	});
});
