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

});
