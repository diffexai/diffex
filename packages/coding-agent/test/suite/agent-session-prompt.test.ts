import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, InMemoryTelemetryContext } from "@earendil-works/diffex-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputEvent } from "../../src/core/extensions/index.ts";
import type { PromptTemplate } from "../../src/core/prompt-templates.ts";
import { createSkill } from "../../src/core/skills.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[2]?.role).toBe("toolResult");
		expect(harness.session.messages[3]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	it("does not expand individual skill commands", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let admittedPrompt = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				admittedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(admittedPrompt).toBe("/skill:test explain this");
	});

	it("loads exactly the explicitly referenced skill snapshot and traces its identity", async () => {
		const tempDir = join(tmpdir(), `diffex-skill-reference-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const selectedPath = join(tempDir, "selected.md");
		const unselectedPath = join(tempDir, "unselected.md");
		writeFileSync(
			selectedPath,
			"---\nname: selected\ndescription: Selected skill\n---\n\n# Selected\n\nOriginal instructions.",
		);
		writeFileSync(
			unselectedPath,
			"---\nname: unselected\ndescription: Unselected skill\n---\n\n# Unselected\n\nPrivate instructions.",
		);
		const sourceInfo = (filePath: string) =>
			createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				origin: "top-level",
				baseDir: tempDir,
			});
		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					createSkill({
						name: "selected",
						description: "Selected skill",
						filePath: selectedPath,
						baseDir: tempDir,
						sourceInfo: sourceInfo(selectedPath),
						content:
							"---\nname: selected\ndescription: Selected skill\n---\n\n# Selected\n\nOriginal instructions.",
						disableModelInvocation: true,
					}),
					createSkill({
						name: "unselected",
						description: "Unselected skill",
						filePath: unselectedPath,
						baseDir: tempDir,
						sourceInfo: sourceInfo(unselectedPath),
						content:
							"---\nname: unselected\ndescription: Unselected skill\n---\n\n# Unselected\n\nPrivate instructions.",
					}),
				],
				diagnostics: [],
			}),
		};
		const telemetry = new InMemoryTelemetryContext();
		const harness = await createHarness({ resourceLoader, telemetryContext: telemetry });
		harnesses.push(harness);
		const references = harness.session.createSkillReferences();
		const selected = references.find((reference) => reference.name === "selected");
		if (!selected) throw new Error("Selected skill reference was not created");
		expect(selected.group).toBe("installed-workspace");
		writeFileSync(selectedPath, "Changed after selection.");
		let admittedPrompt = "";
		let admittedSystemPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				admittedPrompt = user ? getMessageText(user) : "";
				admittedSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt(`${selected.reference}\n\nUse this for the task.`);

		expect(admittedPrompt).toContain(`id="${selected.skillId}"`);
		expect(admittedPrompt).toContain(`version="${selected.version}"`);
		expect(admittedPrompt).toContain("Original instructions.");
		expect(admittedPrompt).not.toContain("Changed after selection.");
		expect(admittedPrompt).not.toContain("Private instructions.");
		expect(admittedPrompt).toContain("Use this for the task.");
		expect(admittedSystemPrompt).not.toContain("<name>selected</name>");
		expect(admittedSystemPrompt).toContain("<name>unselected</name>");
		const promptOperation = telemetry
			.getSpans()
			.find(
				(span) =>
					span.name === "diffex.coding_agent.operation" && span.attributes["diffex.operation.kind"] === "prompt",
			);
		expect(promptOperation?.attributes["diffex.skill.references"]).toEqual([
			`${selected.skillId}@${selected.version}`,
		]);
	});

	it("expands prompt templates before sending the prompt", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("from extension");
	});

	it("does not report streamingBehavior to input handlers while idle", async () => {
		const inputEvents: InputEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("idle", { streamingBehavior: "followUp" });

		expect(inputEvents).toHaveLength(1);
		expect(inputEvents[0]?.streamingBehavior).toBeUndefined();
	});

	it("reports streamingBehavior to input handlers while streaming", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const inputEvents: InputEvent[] = [];
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await harness.session.prompt("queued", { streamingBehavior: "followUp" });

		expect(inputEvents.map((event) => event.streamingBehavior)).toEqual([undefined, "followUp"]);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("rejects already-aborted signals before prompt state changes and preserves abort reasons", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		const defaultAbort = new AbortController();
		defaultAbort.abort();
		await expect(harness.session.prompt("default", { signal: defaultAbort.signal })).rejects.toMatchObject({
			name: "AbortError",
		});

		const customReason = new Error("custom cancellation");
		const customAbort = new AbortController();
		customAbort.abort(customReason);
		await expect(harness.session.prompt("custom", { signal: customAbort.signal })).rejects.toBe(customReason);

		expect(harness.session.messages).toEqual([]);
		expect(harness.sessionManager.getEntries()).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it.each([
		{ firstSignaled: false, label: "signaled prompt behind unsignaled preflight" },
		{ firstSignaled: true, label: "unsignaled prompt behind signaled preflight" },
	])("rejects a $label", async ({ firstSignaled }) => {
		const inputStarted = deferred();
		const releaseInput = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputStarted.resolve();
						await releaseInput.promise;
						return { action: "continue" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first completed")]);
		const firstController = new AbortController();
		const firstPrompt = harness.session.prompt(
			"first",
			firstSignaled ? { signal: firstController.signal } : undefined,
		);
		await inputStarted.promise;

		const secondController = new AbortController();
		const secondOptions = firstSignaled ? undefined : { signal: secondController.signal };
		await expect(harness.session.prompt("second", secondOptions)).rejects.toThrow(
			"Cannot submit a prompt while another prompt owns prompt preflight.",
		);

		releaseInput.resolve();
		await firstPrompt;
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("rejects a signaled prompt instead of queueing behind an active unsignaled run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const responseStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const activePrompt = harness.session.prompt("active");
		await responseStarted;

		const controller = new AbortController();
		await expect(
			harness.session.prompt("must not queue", { signal: controller.signal, streamingBehavior: "followUp" }),
		).rejects.toThrow("Cannot submit a signaled prompt while an agent run is active.");

		await harness.session.abort();
		await activePrompt;
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("observes cancellation after an awaited extension command boundary", async () => {
		const commandStarted = deferred();
		const releaseCommand = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("wait", {
						description: "Wait",
						handler: async () => {
							commandStarted.resolve();
							await releaseCommand.promise;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const controller = new AbortController();
		const reason = new Error("cancel command preflight");
		const prompt = harness.session.prompt("/wait", { signal: controller.signal });
		await commandStarted.promise;
		controller.abort(reason);
		releaseCommand.resolve();

		await expect(prompt).rejects.toBe(reason);
		expect(harness.session.messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("observes cancellation after awaited input and before-agent-start boundaries", async () => {
		const inputStarted = deferred();
		const releaseInput = deferred();
		const beforeStartEntered = deferred();
		const releaseBeforeStart = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputStarted.resolve();
						await releaseInput.promise;
						return { action: "continue" };
					});
					pi.on("before_agent_start", async () => {
						beforeStartEntered.resolve();
						await releaseBeforeStart.promise;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);

		const inputController = new AbortController();
		const inputReason = new Error("cancel input");
		const inputPrompt = harness.session.prompt("input", { signal: inputController.signal });
		await inputStarted.promise;
		inputController.abort(inputReason);
		releaseInput.resolve();
		await expect(inputPrompt).rejects.toBe(inputReason);

		const beforeStartController = new AbortController();
		const beforeStartReason = new Error("cancel before start");
		const beforeStartPrompt = harness.session.prompt("before start", { signal: beforeStartController.signal });
		await beforeStartEntered.promise;
		beforeStartController.abort(beforeStartReason);
		releaseBeforeStart.resolve();
		await expect(beforeStartPrompt).rejects.toBe(beforeStartReason);

		expect(harness.session.messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("observes cancellation after the awaited harness refresh boundary", async () => {
		const agentDir = join(tmpdir(), `diffex-prompt-signal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		tempDirs.push(agentDir);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const harness = await createHarness({ harnessStateStore: store, harnessVersionBundle: root });
		harnesses.push(harness);
		const loadStarted = deferred();
		const releaseLoad = deferred();
		const loadCurrent = store.loadCurrent.bind(store);
		vi.spyOn(store, "loadCurrent").mockImplementation(async () => {
			loadStarted.resolve();
			await releaseLoad.promise;
			return loadCurrent();
		});
		const controller = new AbortController();
		const reason = new Error("cancel harness refresh");
		const prompt = harness.session.prompt("refresh", { signal: controller.signal });
		await loadStarted.promise;
		controller.abort(reason);
		releaseLoad.resolve();

		await expect(prompt).rejects.toBe(reason);
		expect(harness.session.messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("propagates cancellation through authentication", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const authStarted = deferred();
		vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async (_providerId, options) => {
			authStarted.resolve();
			const signal = options?.signal;
			if (!signal) throw new Error("Expected prompt signal in authentication");
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			return undefined;
		});
		const controller = new AbortController();
		const reason = new Error("cancel authentication");
		const prompt = harness.session.prompt("authenticate", { signal: controller.signal });
		await authStarted.promise;
		controller.abort(reason);

		await expect(prompt).rejects.toBe(reason);
		expect(harness.session.messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("cancels pre-prompt compaction before recording or starting the turn", async () => {
		const compactionStarted = deferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await new Promise<void>((resolve) => {
							if (event.signal.aborted) resolve();
							else event.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						return {
							compaction: {
								summary: "must not be recorded",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous" }],
			timestamp: now - 1000,
		});
		const previousAssistant: AssistantMessage = {
			...fauxAssistantMessage("previous response", { stopReason: "length", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(previousAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const controller = new AbortController();
		const reason = new Error("cancel compaction");
		const prompt = harness.session.prompt("new prompt", { signal: controller.signal });
		await compactionStarted.promise;
		controller.abort(reason);

		await expect(prompt).rejects.toBe(reason);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it.each(["in-memory", "persisted"] as const)(
		"rolls back a %s compaction when cancellation arrives during session_compact",
		async (storage) => {
			const sessionDir = join(
				tmpdir(),
				`diffex-prompt-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(sessionDir, { recursive: true });
			tempDirs.push(sessionDir);
			const sessionManager =
				storage === "persisted"
					? SessionManager.create(sessionDir, sessionDir)
					: SessionManager.inMemory(sessionDir);
			const compactHookStarted = deferred();
			const releaseCompactHook = deferred();
			let hookCompleted = false;
			const harness = await createHarness({
				sessionManager,
				models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
				settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "temporarily recorded",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						}));
						pi.on("session_compact", async () => {
							compactHookStarted.resolve();
							await releaseCompactHook.promise;
							hookCompleted = true;
						});
					},
				],
			});
			harnesses.push(harness);
			const now = Date.now();
			const model = harness.getModel();
			const previousUserId = sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "previous" }],
				timestamp: now - 1000,
			});
			const previousAssistantId = sessionManager.appendMessage({
				...fauxAssistantMessage("previous response", { stopReason: "length", timestamp: now - 500 }),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(100),
			});
			harness.session.agent.state.messages = sessionManager.buildSessionContext().messages;
			const entriesBeforePrompt = structuredClone(sessionManager.getEntries());

			const controller = new AbortController();
			const reason = new Error("cancel saved compaction");
			const prompt = harness.session.prompt("new prompt", { signal: controller.signal });
			await compactHookStarted.promise;
			expect(sessionManager.getLeafEntry()).toMatchObject({ type: "compaction", summary: "temporarily recorded" });
			controller.abort(reason);
			releaseCompactHook.resolve();

			await expect(prompt).rejects.toBe(reason);
			expect(hookCompleted).toBe(true);
			expect(sessionManager.getEntries()).toEqual(entriesBeforePrompt);
			expect(sessionManager.getBranch().map((entry) => entry.id)).toEqual([previousUserId, previousAssistantId]);
			expect(sessionManager.getLeafId()).toBe(previousAssistantId);
			expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(0);

			if (storage === "persisted") {
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");
				const reopened = SessionManager.open(sessionFile, sessionDir);
				expect(reopened.getEntries()).toEqual(entriesBeforePrompt);
				expect(reopened.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			}
		},
	);

	it.each(["success", "preflight failure"])("removes its single abort listener after %s", async (outcome) => {
		const harness = await createHarness();
		harnesses.push(harness);
		if (outcome === "success") harness.setResponses([fauxAssistantMessage("done")]);
		else harness.session.agent.state.model = undefined as unknown as NonNullable<ReturnType<typeof harness.getModel>>;
		const controller = new AbortController();
		const addListener = vi.spyOn(controller.signal, "addEventListener");
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");

		const prompt = harness.session.prompt("listener", { signal: controller.signal });
		if (outcome === "success") await expect(prompt).resolves.toBeUndefined();
		else await expect(prompt).rejects.toThrow("No model selected.");

		expect(addListener).toHaveBeenCalledOnce();
		expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
		expect(removeListener).toHaveBeenCalledOnce();
		expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);
	});

	it("preserves pending next-turn messages when cancellation occurs at preflight acceptance", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "completed before acceptance",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous" }],
			timestamp: now - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { stopReason: "length", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const entriesBeforePrompt = structuredClone(harness.sessionManager.getEntries());
		await harness.session.sendCustomMessage(
			{ customType: "pending-context", content: "keep me", display: false },
			{ deliverAs: "nextTurn" },
		);
		const controller = new AbortController();
		const reason = new Error("cancel at acceptance");
		const preflightResults: boolean[] = [];

		const prompt = harness.session.prompt("acceptance boundary", {
			signal: controller.signal,
			preflightResult: (success) => {
				preflightResults.push(success);
				if (success) controller.abort(reason);
			},
		});

		await expect(prompt).rejects.toBe(reason);
		expect(preflightResults).toEqual([true]);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBeforePrompt);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				aborted: false,
				result: expect.objectContaining({ summary: "completed before acceptance" }),
			}),
		]);
		expect(harness.faux.state.callCount).toBe(0);

		harness.session.setAutoCompactionEnabled(false);
		await harness.session.prompt("next prompt");
		expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([
			expect.objectContaining({ customType: "pending-context", content: "keep me" }),
		]);
	});

	it("restores preflight state when failure notification aborts the prompt", async () => {
		let failBeforeStart = true;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "completed before failed preflight",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
					pi.on("before_agent_start", () => {
						if (!failBeforeStart) return;
						failBeforeStart = false;
						return {
							message: {
								customType: "failing-preflight-message",
								get content(): string {
									throw new Error("before-agent-start result failure");
								},
								display: false,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous" }],
			timestamp: now - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("previous response", { stopReason: "length", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const entriesBeforePrompt = structuredClone(harness.sessionManager.getEntries());
		await harness.session.sendCustomMessage(
			{ customType: "pending-context", content: "keep after failure", display: false },
			{ deliverAs: "nextTurn" },
		);
		const controller = new AbortController();
		const reason = new Error("cancel during failed preflight notification");
		const preflightResults: boolean[] = [];

		const prompt = harness.session.prompt("failed preflight", {
			signal: controller.signal,
			preflightResult: (success) => {
				preflightResults.push(success);
				if (!success) controller.abort(reason);
			},
		});

		await expect(prompt).rejects.toBe(reason);
		expect(preflightResults).toEqual([false]);
		expect(harness.sessionManager.getEntries()).toEqual(entriesBeforePrompt);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(0);

		harness.session.setAutoCompactionEnabled(false);
		await harness.session.prompt("next prompt");
		expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([
			expect.objectContaining({ customType: "pending-context", content: "keep after failure" }),
		]);
	});

	it("uses existing aborted-response settlement after agent_start", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const responseStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});
		const controller = new AbortController();
		const prompt = harness.session.prompt("start", { signal: controller.signal });
		await responseStarted;
		controller.abort(new Error("post-start reason must not reject prompt"));

		await expect(prompt).resolves.toBeUndefined();
		const assistant = harness.session.messages
			.slice()
			.reverse()
			.find((message) => message.role === "assistant");
		expect(assistant).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("throws when prompted during manual compaction", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const compactPromise = harness.session.compact();
		await compactionStarted;

		try {
			await expect(harness.session.prompt("third")).rejects.toThrow(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		} finally {
			releaseCompaction();
			await compactPromise;
		}
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
