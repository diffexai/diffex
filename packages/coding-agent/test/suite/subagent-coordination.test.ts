import type { Context, SimpleStreamOptions } from "@diffexai/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../extension-test-utils.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { deferred, getLastUserText, getSettledAgentStatus, waitForSettledAgents } from "./subagent-harness.ts";

interface BatchPayload {
	readonly type: "subagent_batch_results";
	readonly agents: readonly {
		readonly name: string;
		readonly status: "idle" | "failed" | "interrupted";
		readonly attempt: "initial" | "retry";
		readonly retry_available: boolean;
		readonly result?: string;
		readonly partial_output?: string;
		readonly error?: string;
	}[];
	readonly retry_instruction?: string;
	readonly retry_targets?: readonly string[];
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
}

function hasTool(context: Context, name: string): boolean {
	return context.tools?.some((tool) => tool.name === name) ?? false;
}

function hasToolResult(context: Context, name: string): boolean {
	return context.messages.some((message) => message.role === "toolResult" && message.toolName === name);
}

function getToolResultCount(context: Context, name: string): number {
	return context.messages.filter((message) => message.role === "toolResult" && message.toolName === name).length;
}

function getBatchPayloads(context: Context): BatchPayload[] {
	return context.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		const text = getMessageText(message);
		try {
			const payload = JSON.parse(text) as Partial<BatchPayload>;
			return payload.type === "subagent_batch_results" ? [payload as BatchPayload] : [];
		} catch {
			return [];
		}
	});
}

function getHiddenResultMessages(root: AgentSession): CustomMessage[] {
	return root.messages.flatMap((message) =>
		message.role === "custom" && message.customType === "subagent_results" ? [message] : [],
	);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for condition");
}

describe("automatic subagent coordination", () => {
	const roots: AgentSession[] = [];
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await root.dispose();
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	async function createRoot(maxConcurrent = 2): Promise<{ root: AgentSession; harness: Harness }> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const { session: root } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model: harness.getModel(),
			tools: ["spawn_agent", "agent_action", "agent_status"],
			subagents: { maxConcurrent },
		});
		roots.push(root);
		return { root, harness };
	}

	it("keeps the parent pending and resumes it with the child result", async () => {
		const { root, harness } = await createRoot();
		const releaseChild = deferred<void>();
		const parentFinishedEarly = deferred<void>();
		const parentContexts: Context[] = [];
		harness.setResponses(
			Array.from({ length: 8 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					await releaseChild.promise;
					return fauxAssistantMessage("CHILD-RESULT-SENTINEL");
				}

				const lastMessage = context.messages.at(-1);
				if (JSON.stringify(lastMessage)?.includes("subagent_completion_check")) {
					return fauxAssistantMessage("The delegated work is still needed; wait for completion.");
				}
				parentContexts.push(context);
				const hiddenResult = context.messages.find(
					(message) => message.role === "user" && getMessageText(message).includes("CHILD-RESULT-SENTINEL"),
				);
				if (hiddenResult) {
					return fauxAssistantMessage("automatic final answer");
				}
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(
						fauxToolCall("spawn_agent", { name: "worker", task: "finish delayed work" }),
						{ stopReason: "toolUse" },
					);
				}

				parentFinishedEarly.resolve();
				return fauxAssistantMessage("attempted early finish");
			}),
		);

		const prompt = root.prompt("delegate work");
		await parentFinishedEarly.promise;
		try {
			await expectPending(prompt);
		} finally {
			releaseChild.resolve();
		}
		await prompt;

		expect(root.getLastAssistantText()).toBe("automatic final answer");
		expect(parentContexts).toHaveLength(3);
		expect(getMessageText(parentContexts[2]?.messages.at(-1))).toContain("CHILD-RESULT-SENTINEL");
	});

	it.each([false, true])("settles children after exhausted parent retries (queued report: %s)", async (queued) => {
		const { root, harness } = await createRoot(1);
		harness.settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			compaction: { enabled: false },
		});
		const childStarted = deferred<void>();
		const exhausted = deferred<void>();
		const releaseChildCleanup = deferred<void>();
		const events: AgentSessionEvent[] = [];
		let parentCalls = 0;
		let childCalls = 0;
		let childAborted = false;
		root.subscribe((event) => {
			events.push(event);
			if (event.type === "auto_retry_end" && !event.success) {
				if (queued) {
					void root.sendCustomMessage({
						customType: "subagent_results",
						content: "queued child report",
						display: false,
					});
				}
				exhausted.resolve();
			}
		});
		harness.setResponses(
			Array.from({ length: 12 }, () => async (context: Context, options?: SimpleStreamOptions) => {
				if (!hasTool(context, "spawn_agent")) {
					childCalls += 1;
					childStarted.resolve();
					await new Promise<void>((resolve) => {
						const finish = () => {
							childAborted = true;
							resolve();
						};
						if (options?.signal?.aborted) finish();
						else options?.signal?.addEventListener("abort", finish, { once: true });
					});
					await releaseChildCleanup.promise;
					return fauxAssistantMessage("child partial", { stopReason: "aborted" });
				}
				const lastMessage = context.messages.at(-1);
				if (JSON.stringify(lastMessage)?.includes("subagent_completion_check")) {
					return fauxAssistantMessage("The delegated work is still needed; wait for completion.");
				}
				parentCalls += 1;
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(
						[
							fauxToolCall("spawn_agent", { name: "running", task: "wait for cancellation" }),
							fauxToolCall("spawn_agent", { name: "queued", task: "wait for a permit" }),
						],
						{ stopReason: "toolUse" },
					);
				}
				await childStarted.promise;
				return parentCalls <= 5
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exhausted" })
					: fauxAssistantMessage("unexpected continuation");
			}),
		);

		const prompt = root.prompt("delegate then exhaust provider retries");
		try {
			await exhausted.promise;
			await waitFor(() => childAborted);
			await expectPending(prompt);
			releaseChildCleanup.resolve();
			await waitFor(() => root.isIdle);
			await prompt;
			expect(parentCalls).toBe(5);
			expect(childCalls).toBe(1);
			expect(root.getSubagents().map((child) => child.status)).toEqual(["interrupted", "interrupted"]);
			expect(root.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "429 rate limit exhausted" });
			expect(root.state.errorMessage).toBe("429 rate limit exhausted");
			expect(getHiddenResultMessages(root)).toHaveLength(0);
			expect(events.filter((event) => event.type === "auto_retry_start")).toHaveLength(3);
			expect(events.filter((event) => event.type === "auto_retry_end")).toEqual([
				{ type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limit exhausted" },
			]);
			expect(events.filter((event) => event.type === "subagent_wait_end")).toEqual([
				{ type: "subagent_wait_end", names: ["queued", "running"], cancelled: true },
			]);
			root.clearQueue();
			harness.setResponses([fauxAssistantMessage("explicit recovery")]);
			await root.prompt("try again explicitly");
			expect(root.getLastAssistantText()).toBe("explicit recovery");
			expect(getHiddenResultMessages(root)).toHaveLength(0);
		} finally {
			releaseChildCleanup.resolve();
			await root.abort();
			await prompt;
		}
	});

	it("closes a suspended batch and newly spawned children when escalation handling fails", async () => {
		const { root, harness } = await createRoot(1);
		const waitStarted = deferred<void>();
		const childWaiting = deferred<void>();
		const events: AgentSessionEvent[] = [];
		let parentCalls = 0;
		root.subscribe((event) => {
			events.push(event);
			if (event.type === "subagent_wait_start") waitStarted.resolve();
		});
		harness.setResponses(
			Array.from({ length: 12 }, () => async (context: Context, options?: SimpleStreamOptions) => {
				if (!hasTool(context, "spawn_agent")) {
					if (!hasToolResult(context, "escalate_to_parent")) {
						await waitStarted.promise;
						return fauxAssistantMessage(fauxToolCall("escalate_to_parent", { message: "need another worker" }), {
							stopReason: "toolUse",
						});
					}
					childWaiting.resolve();
					return await new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
						const finish = () => resolve(fauxAssistantMessage("partial", { stopReason: "aborted" }));
						if (options?.signal?.aborted) finish();
						else options?.signal?.addEventListener("abort", finish, { once: true });
					});
				}
				const lastMessage = context.messages.at(-1);
				if (JSON.stringify(lastMessage)?.includes("subagent_completion_check")) {
					return fauxAssistantMessage("The delegated work is still needed; wait for completion.");
				}
				parentCalls += 1;
				const spawned = getToolResultCount(context, "spawn_agent");
				if (spawned === 0) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "first", task: "report a blocker" }), {
						stopReason: "toolUse",
					});
				}
				if (!JSON.stringify(context.messages).includes("subagent_escalations")) {
					return fauxAssistantMessage("wait for the first child");
				}
				if (spawned === 1) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "second", task: "help first" }), {
						stopReason: "toolUse",
					});
				}
				await childWaiting.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" });
			}),
		);

		await root.prompt("delegate and handle escalation");
		expect(parentCalls).toBe(4);
		expect(root.getSubagents().map((child) => child.status)).toEqual(["interrupted", "interrupted"]);
		expect(root.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "invalid_api_key" });
		expect(getHiddenResultMessages(root)).toHaveLength(0);
		expect(events.filter((event) => event.type === "subagent_wait_end")).toEqual([
			{ type: "subagent_wait_end", names: ["first"], cancelled: true },
			{ type: "subagent_wait_end", names: ["second"], cancelled: true },
		]);
	});

	it("notices each completion and delivers one name-sorted batch", async () => {
		const { root, harness } = await createRoot();
		const releaseAlpha = deferred<void>();
		const releaseBeta = deferred<void>();
		const notices: string[] = [];
		const lifecycle: string[] = [];
		root.subscribe((event) => {
			if (event.type === "subagent_notice") notices.push(event.text);
			if (event.type === "subagent_wait_start" || event.type === "subagent_wait_end") lifecycle.push(event.type);
		});
		harness.setResponses(
			Array.from({ length: 10 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					const task = getLastUserText(context);
					await (task === "alpha task" ? releaseAlpha.promise : releaseBeta.promise);
					return fauxAssistantMessage(`result for ${task}`);
				}
				const batches = getBatchPayloads(context);
				if (batches.length > 0) return fauxAssistantMessage("sorted synthesis");
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(
						[
							fauxToolCall("spawn_agent", { name: "alpha", task: "alpha task" }),
							fauxToolCall("spawn_agent", { name: "beta", task: "beta task" }),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("attempted batch finish");
			}),
		);

		const prompt = root.prompt("delegate two tasks");
		await waitFor(() => lifecycle.includes("subagent_wait_start"));
		releaseBeta.resolve();
		await waitFor(() => notices.length === 1);
		expect(notices).toEqual(["beta has finished execution."]);
		await expectPending(prompt);
		releaseAlpha.resolve();
		await prompt;

		expect(notices).toEqual(["beta has finished execution.", "alpha has finished execution."]);
		expect(lifecycle).toEqual(["subagent_wait_start", "subagent_wait_end"]);
		const hiddenMessages = getHiddenResultMessages(root);
		expect(hiddenMessages).toHaveLength(1);
		const payload = JSON.parse(
			typeof hiddenMessages[0]?.content === "string" ? hiddenMessages[0].content : "",
		) as BatchPayload;
		expect(payload.agents).toEqual([
			expect.objectContaining({ name: "alpha", result: "result for alpha task" }),
			expect.objectContaining({ name: "beta", result: "result for beta task" }),
		]);
		const persisted = JSON.stringify(root.sessionManager.getEntries());
		expect(persisted).not.toContain("has finished execution.");
		expect(JSON.stringify(root.messages)).not.toContain("has finished execution.");
	});

	it("offers one corrective retry and waits for its successful result", async () => {
		const { root, harness } = await createRoot();
		const retryStarted = deferred<void>();
		const releaseRetry = deferred<void>();
		const parentFinishedRetryEarly = deferred<void>();
		const notices: string[] = [];
		root.subscribe((event) => {
			if (event.type === "subagent_notice") notices.push(event.text);
		});
		harness.setResponses(
			Array.from({ length: 14 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					const task = getLastUserText(context);
					if (task === "fail once") {
						return fauxAssistantMessage("PARTIAL-FAILURE-SENTINEL", {
							stopReason: "error",
							errorMessage: "recoverable child error",
						});
					}
					retryStarted.resolve();
					await releaseRetry.promise;
					return fauxAssistantMessage("RETRY-SUCCESS-SENTINEL");
				}

				const batches = getBatchPayloads(context);
				if (batches.length === 2) return fauxAssistantMessage("retry synthesis");
				if (batches.length === 1 && getToolResultCount(context, "agent_action") === 0) {
					return fauxAssistantMessage(
						fauxToolCall("agent_action", {
							target: "worker",
							action: "message",
							message: "correct the child error",
							wake: true,
						}),
						{ stopReason: "toolUse" },
					);
				}
				if (getToolResultCount(context, "agent_action") === 1) {
					parentFinishedRetryEarly.resolve();
					return fauxAssistantMessage("attempted retry finish");
				}
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "fail once" }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("attempted initial finish");
			}),
		);

		const prompt = root.prompt("recover the child");
		await Promise.all([retryStarted.promise, parentFinishedRetryEarly.promise]);
		await expectPending(prompt);
		releaseRetry.resolve();
		await prompt;

		expect(root.getLastAssistantText()).toBe("retry synthesis");
		expect(notices).toEqual(["worker failed and a retry is being planned.", "worker has finished execution."]);
		const hiddenMessages = getHiddenResultMessages(root);
		expect(hiddenMessages).toHaveLength(2);
		const failure = JSON.parse(
			typeof hiddenMessages[0]?.content === "string" ? hiddenMessages[0].content : "",
		) as BatchPayload;
		expect(failure).toMatchObject({
			agents: [
				{
					name: "worker",
					status: "failed",
					attempt: "initial",
					retry_available: true,
					partial_output: "PARTIAL-FAILURE-SENTINEL",
					error: "recoverable child error",
				},
			],
			retry_targets: ["worker"],
		});
		expect(failure.retry_instruction).toContain("wake set to true");
	});

	it("rejects a second retry in one cycle and resets the limit for a later prompt", async () => {
		const { root, harness } = await createRoot();
		let childAttempts = 0;
		harness.setResponses(
			Array.from({ length: 16 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					childAttempts += 1;
					return fauxAssistantMessage(`partial ${childAttempts}`, {
						stopReason: "error",
						errorMessage: `failure ${childAttempts}`,
					});
				}
				const batches = getBatchPayloads(context);
				const actionResults = getToolResultCount(context, "agent_action");
				if (batches.length === 2 && actionResults === 1) {
					return fauxAssistantMessage(
						fauxToolCall("agent_action", {
							target: "worker",
							action: "message",
							message: "retry again",
							wake: true,
						}),
						{ stopReason: "toolUse" },
					);
				}
				if (batches.length === 2 && actionResults === 2) return fauxAssistantMessage("retry exhausted");
				if (batches.length === 1 && actionResults === 0) {
					return fauxAssistantMessage(
						fauxToolCall("agent_action", {
							target: "worker",
							action: "message",
							message: "first correction",
							wake: true,
						}),
						{ stopReason: "toolUse" },
					);
				}
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "fail twice" }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("attempted finish");
			}),
		);

		await root.prompt("exhaust this cycle");
		expect(childAttempts).toBe(2);
		expect(root.getLastAssistantText()).toBe("retry exhausted");
		const actionResults = root.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "agent_action",
		);
		expect(actionResults).toHaveLength(2);
		expect(actionResults[1]).toMatchObject({ isError: true });
		expect(getMessageText(actionResults[1])).toContain("Subagent retry limit reached");

		harness.setResponses(
			Array.from({ length: 10 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) return fauxAssistantMessage("later retry succeeded");
				let promptIndex = -1;
				for (let index = context.messages.length - 1; index >= 0; index -= 1) {
					const message = context.messages[index];
					if (message?.role === "user" && getMessageText(message) === "retry in a new prompt") {
						promptIndex = index;
						break;
					}
				}
				const recent = promptIndex < 0 ? [] : context.messages.slice(promptIndex + 1);
				const recentActionResults = recent.filter(
					(message) => message.role === "toolResult" && message.toolName === "agent_action",
				).length;
				const recentBatches = recent.filter(
					(message) => message.role === "user" && getMessageText(message).includes("later retry succeeded"),
				).length;
				if (recentBatches > 0) return fauxAssistantMessage("later cycle synthesis");
				if (recentActionResults === 0) {
					return fauxAssistantMessage(
						fauxToolCall("agent_action", {
							target: "worker",
							action: "message",
							message: "new cycle correction",
							wake: true,
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("attempted later finish");
			}),
		);
		await root.prompt("retry in a new prompt");
		expect(root.getLastAssistantText()).toBe("later cycle synthesis");
	});

	it.each(["steer", "followUp"] as const)(
		"starts a fresh retry cycle when queued %s input is delivered",
		async (delivery) => {
			const { root, harness } = await createRoot();
			const readyForQueuedInput = deferred<void>();
			const releaseParent = deferred<void>();
			const queuedInput = `new cycle via ${delivery}`;
			let childAttempts = 0;
			harness.setResponses(
				Array.from({ length: 24 }, () => async (context: Context) => {
					if (!hasTool(context, "spawn_agent")) {
						childAttempts += 1;
						if (childAttempts <= 2) {
							return fauxAssistantMessage(`partial ${childAttempts}`, {
								stopReason: "error",
								errorMessage: `failure ${childAttempts}`,
							});
						}
						return fauxAssistantMessage("queued retry succeeded");
					}

					let queuedInputIndex = -1;
					for (let index = context.messages.length - 1; index >= 0; index -= 1) {
						const message = context.messages[index];
						if (message?.role === "user" && getMessageText(message) === queuedInput) {
							queuedInputIndex = index;
							break;
						}
					}
					if (queuedInputIndex >= 0) {
						const recentContext = {
							...context,
							messages: context.messages.slice(queuedInputIndex + 1),
						};
						const recentBatches = getBatchPayloads(recentContext);
						if (
							recentBatches.some((batch) =>
								batch.agents.some((agent) => agent.result === "queued retry succeeded"),
							)
						) {
							return fauxAssistantMessage("queued cycle synthesis");
						}
						if (getToolResultCount(recentContext, "agent_action") === 0) {
							return fauxAssistantMessage(
								fauxToolCall("agent_action", {
									target: "worker",
									action: "message",
									message: "correction from queued input",
									wake: true,
								}),
								{ stopReason: "toolUse" },
							);
						}
						return fauxAssistantMessage("attempted queued finish");
					}

					const batches = getBatchPayloads(context);
					const actionResults = getToolResultCount(context, "agent_action");
					if (batches.length === 2 && actionResults === 1) {
						return fauxAssistantMessage(
							fauxToolCall("agent_action", {
								target: "worker",
								action: "message",
								message: "exhaust this cycle",
								wake: true,
							}),
							{ stopReason: "toolUse" },
						);
					}
					if (actionResults === 2) {
						readyForQueuedInput.resolve();
						await releaseParent.promise;
						return fauxAssistantMessage("retry exhausted before queued input");
					}
					if (batches.length === 1 && actionResults === 0) {
						return fauxAssistantMessage(
							fauxToolCall("agent_action", {
								target: "worker",
								action: "message",
								message: "first correction",
								wake: true,
							}),
							{ stopReason: "toolUse" },
						);
					}
					if (!hasToolResult(context, "spawn_agent")) {
						return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "fail twice" }), {
							stopReason: "toolUse",
						});
					}
					return fauxAssistantMessage("attempted initial finish");
				}),
			);

			const prompt = root.prompt("exhaust retry before queued input");
			await readyForQueuedInput.promise;
			if (delivery === "steer") {
				await root.steer(queuedInput);
			} else {
				await root.followUp(queuedInput);
			}
			releaseParent.resolve();
			await prompt;

			expect(childAttempts).toBe(3);
			expect(root.getLastAssistantText()).toBe("queued cycle synthesis");
			const actionResults = root.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "agent_action",
			);
			expect(actionResults).toHaveLength(3);
			expect(actionResults[1]).toMatchObject({ isError: true });
			expect(actionResults[2]).toMatchObject({ isError: false });
		},
	);

	it("settles when the parent declines the offered retry", async () => {
		const { root, harness } = await createRoot();
		harness.setResponses(
			Array.from({ length: 8 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					return fauxAssistantMessage("partial decline", {
						stopReason: "error",
						errorMessage: "not worth retrying",
					});
				}
				if (getBatchPayloads(context).length > 0) return fauxAssistantMessage("declined retry");
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "decline" }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("attempted finish");
			}),
		);

		await root.prompt("do not retry if it fails");
		expect(root.getLastAssistantText()).toBe("declined retry");
		expect(getToolResultCount({ messages: root.messages } as Context, "agent_action")).toBe(0);
	});

	it("treats terminal agent_status tool results as already consumed", async () => {
		const { root, harness } = await createRoot();
		harness.setResponses(
			Array.from({ length: 8 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) return fauxAssistantMessage("explicit child result");
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "explicit" }), {
						stopReason: "toolUse",
					});
				}
				if (!hasToolResult(context, "agent_status")) {
					await waitForSettledAgents(root, ["worker"]);
					return fauxAssistantMessage(fauxToolCall("agent_status", { targets: ["worker"] }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("explicit synthesis");
			}),
		);
		const events: string[] = [];
		root.subscribe((event) => events.push(event.type));

		await root.prompt("retrieve explicitly");
		expect(root.getLastAssistantText()).toBe("explicit synthesis");
		expect(
			root.messages.some((message) => message.role === "custom" && message.customType === "subagent_results"),
		).toBe(false);
		expect(events).not.toContain("subagent_wait_start");
		expect(events).not.toContain("subagent_notice");
	});

	it("leaves children spawned through direct SDK calls manually managed", async () => {
		const { root, harness } = await createRoot();
		const childStarted = deferred<void>();
		const releaseChild = deferred<void>();
		harness.setResponses(
			Array.from({ length: 6 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					childStarted.resolve();
					await releaseChild.promise;
					return fauxAssistantMessage("manual child result");
				}
				return fauxAssistantMessage("ordinary parent answer");
			}),
		);
		await root
			.getToolDefinition("spawn_agent")
			?.execute(
				"direct-spawn",
				{ name: "manual", task: "manual work" },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
		await childStarted.promise;

		await root.prompt("ordinary prompt");
		expect(root.getLastAssistantText()).toBe("ordinary parent answer");
		expect(root.getSubagents()).toEqual([{ name: "manual", status: "running", task: "manual work" }]);
		releaseChild.resolve();
		await getSettledAgentStatus(root, ["manual"]);
	});

	it("leaves retries of failed direct SDK children manually managed", async () => {
		const { root, harness } = await createRoot();
		const retryStarted = deferred<void>();
		const releaseRetry = deferred<void>();
		let childAttempts = 0;
		harness.setResponses(
			Array.from({ length: 8 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					childAttempts += 1;
					if (childAttempts === 1) {
						return fauxAssistantMessage("manual partial output", {
							stopReason: "error",
							errorMessage: "manual child failure",
						});
					}
					retryStarted.resolve();
					await releaseRetry.promise;
					return fauxAssistantMessage("manual retry result");
				}
				if (!hasToolResult(context, "agent_action")) {
					return fauxAssistantMessage(
						fauxToolCall("agent_action", {
							target: "manual",
							action: "message",
							message: "retry manually",
							wake: true,
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("ordinary parent answer");
			}),
		);
		await root
			.getToolDefinition("spawn_agent")
			?.execute(
				"direct-spawn",
				{ name: "manual", task: "fail manually" },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
		await waitFor(() => root.getSubagents()[0]?.status === "failed");

		const prompt = root.prompt("wake the manual child");
		await retryStarted.promise;
		await prompt;
		expect(root.getLastAssistantText()).toBe("ordinary parent answer");
		expect(root.getSubagents()).toEqual([{ name: "manual", status: "running", task: "fail manually" }]);
		expect(getHiddenResultMessages(root)).toHaveLength(0);

		releaseRetry.resolve();
		await getSettledAgentStatus(root, ["manual"]);
	});

	it("preserves cancellation before the subagent wait is installed", async () => {
		const { root, harness } = await createRoot();
		const abortStarted = deferred<void>();
		const lifecycle: Array<{ type: "start" } | { type: "end"; cancelled: boolean }> = [];
		let abortPromise: Promise<void> | undefined;
		let parentCalls = 0;
		root.subscribe((event) => {
			if (event.type === "agent_end" && !abortPromise) {
				abortPromise = root.abort();
				abortStarted.resolve();
			}
			if (event.type === "subagent_wait_start") lifecycle.push({ type: "start" });
			if (event.type === "subagent_wait_end") lifecycle.push({ type: "end", cancelled: event.cancelled });
		});
		harness.setResponses(
			Array.from({ length: 6 }, () => async (context: Context, options?: SimpleStreamOptions) => {
				if (!hasTool(context, "spawn_agent")) {
					return await new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
						const resolveAbort = () => {
							resolve(fauxAssistantMessage("child partial", { stopReason: "aborted" }));
						};
						if (options?.signal?.aborted) resolveAbort();
						else options?.signal?.addEventListener("abort", resolveAbort, { once: true });
					});
				}
				const lastMessage = context.messages.at(-1);
				if (JSON.stringify(lastMessage)?.includes("subagent_completion_check")) {
					return fauxAssistantMessage("The delegated work is still needed; wait for completion.");
				}
				parentCalls += 1;
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "wait forever" }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("attempted finish before cancellation");
			}),
		);

		const prompt = root.prompt("cancel before post-run coordination");
		await abortStarted.promise;
		await prompt;
		await abortPromise;

		expect(parentCalls).toBe(2);
		expect(lifecycle).toEqual([{ type: "start" }, { type: "end", cancelled: true }]);
		expect(root.getSubagents()).toEqual([{ name: "worker", status: "interrupted", task: "wait forever" }]);
		expect(getHiddenResultMessages(root)).toHaveLength(0);
	});

	it("interrupts a frozen batch on cancellation without another provider call", async () => {
		const { root, harness } = await createRoot();
		const childrenStarted = new Set<string>();
		const notices: string[] = [];
		const waitEnded = deferred<boolean>();
		let parentCalls = 0;
		root.subscribe((event) => {
			if (event.type === "subagent_notice") notices.push(event.text);
			if (event.type === "subagent_wait_end") waitEnded.resolve(event.cancelled);
		});
		harness.setResponses(
			Array.from({ length: 8 }, () => async (context: Context, options?: SimpleStreamOptions) => {
				if (!hasTool(context, "spawn_agent")) {
					const name = getLastUserText(context).split(" ")[0] ?? "child";
					childrenStarted.add(name);
					return await new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
						options?.signal?.addEventListener(
							"abort",
							() => resolve(fauxAssistantMessage(`${name} partial`, { stopReason: "aborted" })),
							{ once: true },
						);
					});
				}
				const lastMessage = context.messages.at(-1);
				if (JSON.stringify(lastMessage)?.includes("subagent_completion_check")) {
					return fauxAssistantMessage("The delegated work is still needed; wait for completion.");
				}
				parentCalls += 1;
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(
						[
							fauxToolCall("spawn_agent", { name: "alpha", task: "alpha waits" }),
							fauxToolCall("spawn_agent", { name: "beta", task: "beta waits" }),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("attempted cancellation finish");
			}),
		);

		const prompt = root.prompt("cancel the batch");
		await waitFor(() => childrenStarted.size === 2 && root.isStreaming);
		await root.steer("queued steering");
		await root.followUp("queued follow-up");
		const queued = root.clearQueue();
		expect(queued).toEqual({ steering: ["queued steering"], followUp: ["queued follow-up"] });
		await root.abort();
		await prompt;

		expect(await waitEnded.promise).toBe(true);
		expect(parentCalls).toBe(2);
		expect(notices.sort()).toEqual(["alpha was interrupted.", "beta was interrupted."]);
		expect(root.getSubagents().map((agent) => agent.status)).toEqual(["interrupted", "interrupted"]);
		expect(
			root.messages.some((message) => message.role === "custom" && message.customType === "subagent_results"),
		).toBe(false);
	});
});
