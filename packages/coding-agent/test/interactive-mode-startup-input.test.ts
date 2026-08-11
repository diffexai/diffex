import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		getExpandedText?: () => string;
		getText: () => string;
		onSubmit?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	promptUser: (text: string, options?: unknown) => Promise<void>;
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	handleFollowUp(this: SubmitContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			getText: vi.fn(() => ""),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		promptUser: vi.fn(async () => {}),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("routes streaming steer submissions through the runtime host", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("separate finance task");

		expect(context.promptUser).toHaveBeenCalledWith("separate finance task", { streamingBehavior: "steer" });
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("routes streaming follow-up submissions through the runtime host", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		context.editor.getText = vi.fn(() => "separate legal task");

		await interactiveModePrototype.handleFollowUp.call(context);

		expect(context.promptUser).toHaveBeenCalledWith("separate legal task", { streamingBehavior: "followUp" });
		expect(context.session.prompt).not.toHaveBeenCalled();
	});
});
