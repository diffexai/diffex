import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import type { Component, EditorComponent } from "@earendil-works/diffex-tui";
import { type Container, Text } from "@earendil-works/diffex-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getCollaborationMode, setCollaborationMode } from "../src/core/collaboration-mode.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "./suite/harness.ts";

type PlanHandoff = { readonly plan: string };

type InteractiveModePrivate = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: EditorComponent;
	editorContainer: Container;
	pendingPlanHandoff?: PlanHandoff;
	pendingUserInputs: string[];
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	isInitialized: boolean;
	directBashCommandsInProgress: number;
	handleBashCommand(command: string): Promise<void>;
	implementSettledPlan(): Promise<void>;
	handleSettledPlanHandoff(planHandoff?: PlanHandoff): void;
	setupEditorSubmitHandler(): void;
	subscribeToAgent(): void;
	maybeShowPendingPlanHandoff(): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showExtensionCustom<T>(
		factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
	): Promise<T>;
	showTreeSelector(initialSelectedId?: string): void;
	toggleCollaborationMode(): void;
	renderInitialMessages(): void;
	clearPlanHandoff(): void;
	completeTranscriptTurn(): void;
	flushTranscriptBoundary(): void;
	showError(error: string): void;
};

type RuntimeCallbacks = {
	beforeInvalidate?: () => void;
	rebind?: () => Promise<void>;
};

const planHandoff = { plan: "# Plan\n\n1. Implement it\n" } satisfies PlanHandoff;

function privateMode(mode: InteractiveMode): InteractiveModePrivate {
	return mode as unknown as InteractiveModePrivate;
}

function createMode(
	harness: Harness,
	tuiMode: "regular" | "fullscreen" = "regular",
): {
	mode: InteractiveMode;
	privateMode: InteractiveModePrivate;
	callbacks: RuntimeCallbacks;
} {
	const callbacks: RuntimeCallbacks = {};
	const runtimeHost = {
		session: harness.session,
		setBeforeSessionInvalidate: (callback: () => void) => {
			callbacks.beforeInvalidate = callback;
		},
		setRebindSession: (callback: () => Promise<void>) => {
			callbacks.rebind = callback;
		},
	} as unknown as AgentSessionRuntime;
	const mode = new InteractiveMode(runtimeHost, { tuiMode });
	return { mode, privateMode: privateMode(mode), callbacks };
}

function activeSelector(mode: InteractiveModePrivate): ExtensionSelectorComponent {
	const component = mode.editorContainer.children[0];
	if (!(component instanceof ExtensionSelectorComponent)) {
		throw new Error("Expected an active extension selector");
	}
	return component;
}

function renderEditorSurface(mode: InteractiveModePrivate): string {
	return stripAnsi(mode.editorContainer.render(100).join("\n"));
}

describe("Interactive Plan implementation handoff", () => {
	const harnesses: Harness[] = [];
	const modes: InteractiveMode[] = [];

	beforeAll(() => initTheme("dark"));

	afterEach(async () => {
		vi.restoreAllMocks();
		while (modes.length > 0) modes.pop()?.stop();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup(tuiMode: "regular" | "fullscreen" = "regular", options: HarnessOptions = {}) {
		const harness = await createHarness(options);
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		const created = createMode(harness, tuiMode);
		modes.push(created.mode);
		return { harness, ...created };
	}

	it.each(["regular", "fullscreen"] as const)(
		"offers only the two exact actions on the shared %s editor surface",
		async (tuiMode) => {
			const { harness, privateMode: state } = await setup(tuiMode);
			const completeTranscriptTurn = vi.spyOn(state, "completeTranscriptTurn");
			const flushTranscriptBoundary = vi.spyOn(state, "flushTranscriptBoundary");
			state.isInitialized = true;

			await state.handleEvent({ type: "agent_end", messages: [], willRetry: false });
			await state.handleEvent({ type: "agent_settled", planHandoff });

			const output = renderEditorSurface(state);
			expect(output).toContain("Implement this plan?");
			expect(output).toContain("Implement the plan");
			expect(output).toContain("Stay in Plan mode");
			expect(output).not.toContain(planHandoff.plan);
			expect(completeTranscriptTurn).toHaveBeenCalledBefore(flushTranscriptBoundary);
			expect(getCollaborationMode(harness.session)).toBe("plan");
		},
	);

	it("dismisses by selection or cancellation without changing Plan mode", async () => {
		const { harness, privateMode: state } = await setup();

		state.handleSettledPlanHandoff(planHandoff);
		activeSelector(state).handleInput("\x1b[B");
		activeSelector(state).handleInput("\r");
		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(state.editorContainer.children).toEqual([state.editor]);

		state.handleSettledPlanHandoff(planHandoff);
		activeSelector(state).handleInput("\x1b");
		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(state.editorContainer.children).toEqual([state.editor]);
	});

	it("switches to Default and submits the fixed message in the same live session", async () => {
		const { harness, privateMode: state } = await setup();
		harness.setResponses([fauxAssistantMessage("implementation started")]);
		const prompt = vi.spyOn(harness.session, "prompt");

		state.handleSettledPlanHandoff(planHandoff);
		activeSelector(state).handleInput("\r");

		await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("Implement the plan."));
		await vi.waitFor(() => expect(getUserTexts(harness)).toContain("Implement the plan."));
		await harness.session.waitForIdle();
		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(getUserTexts(harness)).toContain("Implement the plan.");
	});

	it("keeps Default, reports the error, and restores the fixed message when submission fails", async () => {
		const { harness, privateMode: state } = await setup();
		const failure = new Error("submission failed");
		vi.spyOn(harness.session, "prompt").mockRejectedValue(failure);
		const showError = vi.spyOn(state, "showError");

		state.handleSettledPlanHandoff(planHandoff);
		activeSelector(state).handleInput("\r");

		await vi.waitFor(() => expect(state.editor.getText()).toBe("Implement the plan."));
		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(showError).toHaveBeenCalledWith("submission failed");
	});

	it.each(["regular", "fullscreen"] as const)(
		"defers handoff through an awaited user_bash hook and rejects acceptance in %s mode",
		async (tuiMode) => {
			let releaseBash = () => {};
			const bashGate = new Promise<void>((resolve) => {
				releaseBash = resolve;
			});
			const { harness, privateMode: state } = await setup(tuiMode, {
				extensionFactories: [
					(pi) => {
						pi.on("user_bash", async () => {
							await bashGate;
							return { result: { output: "intercepted", exitCode: 0, cancelled: false, truncated: false } };
						});
					},
				],
			});
			await harness.session.bindExtensions({});
			const prompt = vi.spyOn(harness.session, "prompt");
			const bash = state.handleBashCommand("intercepted command");
			try {
				expect(state.directBashCommandsInProgress).toBe(1);
				expect(harness.session.isBashRunning).toBe(false);
				state.handleSettledPlanHandoff(planHandoff);
				await state.implementSettledPlan();
				expect(getCollaborationMode(harness.session)).toBe("plan");
				expect(prompt).not.toHaveBeenCalled();
				expect(state.pendingPlanHandoff).toEqual(planHandoff);
				expect(state.editorContainer.children).toEqual([state.editor]);
			} finally {
				releaseBash();
				await bash;
			}
			await vi.waitFor(() => expect(renderEditorSurface(state)).toContain("Implement this plan?"));
			harness.setResponses([fauxAssistantMessage("implemented")]);
			activeSelector(state).handleInput("\r");
			await vi.waitFor(() => expect(getUserTexts(harness)).toContain("Implement the plan."));
			await harness.session.waitForIdle();
			expect(prompt).toHaveBeenCalledExactlyOnceWith("Implement the plan.");
		},
	);

	it.each(["isStreaming", "isCompacting", "isRetrying", "isBashRunning"] as const)(
		"rechecks %s on acceptance and preserves the offer until idle",
		async (property) => {
			const { harness, privateMode: state } = await setup();
			const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(undefined);
			state.handleSettledPlanHandoff(planHandoff);
			const busy = vi.spyOn(harness.session, property, "get").mockReturnValue(true);
			activeSelector(state).handleInput("\r");
			expect(getCollaborationMode(harness.session)).toBe("plan");
			expect(prompt).not.toHaveBeenCalled();
			expect(state.pendingPlanHandoff).toEqual(planHandoff);
			expect(state.editorContainer.children).toEqual([state.editor]);
			busy.mockReturnValue(false);
			await vi.waitFor(() => expect(renderEditorSurface(state)).toContain("Implement this plan?"));
			activeSelector(state).handleInput("\r");
			expect(prompt).toHaveBeenCalledExactlyOnceWith("Implement the plan.");
		},
	);

	it.each(["visible", "deferred"] as const)(
		"discards a %s offer when an extension starts a new run",
		async (presentation) => {
			const { harness, privateMode: state } = await setup();
			state.isInitialized = true;
			const unsubscribe = harness.session.subscribe((event) => state.handleEvent(event));
			let closeModal = () => {};
			if (presentation === "deferred") {
				state.showSelector((done) => {
					closeModal = done;
					const modal = new Text("UNRELATED MODAL");
					return { component: modal, focus: modal };
				});
			}
			state.handleSettledPlanHandoff(planHandoff);
			let releaseResponse = () => {};
			const responseGate = new Promise<void>((resolve) => {
				releaseResponse = resolve;
			});
			harness.setResponses([
				async () => {
					await responseGate;
					return fauxAssistantMessage("new response without a final plan");
				},
			]);
			const run = harness.session.prompt("new extension request", { source: "extension" });
			try {
				await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
				closeModal();
				expect(state.pendingPlanHandoff).toBeUndefined();
				expect(state.editorContainer.children).toEqual([state.editor]);
			} finally {
				releaseResponse();
				await run;
				unsubscribe();
			}
			expect(state.pendingPlanHandoff).toBeUndefined();
			expect(getUserTexts(harness)).toEqual(["new extension request"]);
		},
	);

	it.each([
		["visible", "continue"],
		["deferred", "continue"],
		["visible", "handled"],
		["deferred", "handled"],
	] as const)("invalidates a %s offer at admission even if input is %s", async (presentation, action) => {
		let releaseInput = () => {};
		let inputStarted = false;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const { harness, privateMode: state } = await setup("regular", {
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputStarted = true;
						await inputGate;
						return { action };
					});
				},
			],
		});
		state.isInitialized = true;
		state.subscribeToAgent();
		let closeModal = () => {};
		if (presentation === "deferred") {
			state.showSelector((done) => {
				closeModal = done;
				const component = new Text("UNRELATED MODAL");
				return { component, focus: component };
			});
		}
		state.handleSettledPlanHandoff(planHandoff);
		harness.setResponses([fauxAssistantMessage("<proposed_plan>\nnew plan\n</proposed_plan>")]);
		const run = harness.session.prompt("new extension request", { source: "extension" });
		try {
			expect(state.pendingPlanHandoff).toBeUndefined();
			if (presentation === "visible") expect(state.editorContainer.children).toEqual([state.editor]);
			else expect(renderEditorSurface(state)).toContain("UNRELATED MODAL");
			await vi.waitFor(() => expect(inputStarted).toBe(true));
			expect(harness.session.isStreaming).toBe(false);
			expect(setCollaborationMode(harness.session, "default").status).toBe("busy");
			closeModal();
			state.maybeShowPendingPlanHandoff();
			expect(state.editorContainer.children).toEqual([state.editor]);
		} finally {
			releaseInput();
			await run;
		}
		if (action === "continue") {
			await vi.waitFor(() => expect(renderEditorSurface(state)).toContain("Implement this plan?"));
			expect(state.pendingPlanHandoff?.plan.trim()).toBe("new plan");
		} else {
			expect(state.pendingPlanHandoff).toBeUndefined();
			expect(state.editorContainer.children).toEqual([state.editor]);
		}
	});

	it.each([
		"_promptAdmissionInProgress",
		"_harnessSwitchInProgress",
		"_collaborationModeTransitionInProgress",
	] as const)("defers presentation throughout the core %s guard", async (property) => {
		const { harness, privateMode: state } = await setup();
		const activity = harness.session as unknown as Record<typeof property, boolean>;
		activity[property] = true;
		try {
			state.handleSettledPlanHandoff(planHandoff);
			expect(state.pendingPlanHandoff).toEqual(planHandoff);
			expect(state.editorContainer.children).toEqual([state.editor]);
		} finally {
			activity[property] = false;
		}
		await vi.waitFor(() => expect(renderEditorSurface(state)).toContain("Implement this plan?"));
	});

	it("unsubscribes admission invalidation when the interactive mode stops", async () => {
		const { harness, mode, privateMode: state } = await setup();
		state.subscribeToAgent();
		const clearHandoff = vi.spyOn(state, "clearPlanHandoff");
		mode.stop();
		harness.setResponses([fauxAssistantMessage("no interactive listener")]);
		await harness.session.prompt("request after UI shutdown");
		expect(clearHandoff).not.toHaveBeenCalled();
	});

	it("defers one latest offer across the structured custom-modal surface", async () => {
		const { privateMode: state } = await setup();
		let closeModal: (value: string) => void = () => {
			throw new Error("Modal did not initialize");
		};
		const modalPromise = state.showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
			closeModal = done;
			return new Text("UNRELATED QUESTION MODAL");
		});
		await Promise.resolve();

		state.handleSettledPlanHandoff({ plan: "first" });
		state.handleSettledPlanHandoff({ plan: "latest" });
		expect(renderEditorSurface(state)).toContain("UNRELATED QUESTION MODAL");
		expect(state.pendingPlanHandoff).toEqual({ plan: "latest" });

		closeModal("closed");
		await modalPromise;
		await vi.waitFor(() => expect(renderEditorSurface(state)).toContain("Implement this plan?"));
		expect(state.pendingPlanHandoff).toEqual({ plan: "latest" });
	});

	it("does not let a disposed selector accept or dismiss a newer offer", async () => {
		const { harness, privateMode: state } = await setup();
		const prompt = vi.spyOn(harness.session, "prompt").mockResolvedValue(undefined);
		state.handleSettledPlanHandoff(planHandoff);
		const staleSelector = activeSelector(state);
		const latest = { plan: "a newer plan" };
		state.handleSettledPlanHandoff(latest);

		staleSelector.handleInput("\r");
		staleSelector.handleInput("\x1b");

		expect(prompt).not.toHaveBeenCalled();
		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(state.pendingPlanHandoff).toBe(latest);
		expect(activeSelector(state)).not.toBe(staleSelector);
		activeSelector(state).handleInput("\r");
		expect(prompt).toHaveBeenCalledExactlyOnceWith("Implement the plan.");
	});

	it("defers a visible offer when an unrelated selector takes focus", async () => {
		const { privateMode: state } = await setup();
		let closeModal: (() => void) | undefined;
		state.handleSettledPlanHandoff(planHandoff);

		state.showSelector((done) => {
			closeModal = done;
			const modal = new Text("LATER MODAL");
			return { component: modal, focus: modal };
		});
		expect(renderEditorSurface(state)).toContain("LATER MODAL");

		closeModal?.();
		await vi.waitFor(() => expect(renderEditorSurface(state)).toContain("Implement this plan?"));
	});

	it.each([
		[
			"steering",
			(session: AgentSession, _state: InteractiveModePrivate) => {
				vi.spyOn(session, "getSteeringMessages").mockReturnValue(["steer"]);
			},
		],
		[
			"follow-up",
			(session: AgentSession, _state: InteractiveModePrivate) => {
				vi.spyOn(session, "getFollowUpMessages").mockReturnValue(["follow up"]);
			},
		],
		[
			"next-turn",
			(_session: AgentSession, state: InteractiveModePrivate) => {
				state.pendingUserInputs.push("next turn");
			},
		],
		[
			"compaction",
			(_session: AgentSession, state: InteractiveModePrivate) => {
				state.compactionQueuedMessages.push({ text: "after compaction", mode: "steer" });
			},
		],
	] as const)("permanently suppresses a settled offer for %s queued input", async (_kind, queue) => {
		const { harness, privateMode: state } = await setup();
		let closeModal: (() => void) | undefined;
		state.showSelector((done) => {
			closeModal = done;
			const modal = new Text("OTHER MODAL");
			return { component: modal, focus: modal };
		});
		queue(harness.session, state);

		state.handleSettledPlanHandoff(planHandoff);
		state.pendingUserInputs = [];
		state.compactionQueuedMessages = [];
		vi.restoreAllMocks();
		closeModal?.();
		await Promise.resolve();

		expect(state.pendingPlanHandoff).toBeUndefined();
		expect(state.editorContainer.children).toEqual([state.editor]);
		expect(getCollaborationMode(harness.session)).toBe("plan");
	});

	it("dismisses an already-visible offer when queued input arrives", async () => {
		const { privateMode: state } = await setup();
		state.isInitialized = true;
		state.handleSettledPlanHandoff(planHandoff);

		await state.handleEvent({ type: "queue_update", steering: ["new direction"], followUp: [] });

		expect(state.pendingPlanHandoff).toBeUndefined();
		expect(state.editorContainer.children).toEqual([state.editor]);
	});

	it("clears a deferred offer when the user submits a next-turn message", async () => {
		const { privateMode: state } = await setup();
		let closeModal: (() => void) | undefined;
		state.setupEditorSubmitHandler();
		state.showSelector((done) => {
			closeModal = done;
			const modal = new Text("OTHER MODAL");
			return { component: modal, focus: modal };
		});
		state.handleSettledPlanHandoff(planHandoff);

		await state.defaultEditor.onSubmit?.("new request");
		closeModal?.();
		await Promise.resolve();

		expect(state.pendingUserInputs).toEqual(["new request"]);
		expect(state.pendingPlanHandoff).toBeUndefined();
		expect(renderEditorSurface(state)).not.toContain("Implement this plan?");
	});

	it("clears a deferred offer on mode change and session replacement", async () => {
		const { harness, privateMode: state, callbacks } = await setup();
		let closeModal: (() => void) | undefined;
		state.showSelector((done) => {
			closeModal = done;
			const modal = new Text("OTHER MODAL");
			return { component: modal, focus: modal };
		});
		state.handleSettledPlanHandoff(planHandoff);

		state.toggleCollaborationMode();
		closeModal?.();
		await Promise.resolve();
		expect(state.editorContainer.children).toEqual([state.editor]);

		setCollaborationMode(harness.session, "plan");
		state.showSelector((done) => {
			closeModal = done;
			const modal = new Text("OTHER MODAL");
			return { component: modal, focus: modal };
		});
		state.handleSettledPlanHandoff(planHandoff);
		callbacks.beforeInvalidate?.();
		closeModal?.();
		await Promise.resolve();
		expect(state.pendingPlanHandoff).toBeUndefined();
		expect(renderEditorSurface(state)).not.toContain("Implement this plan?");
	});

	it("clears a modal-deferred offer when tree navigation is committed", async () => {
		const { harness, privateMode: state } = await setup();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: Date.now(),
		});
		const firstId = harness.sessionManager.getLeafId();
		harness.sessionManager.appendMessage(fauxAssistantMessage("reply"));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: Date.now(),
		});
		vi.spyOn(harness.session.settingsManager, "getBranchSummarySkipPrompt").mockReturnValue(true);
		const navigateTree = vi.spyOn(harness.session, "navigateTree").mockResolvedValue({
			cancelled: false,
			aborted: false,
		});
		state.showTreeSelector();
		state.handleSettledPlanHandoff(planHandoff);

		const tree = state.editorContainer.children[0];
		if (!tree?.handleInput) throw new Error("Expected an active tree selector");
		tree.handleInput("\x1b[A");
		tree.handleInput("\x1b[A");
		tree.handleInput("\r");
		await vi.waitFor(() => expect(navigateTree).toHaveBeenCalled());

		expect(navigateTree).toHaveBeenCalledWith(firstId, {
			summarize: false,
			customInstructions: undefined,
		});
		expect(state.pendingPlanHandoff).toBeUndefined();
		expect(renderEditorSurface(state)).not.toContain("Implement this plan?");
	});

	it("does not derive a handoff while replaying historical plan text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		harness.sessionManager.appendMessage(fauxAssistantMessage("# Historical plan"));
		const created = createMode(harness);
		modes.push(created.mode);

		created.privateMode.renderInitialMessages();

		expect(created.privateMode.pendingPlanHandoff).toBeUndefined();
		expect(created.privateMode.editorContainer.children).toEqual([created.privateMode.editor]);
	});
});
