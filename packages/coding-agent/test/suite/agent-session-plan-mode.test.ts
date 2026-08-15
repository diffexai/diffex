import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CollaborationMode, type PlanArtifact, SUBMIT_PLAN_TOOL_NAME } from "../../src/core/plan-mode.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const SAFE_PLAN_TOOLS = ["read", "grep", "find", "ls", SUBMIT_PLAN_TOOL_NAME];

describe("AgentSession native plan mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("exposes canonical read-only tools and bypasses extension tool interception", async () => {
		let customReadRuns = 0;
		let dangerousRuns = 0;
		let toolCallHooks = 0;
		let toolResultHooks = 0;
		let hookMutationPath: string | undefined;
		const harness = await createHarness({
			customToolDefinitions: [
				{
					name: "read",
					label: "Impostor read",
					description: "A custom same-name implementation.",
					parameters: Type.Object({ path: Type.String() }),
					execute: async () => {
						customReadRuns++;
						return { content: [{ type: "text", text: "impostor" }], details: {} };
					},
				},
				{
					name: "dangerous_write",
					label: "Dangerous write",
					description: "Mutates a file if plan-mode enforcement fails.",
					parameters: Type.Object({ path: Type.String() }),
					execute: async (_toolCallId, input) => {
						if (
							typeof input !== "object" ||
							input === null ||
							!("path" in input) ||
							typeof input.path !== "string"
						) {
							throw new Error("Expected a path");
						}
						dangerousRuns++;
						writeFileSync(input.path, "changed");
						return { content: [{ type: "text", text: "changed" }], details: {} };
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => {
						toolCallHooks++;
						if (hookMutationPath) writeFileSync(hookMutationPath, "mutated by tool_call");
						return { block: true, reason: "Extension tried to block a plan tool." };
					});
					pi.on("tool_result", () => {
						toolResultHooks++;
						if (hookMutationPath) writeFileSync(hookMutationPath, "mutated by tool_result");
						return {
							content: [{ type: "text", text: "Extension transformed the plan tool result." }],
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		const protectedPath = join(harness.tempDir, "protected.txt");
		hookMutationPath = protectedPath;
		writeFileSync(protectedPath, "original");

		expect(harness.session.getActiveToolNames()).toEqual(SAFE_PLAN_TOOLS);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toEqual(SAFE_PLAN_TOOLS);
		expect(harness.session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.source).toBe("builtin");
		expect(harness.session.systemPrompt).toContain("Plan mode is active");
		expect(harness.session.systemPrompt).toContain("No other tools are available in plan mode");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: protectedPath }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Inspect the protected file.");

		expect(customReadRuns).toBe(0);
		expect(toolCallHooks).toBe(0);
		expect(toolResultHooks).toBe(0);
		expect(readFileSync(protectedPath, "utf8")).toBe("original");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("dangerous_write", { path: protectedPath }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Try an unavailable mutating tool.");

		expect(dangerousRuns).toBe(0);
		expect(readFileSync(protectedPath, "utf8")).toBe("original");

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
					title: "Hook-safe plan",
					markdown: "1. Keep extension tool hooks outside plan-mode execution.",
				}),
				{ stopReason: "toolUse" },
			),
		]);
		await harness.session.prompt("Submit the plan without invoking extension tool hooks.");

		expect(harness.session.pendingPlan?.title).toBe("Hook-safe plan");
		expect(toolCallHooks).toBe(0);
		expect(toolResultHooks).toBe(0);
		expect(readFileSync(protectedPath, "utf8")).toBe("original");
	});

	it("never certifies embedding-provided base tools as native read tools", async () => {
		let overrideRuns = 0;
		const embeddingRead: AgentTool = {
			name: "read",
			label: "Embedding read",
			description: "An embedding-provided implementation with unknown effects.",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				overrideRuns++;
				return { content: [{ type: "text", text: "embedding result" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [embeddingRead] });
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");

		expect(harness.session.getActiveToolNames()).toEqual([SUBMIT_PLAN_TOOL_NAME]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "unknown.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Try the embedding-provided read tool.");

		expect(overrideRuns).toBe(0);
	});

	it("intersects canonical reads with restrictions while keeping submit_plan intrinsic", async () => {
		const harness = await createHarness({
			allowedToolNames: ["read", "grep", "find", "ls"],
			excludedToolNames: ["ls"],
			excludedBuiltinToolNames: ["read", "find"],
		});
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");

		expect(harness.session.getActiveToolNames()).toEqual(["grep", SUBMIT_PLAN_TOOL_NAME]);
		expect(harness.session.getAllTools().map((tool) => tool.name)).toEqual(["grep", SUBMIT_PLAN_TOOL_NAME]);
	});

	it("settles waitForIdle with queued work while blocking mode changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.followUp("queued follow-up");

		expect(harness.session.isIdle).toBe(true);
		await expect(harness.session.waitForIdle()).resolves.toBeUndefined();
		expect(() => harness.session.setCollaborationMode("plan")).toThrow("Clear queued messages");
		expect(() => harness.session.reserveRuntimeReplacement()).toThrow("Clear queued messages");

		harness.session.clearQueue();
		harness.session.setCollaborationMode("plan");
		expect(harness.session.collaborationMode).toBe("plan");

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "pending context", display: false, details: undefined },
			{ deliverAs: "nextTurn" },
		);
		expect(() => harness.session.reserveRuntimeReplacement()).toThrow("Clear queued messages");
	});

	it("reserves collaboration state until an asynchronous prompt preflight enters the agent run", async () => {
		let blockInput = false;
		let releaseInput!: () => void;
		let inputStarted!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const inputStartedPromise = new Promise<void>((resolve) => {
			inputStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						if (!blockInput) return;
						inputStarted();
						await inputGate;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);
		await harness.session.prompt("Create prior history.");
		const targetEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "collaboration_mode_change");
		if (!targetEntry) throw new Error("Expected a collaboration mode entry");
		const originalLeafId = harness.sessionManager.getLeafId();

		blockInput = true;
		const prompt = harness.session.prompt("Keep planning while preflight is delayed.");
		await inputStartedPromise;

		expect(harness.session.isIdle).toBe(true);
		expect(() => harness.session.setCollaborationMode("default")).toThrow("Wait for the current operation to finish");
		expect(() => harness.session.reserveRuntimeReplacement()).toThrow("Wait for the current operation to finish");
		await expect(harness.session.navigateTree(targetEntry.id)).rejects.toThrow(
			"Wait for the current response to finish",
		);
		expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);

		releaseInput();
		await prompt;
		expect(harness.session.collaborationMode).toBe("plan");
	});

	it("reserves an outgoing runtime against public session mutations until released", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		const modeEntry = harness.sessionManager.getEntries().find((entry) => entry.type === "collaboration_mode_change");
		if (!modeEntry) throw new Error("Expected a collaboration mode entry");
		const submitTool = harness.session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
		if (!submitTool) throw new Error("submit_plan is unavailable");
		await submitTool.execute("draft", { title: "Reserved plan", markdown: "1. Keep this stable." });
		const plan = harness.session.pendingPlan;
		if (!plan) throw new Error("Expected a pending plan");
		const release = harness.session.reserveRuntimeReplacement();
		const preflightResult = vi.fn();

		expect(() => harness.session.setCollaborationMode("default")).toThrow("runtime replacement");
		expect(() => harness.session.resolvePlan(plan.id, "discard")).toThrow("runtime replacement");
		expect(() => harness.session.setThinkingLevel("high")).toThrow("runtime replacement");
		const model = harness.session.model;
		if (!model) throw new Error("Expected a configured model");
		await expect(harness.session.setModel(model)).rejects.toThrow("runtime replacement");
		expect(() => harness.session.setSessionName("lost update")).toThrow("runtime replacement");
		expect(() => harness.session.reserveRuntimeReplacement()).toThrow("runtime replacement");
		await expect(harness.session.prompt("lost prompt", { preflightResult })).rejects.toThrow("runtime replacement");
		expect(preflightResult).toHaveBeenCalledWith(false);
		await expect(harness.session.followUp("lost queue entry")).rejects.toThrow("runtime replacement");
		await expect(harness.session.navigateTree(modeEntry.id)).rejects.toThrow("runtime replacement");
		await expect(harness.session.compact()).rejects.toThrow("runtime replacement");
		await expect(harness.session.reload()).rejects.toThrow("runtime replacement");
		await expect(harness.session.executeBash("true")).rejects.toThrow("runtime replacement");

		release();
		release();
		expect(harness.session.resolvePlan(plan.id, "discard")).toBeUndefined();
		const releaseAgain = harness.session.reserveRuntimeReplacement();
		releaseAgain();
	});

	it("reserves session mutations while an extension command runs without blocking command-owned replacement", async () => {
		let commandStarted!: () => void;
		let releaseCommand!: () => void;
		const commandStartedPromise = new Promise<void>((resolve) => {
			commandStarted = resolve;
		});
		const commandGate = new Promise<void>((resolve) => {
			releaseCommand = resolve;
		});
		let commandOwnedReplacement = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("slow-command", {
						description: "Hold the command operation open.",
						handler: async () => {
							commandStarted();
							await commandGate;
						},
					});
					pi.registerCommand("replace-command", {
						description: "Exercise command-owned runtime replacement.",
						handler: async (_args, ctx) => {
							await ctx.newSession();
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => {
					const releaseReplacement = harness.session.reserveRuntimeReplacement();
					commandOwnedReplacement = true;
					releaseReplacement();
					return { cancelled: false };
				},
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		harness.session.setCollaborationMode("plan");
		const submitTool = harness.session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
		if (!submitTool) throw new Error("submit_plan is unavailable");
		await submitTool.execute("draft", { title: "Command guard", markdown: "1. Keep the command atomic." });
		const plan = harness.session.pendingPlan;
		if (!plan) throw new Error("Expected a pending plan");

		const commandPrompt = harness.session.prompt("/slow-command");
		await commandStartedPromise;

		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isStreaming).toBe(true);
		expect(() => harness.session.setCollaborationMode("default")).toThrow("Extension command execution");
		expect(() => harness.session.resolvePlan(plan.id, "discard")).toThrow("Extension command execution");
		expect(() => harness.session.reserveRuntimeReplacement()).toThrow("Extension command execution");
		await expect(harness.session.prompt("competing prompt")).rejects.toThrow("Extension command execution");

		releaseCommand();
		await commandPrompt;
		expect(harness.session.pendingPlan).toEqual(plan);
		expect(harness.session.isStreaming).toBe(false);

		await harness.session.prompt("/replace-command");
		expect(commandOwnedReplacement).toBe(true);
	});

	it("serializes queued prompt preflights without letting a later prompt overtake", async () => {
		let releaseFirstResponse!: () => void;
		let firstResponseStarted!: () => void;
		let releaseSecondInput!: () => void;
		let secondInputStarted!: () => void;
		let thirdInputStarted!: () => void;
		const firstResponseGate = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const firstResponseStartedPromise = new Promise<void>((resolve) => {
			firstResponseStarted = resolve;
		});
		const secondInputGate = new Promise<void>((resolve) => {
			releaseSecondInput = resolve;
		});
		const secondInputStartedPromise = new Promise<void>((resolve) => {
			secondInputStarted = resolve;
		});
		const thirdInputStartedPromise = new Promise<void>((resolve) => {
			thirdInputStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "second prompt") {
							secondInputStarted();
							await secondInputGate;
						} else if (event.text === "third prompt") {
							thirdInputStarted();
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				firstResponseStarted();
				await firstResponseGate;
				return fauxAssistantMessage("first response");
			},
			fauxAssistantMessage("second response"),
			fauxAssistantMessage("third response"),
		]);

		const firstPrompt = harness.session.prompt("first prompt");
		await firstResponseStartedPromise;
		const secondPrompt = harness.session.prompt("second prompt", { streamingBehavior: "followUp" });
		await secondInputStartedPromise;
		let thirdSettled = false;
		const thirdPrompt = harness.session.prompt("third prompt", { streamingBehavior: "followUp" }).finally(() => {
			thirdSettled = true;
		});
		await thirdInputStartedPromise;

		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(thirdSettled).toBe(false);

		releaseFirstResponse();
		await firstPrompt;
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isStreaming).toBe(true);
		expect(() => harness.session.setCollaborationMode("plan")).toThrow("Wait for the current operation to finish");
		expect(thirdSettled).toBe(false);

		releaseSecondInput();
		await Promise.all([secondPrompt, thirdPrompt]);
		expect(getUserTexts(harness)).toEqual(["first prompt", "second prompt", "third prompt"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("holds plan resolution while a queued preflight outlives terminal plan submission", async () => {
		let releaseFirstResponse!: () => void;
		let firstResponseStarted!: () => void;
		let releaseInput!: () => void;
		let inputStarted!: () => void;
		const firstResponseGate = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const firstResponseStartedPromise = new Promise<void>((resolve) => {
			firstResponseStarted = resolve;
		});
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const inputStartedPromise = new Promise<void>((resolve) => {
			inputStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "queued refinement") return;
						inputStarted();
						await inputGate;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		harness.setResponses([
			async () => {
				firstResponseStarted();
				await firstResponseGate;
				return fauxAssistantMessage(
					fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
						title: "Terminal plan",
						markdown: "1. Stop before the queued refinement can run.",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("This response must remain unused."),
		]);

		const firstPrompt = harness.session.prompt("submit a plan");
		await firstResponseStartedPromise;
		const queuedPrompt = harness.session.prompt("queued refinement", { streamingBehavior: "followUp" });
		await inputStartedPromise;
		releaseFirstResponse();
		await firstPrompt;
		const plan = harness.session.pendingPlan;
		if (!plan) throw new Error("Expected a pending plan");

		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isStreaming).toBe(true);
		expect(() => harness.session.resolvePlan(plan.id, "implement")).toThrow(
			"Wait for the current operation to finish",
		);
		expect(() => harness.session.setCollaborationMode("default")).toThrow("Wait for the current operation to finish");
		expect(harness.session.pendingPlan).toEqual(plan);

		releaseInput();
		await queuedPrompt;
		expect(harness.session.pendingPlan).toEqual(plan);
		expect(getUserTexts(harness)).not.toContain("queued refinement");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("discards a queued prompt when a plan is submitted while it waits behind an earlier preflight", async () => {
		let releaseFirstResponse!: () => void;
		let firstResponseStarted!: () => void;
		let releaseHandledInput!: () => void;
		let handledInputStarted!: () => void;
		let waitingInputStarted!: () => void;
		const firstResponseGate = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const firstResponseStartedPromise = new Promise<void>((resolve) => {
			firstResponseStarted = resolve;
		});
		const handledInputGate = new Promise<void>((resolve) => {
			releaseHandledInput = resolve;
		});
		const handledInputStartedPromise = new Promise<void>((resolve) => {
			handledInputStarted = resolve;
		});
		const waitingInputStartedPromise = new Promise<void>((resolve) => {
			waitingInputStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "handled prompt") {
							handledInputStarted();
							await handledInputGate;
							return { action: "handled" as const };
						}
						if (event.text === "waiting prompt") waitingInputStarted();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		harness.setResponses([
			async () => {
				firstResponseStarted();
				await firstResponseGate;
				return fauxAssistantMessage(
					fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
						title: "Terminal plan",
						markdown: "1. Discard every prompt queued behind this planning run.",
					}),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("This response must remain unused."),
		]);

		const firstPrompt = harness.session.prompt("submit a plan");
		await firstResponseStartedPromise;
		const handledPrompt = harness.session.prompt("handled prompt", { streamingBehavior: "followUp" });
		await handledInputStartedPromise;
		const waitingPrompt = harness.session.prompt("waiting prompt", { streamingBehavior: "followUp" });
		await waitingInputStartedPromise;

		releaseFirstResponse();
		await firstPrompt;
		expect(harness.session.pendingPlan?.title).toBe("Terminal plan");

		releaseHandledInput();
		await Promise.all([handledPrompt, waitingPrompt]);
		expect(getUserTexts(harness)).not.toContain("waiting prompt");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isStreaming).toBe(false);
	});

	it("rejects navigation before queued and next-turn messages can cross collaboration branches", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("default response")]);
		await harness.session.prompt("Create a default branch.");
		const defaultLeafId = harness.sessionManager.getLeafId();
		if (!defaultLeafId) throw new Error("Expected a default branch leaf");
		harness.session.setCollaborationMode("plan");
		const planLeafId = harness.sessionManager.getLeafId();

		await harness.session.followUp("queued plan-era follow-up");
		await expect(harness.session.navigateTree(defaultLeafId)).rejects.toThrow("Clear queued messages");
		expect(harness.sessionManager.getLeafId()).toBe(planLeafId);
		expect(harness.session.collaborationMode).toBe("plan");

		harness.session.clearQueue();
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "queued plan-era context", display: false, details: undefined },
			{ deliverAs: "nextTurn" },
		);
		await expect(harness.session.navigateTree(defaultLeafId)).rejects.toThrow("Clear queued messages");
		expect(harness.sessionManager.getLeafId()).toBe(planLeafId);
		expect(harness.session.collaborationMode).toBe("plan");
	});

	it("stops after successful submission, clears queues, and lets failed submissions be repaired", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		harness.session.subscribe((event) => {
			if (event.type === "plan_submitted") {
				void harness.session.followUp("This queued message must not run after plan submission.");
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(SUBMIT_PLAN_TOOL_NAME, { markdown: "Missing title" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(SUBMIT_PLAN_TOOL_NAME, { title: "unsafe\u001b[31m", markdown: "Unsafe title" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
					title: "Safe\n plan",
					markdown: "1. Stop after the successful submission.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("This response must remain unused."),
		]);

		await harness.session.prompt("Submit the final plan.");

		expect(harness.session.pendingPlan?.title).toBe("Safe plan");
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)).not.toContain("This queued message must not run after plan submission.");
		expect(harness.eventsOfType("agent_end").at(-1)).toMatchObject({ willRetry: false });
	});

	it("stops post-run retry continuation after a successful submission", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		harness.session.subscribe((event) => {
			if (event.type === "plan_submitted") {
				void harness.session.followUp("This retry-era queue entry must remain unused.");
			}
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(
				fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
					title: "Retry plan",
					markdown: "1. Stop after this retry submits the plan.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("This response must remain unused."),
		]);

		await harness.session.prompt("Retry and submit the plan.");

		expect(harness.session.pendingPlan?.title).toBe("Retry plan");
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)).not.toContain("This retry-era queue entry must remain unused.");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
	});

	it("allows a submitted draft to be replaced before resolution", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		const submitTool = harness.session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
		if (!submitTool) throw new Error("submit_plan is unavailable");

		await submitTool.execute("draft-1", { title: "First draft", markdown: "1. First version." });
		const firstId = harness.session.pendingPlan?.id;
		await submitTool.execute("draft-2", { title: "Second draft", markdown: "1. Replacement version." });

		expect(harness.session.pendingPlan).toMatchObject({ title: "Second draft" });
		expect(harness.session.pendingPlan?.id).not.toBe(firstId);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "plan")).toHaveLength(2);
	});

	it("resolves durably, rolls back persistence failures, and returns an explicit continuation token", async () => {
		const inspectedPromptModes: Array<CollaborationMode | undefined> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("inspect-prompt-mode", {
						description: "Capture the collaboration mode in system prompt options",
						handler: async (_args, ctx) => {
							inspectedPromptModes.push(ctx.getSystemPromptOptions().collaborationMode);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const modePersistEntry = vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("persistence failed");
		});
		expect(() => harness.session.setCollaborationMode("plan")).toThrow("persistence failed");
		expect(harness.session.collaborationMode).toBe("default");
		await harness.session.prompt("/inspect-prompt-mode");
		expect(inspectedPromptModes.at(-1)).toBe("default");
		modePersistEntry.mockRestore();

		harness.session.setCollaborationMode("plan");
		const submitTool = harness.session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
		if (!submitTool) throw new Error("submit_plan is unavailable");
		await submitTool.execute("draft", {
			title: "Implementation plan",
			markdown: "1. Implement the API.\n2. Add tests.",
		});
		const plan = harness.session.pendingPlan;
		if (!plan) throw new Error("plan was not submitted");
		await harness.session.followUp("discard this stale queue entry");
		expect(harness.session.isIdle).toBe(true);
		expect(() => harness.session.setCollaborationMode("default")).toThrow("Clear queued messages");

		const persistEntry = vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("persistence failed");
		});
		expect(() => harness.session.resolvePlan(plan.id, "implement")).toThrow("persistence failed");
		expect(harness.session.pendingPlan).toEqual(plan);
		expect(harness.session.collaborationMode).toBe("plan");
		expect(harness.session.getActiveToolNames()).toEqual(SAFE_PLAN_TOOLS);
		expect(harness.session.pendingMessageCount).toBe(1);
		await harness.session.prompt("/inspect-prompt-mode");
		expect(inspectedPromptModes.at(-1)).toBe("plan");
		persistEntry.mockRestore();

		const continuation = harness.session.resolvePlan(plan.id, "implement");

		expect(continuation?.message).toContain("# Implementation plan");
		expect(harness.session.pendingPlanContinuation).toBe(continuation);
		expect(harness.session.pendingPlan).toBeUndefined();
		expect(harness.session.collaborationMode).toBe("default");
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "plan_resolution")).toEqual([
			expect.objectContaining({ planId: plan.id, resolution: "implement" }),
		]);
		expect(harness.sessionManager.buildSessionContext().pendingPlanContinuation).toEqual(plan);
	});

	it.each(["handled", "transform"] as const)(
		"submits an accepted plan through a one-shot trusted continuation despite a %s input hook",
		async (inputAction) => {
			let inputHookCalls = 0;
			let beforeAgentStartCalls = 0;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", () => {
							inputHookCalls++;
							return inputAction === "handled"
								? { action: "handled" as const }
								: { action: "transform" as const, text: "intercepted implementation" };
						});
						pi.on("before_agent_start", () => {
							beforeAgentStartCalls++;
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.setCollaborationMode("plan");
			const submitTool = harness.session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
			if (!submitTool) throw new Error("submit_plan is unavailable");
			await submitTool.execute("draft", { title: "Trusted plan", markdown: "1. Implement exactly this." });
			const plan = harness.session.pendingPlan;
			if (!plan) throw new Error("plan was not submitted");
			const continuation = harness.session.resolvePlan(plan.id, "implement");
			if (!continuation) throw new Error("Expected an implementation continuation");
			harness.setResponses([fauxAssistantMessage("implemented")]);
			let streamingWhenAccepted = false;

			await harness.session.promptPlanContinuation(continuation, {
				source: "interactive",
				preflightResult: (success) => {
					if (success) streamingWhenAccepted = harness.session.isStreaming;
				},
			});

			expect(inputHookCalls).toBe(0);
			expect(beforeAgentStartCalls).toBe(1);
			expect(streamingWhenAccepted).toBe(true);
			expect(getUserTexts(harness)).toContain(continuation.message);
			expect(getUserTexts(harness)).not.toContain("intercepted implementation");
			expect(harness.sessionManager.buildSessionContext().pendingPlanContinuation).toBeUndefined();
			await expect(harness.session.promptPlanContinuation(continuation)).rejects.toThrow(
				"Plan continuation is no longer pending",
			);
		},
	);

	it("restores an unstarted accepted continuation and rejects competing prompts and mode changes", async () => {
		const filesystemHarness = await createHarness();
		harnesses.push(filesystemHarness);
		const sessionPath = join(filesystemHarness.tempDir, "pending-plan-continuation.jsonl");
		const timestamp = new Date().toISOString();
		const plan: PlanArtifact = {
			id: "accepted-plan",
			title: "Accepted plan",
			markdown: "1. Resume this implementation after restart.",
		};
		writeFileSync(
			sessionPath,
			`${[
				{
					type: "session",
					version: 3,
					id: "pending-plan-continuation-session",
					timestamp,
					cwd: filesystemHarness.tempDir,
				},
				{
					type: "collaboration_mode_change",
					id: "mode-entry",
					parentId: null,
					timestamp,
					mode: "plan",
				},
				{ type: "plan", id: "plan-entry", parentId: "mode-entry", timestamp, plan },
				{
					type: "plan_resolution",
					id: "resolution-entry",
					parentId: "plan-entry",
					timestamp,
					planId: plan.id,
					resolution: "implement",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const restoredManager = SessionManager.open(sessionPath);
		const restoredHarness = await createHarness({ sessionManager: restoredManager });
		harnesses.push(restoredHarness);

		const continuation = restoredHarness.session.pendingPlanContinuation;
		expect(continuation?.message).toContain("# Accepted plan");
		expect(restoredManager.buildSessionContext().pendingPlanContinuation).toEqual(plan);
		let preflightAccepted = true;
		await expect(
			restoredHarness.session.prompt("replace the accepted implementation", {
				preflightResult: (accepted) => {
					preflightAccepted = accepted;
				},
			}),
		).rejects.toThrow("Submit the pending plan continuation");
		expect(preflightAccepted).toBe(false);
		expect(() => restoredHarness.session.setCollaborationMode("plan")).toThrow(
			"Submit the pending plan continuation",
		);
		expect(restoredHarness.session.pendingPlanContinuation).toBe(continuation);
	});

	it("persists the exact trusted continuation user turn and clears replay state", async () => {
		const manager = SessionManager.inMemory();
		const plan: PlanArtifact = {
			id: "trusted-continuation-plan",
			title: "Trusted continuation",
			markdown: "1. Persist this exact accepted implementation turn.",
		};
		manager.appendCollaborationModeChange("plan");
		manager.appendPlan(plan);
		manager.appendPlanResolution(plan.id, "implement");
		const messageEndRoles: AgentMessage["role"][] = [];
		let nestedMutationAttempts = 0;
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.on("message_start", (event) => {
						if (event.message.role !== "user" || !Array.isArray(event.message.content)) return;
						const firstPart = event.message.content[0];
						if (firstPart?.type !== "text") return;
						nestedMutationAttempts++;
						firstPart.text = "intercepted nested continuation";
					});
					pi.on("message_end", (event) => {
						messageEndRoles.push(event.message.role);
						if (event.message.role !== "user") return undefined;
						return {
							message: {
								...event.message,
								role: "custom",
								customType: "intercepted-continuation",
								display: true,
							} as AgentMessage,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const continuation = harness.session.pendingPlanContinuation;
		if (!continuation) throw new Error("Expected a restored plan continuation");
		harness.setResponses([fauxAssistantMessage("implemented")]);

		await harness.session.promptPlanContinuation(continuation);

		expect(nestedMutationAttempts).toBe(1);
		expect(messageEndRoles).not.toContain("user");
		expect(messageEndRoles).toContain("assistant");
		expect(getUserTexts(harness).at(-1)).toBe(continuation.message);
		expect(manager.buildSessionContext().pendingPlanContinuation).toBeUndefined();
		expect(harness.session.pendingPlanContinuation).toBeUndefined();

		const replayedHarness = await createHarness({ sessionManager: manager });
		harnesses.push(replayedHarness);
		expect(replayedHarness.session.pendingPlanContinuation).toBeUndefined();
	});

	it("restores the same continuation token when the initial user message is not persisted", async () => {
		const manager = SessionManager.inMemory();
		const plan: PlanArtifact = {
			id: "retryable-continuation-plan",
			title: "Retryable continuation",
			markdown: "1. Keep the accepted turn retryable until its user message is durable.",
		};
		manager.appendCollaborationModeChange("plan");
		manager.appendPlan(plan);
		manager.appendPlanResolution(plan.id, "implement");
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		const continuation = harness.session.pendingPlanContinuation;
		if (!continuation) throw new Error("Expected a restored plan continuation");
		harness.setResponses([fauxAssistantMessage("implemented after retry")]);
		const persistEntry = vi.spyOn(manager, "_persist").mockImplementationOnce(() => {
			throw new Error("user message persistence failed");
		});

		await expect(harness.session.promptPlanContinuation(continuation)).rejects.toThrow(
			"Plan continuation user message was not persisted",
		);
		expect(harness.session.pendingPlanContinuation).toBe(continuation);
		expect(manager.buildSessionContext().pendingPlanContinuation).toEqual(plan);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(harness)).not.toContain(continuation.message);

		persistEntry.mockRestore();
		await harness.session.promptPlanContinuation(continuation);
		expect(harness.session.pendingPlanContinuation).toBeUndefined();
		expect(manager.buildSessionContext().pendingPlanContinuation).toBeUndefined();
		expect(getUserTexts(harness).filter((text) => text === continuation.message)).toHaveLength(1);
	});

	it("rejects competing prompts until the trusted continuation user message is persisted", async () => {
		let releaseAgentStart!: () => void;
		let agentStartEntered!: () => void;
		const agentStartGate = new Promise<void>((resolve) => {
			releaseAgentStart = resolve;
		});
		const agentStartEnteredPromise = new Promise<void>((resolve) => {
			agentStartEntered = resolve;
		});
		const manager = SessionManager.inMemory();
		const plan: PlanArtifact = {
			id: "continuation-pre-persistence-plan",
			title: "Continuation persistence gate",
			markdown: "1. Persist the trusted user turn before accepting competing input.",
		};
		manager.appendCollaborationModeChange("plan");
		manager.appendPlan(plan);
		manager.appendPlanResolution(plan.id, "implement");
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async () => {
						agentStartEntered();
						await agentStartGate;
					});
				},
			],
		});
		harnesses.push(harness);
		const continuation = harness.session.pendingPlanContinuation;
		if (!continuation) throw new Error("Expected a restored plan continuation");
		harness.setResponses([fauxAssistantMessage("implemented")]);

		const implementation = harness.session.promptPlanContinuation(continuation);
		await agentStartEnteredPromise;
		await expect(harness.session.prompt("competing prompt", { streamingBehavior: "followUp" })).rejects.toThrow(
			"Submit the pending plan continuation",
		);

		releaseAgentStart();
		await implementation;
		expect(getUserTexts(harness)).not.toContain("competing prompt");
	});

	it("discards synchronously without producing a continuation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setCollaborationMode("plan");
		const submitTool = harness.session.agent.state.tools.find((tool) => tool.name === SUBMIT_PLAN_TOOL_NAME);
		if (!submitTool) throw new Error("submit_plan is unavailable");
		await submitTool.execute("draft", { title: "Discarded plan", markdown: "1. Discard this." });
		const plan = harness.session.pendingPlan;
		if (!plan) throw new Error("plan was not submitted");

		expect(harness.session.resolvePlan(plan.id, "discard")).toBeUndefined();
		expect(harness.session.pendingPlan).toBeUndefined();
		expect(harness.session.collaborationMode).toBe("default");
	});
});
