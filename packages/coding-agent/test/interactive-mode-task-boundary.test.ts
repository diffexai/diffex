import { describe, expect, test, vi } from "vitest";
import {
	TaskBoundaryCancelledError,
	type TaskBoundaryProposal,
	type TaskBoundaryResolution,
} from "../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface TaskBoundaryContext {
	runtimeHost: {
		activeHarness?: { id: string; name: string };
	};
	showExtensionSelector: ReturnType<typeof vi.fn>;
}

const resolveTaskBoundary = Reflect.get(InteractiveMode.prototype, "resolveTaskBoundary") as (
	this: TaskBoundaryContext,
	proposal: TaskBoundaryProposal,
) => Promise<TaskBoundaryResolution>;

interface PromptContext {
	runtimeHost: { prompt: ReturnType<typeof vi.fn> };
	editor: { getText: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> };
	showStatus: ReturnType<typeof vi.fn>;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

const promptUser = Reflect.get(InteractiveMode.prototype, "promptUser") as (
	this: PromptContext,
	text: string,
) => Promise<void>;

const SELECT_PROPOSAL: TaskBoundaryProposal = {
	decision: "select",
	fromProfileId: "coding",
	fromHarnessId: "voice-api-a1b2c3",
	toProfileId: "finance",
	targetHarnessName: "Retirement planning",
	confidence: 0.97,
	willResumeSession: false,
};

function createContext(selection: string | undefined): TaskBoundaryContext {
	return {
		runtimeHost: {
			activeHarness: { id: "voice-api-a1b2c3", name: "Voice API" },
		},
		showExtensionSelector: vi.fn().mockResolvedValue(selection),
	};
}

describe("InteractiveMode task boundary confirmation", () => {
	test("switches to the proposed new harness", async () => {
		const targetLabel = "Create: Retirement planning (finance)";
		const context = createContext(targetLabel);

		await expect(resolveTaskBoundary.call(context, SELECT_PROPOSAL)).resolves.toBe("switch");
		expect(context.showExtensionSelector).toHaveBeenCalledWith(
			"New task detected\nChoose a harness for this prompt",
			[targetLabel, "Keep current: Voice API (coding)"],
		);
	});

	test("keeps the current harness when that choice is confirmed", async () => {
		const context = createContext("Keep current: Voice API (coding)");

		await expect(resolveTaskBoundary.call(context, SELECT_PROPOSAL)).resolves.toBe("stay");
	});

	test("cancels when the native selector is dismissed", async () => {
		const context = createContext(undefined);
		const reuseProposal: TaskBoundaryProposal = {
			...SELECT_PROPOSAL,
			decision: "reuse",
			toProfileId: "research",
			targetHarnessId: "literature-review-d4e5f6",
			targetHarnessRevision: "revision-one",
			targetHarnessName: "Literature review",
			willResumeSession: true,
		};

		await expect(resolveTaskBoundary.call(context, reuseProposal)).resolves.toBe("cancel");
		expect(context.showExtensionSelector).toHaveBeenCalledWith(
			"New task detected\nChoose a harness for this prompt",
			["Resume: Literature review (research)", "Keep current: Voice API (coding)"],
		);
	});

	test("labels harness reuse without a prior transcript as reuse", async () => {
		const targetLabel = "Reuse: Literature review (research)";
		const context = createContext(targetLabel);
		const reuseProposal: TaskBoundaryProposal = {
			...SELECT_PROPOSAL,
			decision: "reuse",
			toProfileId: "research",
			targetHarnessId: "literature-review-d4e5f6",
			targetHarnessRevision: "revision-one",
			targetHarnessName: "Literature review",
			willResumeSession: false,
		};

		await expect(resolveTaskBoundary.call(context, reuseProposal)).resolves.toBe("switch");
		expect(context.showExtensionSelector).toHaveBeenCalledWith(
			"New task detected\nChoose a harness for this prompt",
			[targetLabel, "Keep current: Voice API (coding)"],
		);
	});

	test("restores a cancelled prompt without surfacing a generic error", async () => {
		const context: PromptContext = {
			runtimeHost: { prompt: vi.fn().mockRejectedValue(new TaskBoundaryCancelledError()) },
			editor: { getText: vi.fn(() => ""), setText: vi.fn() },
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await expect(promptUser.call(context, "start a separate finance task")).resolves.toBeUndefined();
		expect(context.editor.setText).toHaveBeenCalledWith("start a separate finance task");
		expect(context.showStatus).toHaveBeenCalledWith("Task switch cancelled; prompt restored");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not overwrite text entered while cancellation settles", async () => {
		const context: PromptContext = {
			runtimeHost: { prompt: vi.fn().mockRejectedValue(new TaskBoundaryCancelledError()) },
			editor: { getText: vi.fn(() => "new editor text"), setText: vi.fn() },
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await promptUser.call(context, "cancelled prompt");
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Task switch cancelled");
	});

	test("continues to propagate unrelated prompt failures", async () => {
		const failure = new Error("provider unavailable");
		const context: PromptContext = {
			runtimeHost: { prompt: vi.fn().mockRejectedValue(failure) },
			editor: { getText: vi.fn(() => ""), setText: vi.fn() },
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await expect(promptUser.call(context, "ordinary prompt")).rejects.toBe(failure);
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
