import { Container } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	TaskBoundaryCancelledError,
	type TaskBoundaryProposal,
	type TaskBoundaryResolution,
} from "../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

interface TaskBoundaryContext {
	runtimeHost: {
		activeHarness?: { id: string; name: string };
	};
	clearStatusIndicator: ReturnType<typeof vi.fn>;
	showTaskRoutingProgress: ReturnType<typeof vi.fn>;
	showExtensionSelector: ReturnType<typeof vi.fn>;
}

const resolveTaskBoundary = Reflect.get(InteractiveMode.prototype, "resolveTaskBoundary") as (
	this: TaskBoundaryContext,
	proposal: TaskBoundaryProposal,
) => Promise<TaskBoundaryResolution>;

interface PromptContext {
	runtimeHost: {
		prompt: ReturnType<typeof vi.fn>;
		profileRouting: "auto" | "pinned";
		activeHarness?: { id: string; name: string };
	};
	session: { isIdle: boolean };
	editor: { getText: ReturnType<typeof vi.fn>; setText: ReturnType<typeof vi.fn> };
	pendingTaskPrompt?: { token: object; text: string };
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
	showTaskRoutingProgress: ReturnType<typeof vi.fn>;
	clearStatusIndicator: ReturnType<typeof vi.fn>;
	isExtensionCommand: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

const promptUser = Reflect.get(InteractiveMode.prototype, "promptUser") as (
	this: PromptContext,
	text: string,
) => Promise<void>;

interface PendingMessagesContext {
	pendingMessagesContainer: Container;
	pendingTaskPrompt?: { token: object; text: string };
	getAllQueuedMessages: () => { steering: string[]; followUp: string[] };
	getAppKeyDisplay: ReturnType<typeof vi.fn>;
}

const updatePendingMessagesDisplay = Reflect.get(InteractiveMode.prototype, "updatePendingMessagesDisplay") as (
	this: PendingMessagesContext,
) => void;

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
		clearStatusIndicator: vi.fn(),
		showTaskRoutingProgress: vi.fn(),
		showExtensionSelector: vi.fn().mockResolvedValue(selection),
	};
}

function createPromptContext(prompt: ReturnType<typeof vi.fn>): PromptContext {
	return {
		runtimeHost: {
			prompt,
			profileRouting: "auto",
			activeHarness: { id: "voice-api-a1b2c3", name: "Voice API" },
		},
		session: { isIdle: true },
		editor: { getText: vi.fn(() => ""), setText: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		showTaskRoutingProgress: vi.fn(),
		clearStatusIndicator: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
}

describe("InteractiveMode task boundary confirmation", () => {
	test("switches to the proposed new harness", async () => {
		const targetLabel = "Create: Retirement planning (finance)";
		const context = createContext(targetLabel);

		await expect(resolveTaskBoundary.call(context, SELECT_PROPOSAL)).resolves.toBe("switch");
		expect(context.clearStatusIndicator).toHaveBeenCalledWith("taskBoundary");
		expect(context.showExtensionSelector).toHaveBeenCalledWith(
			"New task detected\nChoose a harness for this prompt",
			[targetLabel, "Keep current: Voice API (coding)"],
		);
		expect(context.showTaskRoutingProgress).toHaveBeenCalledWith("Creating Retirement planning...");
	});

	test("keeps the current harness when that choice is confirmed", async () => {
		const context = createContext("Keep current: Voice API (coding)");

		await expect(resolveTaskBoundary.call(context, SELECT_PROPOSAL)).resolves.toBe("stay");
		expect(context.showTaskRoutingProgress).toHaveBeenCalledWith("Continuing with Voice API...");
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
		expect(context.showTaskRoutingProgress).not.toHaveBeenCalled();
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
		expect(context.showTaskRoutingProgress).toHaveBeenCalledWith("Reusing Literature review...");
	});

	test("acknowledges a held future prompt until runtime preflight settles", async () => {
		let resolvePrompt: (() => void) | undefined;
		const prompt = vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
			return new Promise<{ routing: "bypassed"; activeProfileId: string }>((resolve) => {
				resolvePrompt = () => {
					options?.preflightResult?.(true);
					resolve({ routing: "bypassed", activeProfileId: "coding" });
				};
			});
		});
		const context = createPromptContext(prompt);
		const pending = promptUser.call(context, "help me plan a new API");

		expect(context.pendingTaskPrompt?.text).toBe("help me plan a new API");
		expect(context.updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(context.showTaskRoutingProgress).toHaveBeenCalledWith("Checking whether this starts a new task...");

		resolvePrompt?.();
		await pending;
		expect(context.pendingTaskPrompt).toBeUndefined();
		expect(context.clearStatusIndicator).toHaveBeenCalledWith("taskBoundary");
	});

	test("renders a pending task prompt without a queue-only edit hint", () => {
		const context: PendingMessagesContext = {
			pendingMessagesContainer: new Container(),
			pendingTaskPrompt: { token: {}, text: "help me plan a new API" },
			getAllQueuedMessages: () => ({ steering: [], followUp: [] }),
			getAppKeyDisplay: vi.fn(() => "Alt+Up"),
		};

		updatePendingMessagesDisplay.call(context);
		const output = stripAnsi(context.pendingMessagesContainer.render(60).join("\n"));
		expect(output).toContain("Pending: help me plan a new API");
		expect(output).not.toContain("to edit all queued messages");
		expect(context.getAppKeyDisplay).not.toHaveBeenCalled();
	});

	test("restores a cancelled prompt without surfacing a generic error", async () => {
		const context = createPromptContext(vi.fn().mockRejectedValue(new TaskBoundaryCancelledError()));

		await expect(promptUser.call(context, "start a separate finance task")).resolves.toBeUndefined();
		expect(context.editor.setText).toHaveBeenCalledWith("start a separate finance task");
		expect(context.showStatus).toHaveBeenCalledWith("Task switch cancelled; prompt restored");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("does not overwrite text entered while cancellation settles", async () => {
		const context = createPromptContext(vi.fn().mockRejectedValue(new TaskBoundaryCancelledError()));
		context.editor.getText.mockReturnValue("new editor text");

		await promptUser.call(context, "cancelled prompt");
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Task switch cancelled");
	});

	test("continues to propagate unrelated prompt failures", async () => {
		const failure = new Error("provider unavailable");
		const context = createPromptContext(vi.fn().mockRejectedValue(failure));

		await expect(promptUser.call(context, "ordinary prompt")).rejects.toBe(failure);
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
