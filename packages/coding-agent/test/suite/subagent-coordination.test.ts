import type { Context, SimpleStreamOptions } from "@earendil-works/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { deferred, getLastUserText } from "./subagent-harness.ts";

interface ProgressAttempt {
	readonly result_id: string;
	readonly name: string;
	readonly status: "idle" | "failed" | "interrupted";
	readonly attempt: number;
	readonly result?: string;
	readonly error?: string;
	readonly exhausted?: true;
}

interface ProgressManifest {
	readonly cohort_id: string;
	readonly agents: readonly {
		readonly name: string;
		readonly status: "queued" | "running" | "idle" | "failed" | "interrupted";
		readonly attempt: number;
		readonly result_id: string;
		readonly exhausted?: true;
	}[];
	readonly unresolved: readonly string[];
}

type ProgressPayload =
	| {
			readonly cohort_id: string;
			readonly cohort_complete: false;
			readonly completed_attempts: readonly ProgressAttempt[];
			readonly manifest: ProgressManifest;
	  }
	| {
			readonly cohort_complete: true;
			readonly manifest: ProgressManifest;
	  };

function hasTool(context: Context, name: string): boolean {
	return context.tools?.some((tool) => tool.name === name) ?? false;
}

function getToolResultNames(context: Context): string[] {
	return context.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolName] : []));
}

function getUserTexts(context: Context): string[] {
	return context.messages.filter((message) => message.role === "user").map((message) => getMessageText(message));
}

function getNotifications(root: AgentSession) {
	return root.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" && entry.customType === "subagent_progress" ? [entry] : []));
}

function parseNotification(content: string | unknown[]): ProgressPayload {
	if (typeof content !== "string") throw new Error("Expected text-only subagent progress");
	return JSON.parse(content) as ProgressPayload;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for condition");
}

function findLastMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item !== undefined && predicate(item)) return item;
	}
	return undefined;
}

function findLastMatchingIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item !== undefined && predicate(item)) return index;
	}
	return -1;
}

describe("automatic subagent coordination", () => {
	const roots: AgentSession[] = [];
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		for (const root of roots.splice(0)) await root.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
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
			tools: ["spawn_agent", "agent_action", "agents"],
			subagents: { maxConcurrent },
		});
		roots.push(root);
		return { root, harness };
	}

	it("resumes an idle parent and synthesizes without another user prompt", async () => {
		const { root, harness } = await createRoot();
		const childResult = deferred<void>();
		const synthesis = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				await childResult.promise;
				return fauxAssistantMessage("CHILD-OUTPUT-SENTINEL");
			}

			const userTexts = getUserTexts(context);
			if (userTexts.some((text) => text.includes('"cohort_complete":true'))) {
				synthesis.resolve();
				return fauxAssistantMessage("automatic final synthesis");
			}
			if (userTexts.some((text) => text.includes('"completed_attempts"'))) {
				return fauxAssistantMessage("brief completion report");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "finish work" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("worker accepted");
		};
		harness.setResponses(Array.from({ length: 8 }, () => response));

		await root.prompt("delegate and synthesize");
		expect(root.getLastAssistantText()).toBe("worker accepted");

		childResult.resolve();
		await synthesis.promise;
		await root.waitForIdle();

		expect(root.getLastAssistantText()).toBe("automatic final synthesis");
		expect(
			root.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).toEqual(["spawn_agent"]);
		const notifications = getNotifications(root);
		expect(notifications).toHaveLength(2);
		expect(notifications.filter((entry) => JSON.stringify(entry).includes("CHILD-OUTPUT-SENTINEL"))).toHaveLength(1);
		const finalNotification = notifications.at(-1);
		expect(finalNotification).toMatchObject({ display: false });
		expect(JSON.parse(typeof finalNotification?.content === "string" ? finalNotification.content : "")).toEqual({
			cohort_complete: true,
			manifest: {
				cohort_id: expect.any(String),
				agents: [
					{
						name: "worker",
						status: "idle",
						attempt: 1,
						result_id: expect.any(String),
					},
				],
				unresolved: [],
			},
		});
		expect(root.systemPrompt).toContain("Hidden subagent_progress messages contain only newly completed attempts");
		const spawn = root.getToolDefinition("spawn_agent");
		expect(spawn).toBeDefined();
		expect(Check(spawn!.parameters, { name: "strict", task: "strict task" })).toBe(true);
		expect(Check(spawn!.parameters, { name: "strict", task: "strict task", extra: true })).toBe(false);

		root.agent.state.messages = root.agent.state.messages.filter(
			(message) => message.role !== "custom" || message.customType !== "subagent_progress",
		);
		const fallback = await root
			.getToolDefinition("agents")
			?.execute(
				"retrieve-missing",
				{ timeout_ms: 0, targets: ["worker"] },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
		expect(fallback).toMatchObject({
			details: { agents: [{ name: "worker", status: "idle", result: "CHILD-OUTPUT-SENTINEL" }] },
		});
	});

	it("steers progress into an active parent run", async () => {
		const { root, harness } = await createRoot();
		const sendCustomMessage = vi.spyOn(root, "sendCustomMessage");
		const childResult = deferred<void>();
		const parentBlocked = deferred<void>();
		const releaseParent = deferred<void>();
		const synthesized = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				await childResult.promise;
				return fauxAssistantMessage("ACTIVE-CHILD-SENTINEL");
			}

			const userTexts = getUserTexts(context);
			if (userTexts.some((text) => text.includes('"cohort_complete":true'))) {
				synthesized.resolve();
				return fauxAssistantMessage("active final synthesis");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "active", task: "active task" }), {
					stopReason: "toolUse",
				});
			}
			parentBlocked.resolve();
			await releaseParent.promise;
			return fauxAssistantMessage("parent turn released");
		};
		harness.setResponses(Array.from({ length: 8 }, () => response));

		const prompt = root.prompt("keep working while the child runs");
		await parentBlocked.promise;
		childResult.resolve();
		await waitFor(() => sendCustomMessage.mock.calls.length >= 2);
		expect(sendCustomMessage.mock.calls.every((call) => call[1]?.deliverAs === "steer")).toBe(true);
		expect(root.agent.hasQueuedMessages()).toBe(true);
		releaseParent.resolve();
		await prompt;
		await synthesized.promise;

		expect(root.getLastAssistantText()).toBe("active final synthesis");
		expect(getNotifications(root)).toHaveLength(2);
		expect(root.pendingMessageCount).toBe(0);
	});

	it("batches simultaneous children and delivers every output once", async () => {
		const { root, harness } = await createRoot(2);
		const releaseChildren = deferred<void>();
		const synthesized = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				await releaseChildren.promise;
				return fauxAssistantMessage(`CHILD-BATCH-SENTINEL:${getLastUserText(context)}`);
			}

			const userTexts = getUserTexts(context);
			if (userTexts.some((text) => text.includes('"cohort_complete":true'))) {
				synthesized.resolve();
				return fauxAssistantMessage("batch synthesis");
			}
			if (userTexts.some((text) => text.includes('"completed_attempts"'))) {
				return fauxAssistantMessage("batch progress report");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(
					[
						fauxToolCall("spawn_agent", { name: "alpha", task: "alpha task" }),
						fauxToolCall("spawn_agent", { name: "beta", task: "beta task" }),
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("children accepted");
		};
		harness.setResponses(Array.from({ length: 12 }, () => response));

		await root.prompt("delegate a batch");
		releaseChildren.resolve();
		await synthesized.promise;
		await root.waitForIdle();

		const notifications = getNotifications(root);
		expect(notifications).toHaveLength(2);
		const progress = parseNotification(notifications[0]!.content);
		if (progress.cohort_complete) throw new Error("Expected result progress before completion");
		expect(progress.completed_attempts).toHaveLength(2);
		expect(progress.completed_attempts.map((attempt) => attempt.name).sort()).toEqual(["alpha", "beta"]);
		for (const sentinel of ["CHILD-BATCH-SENTINEL:alpha task", "CHILD-BATCH-SENTINEL:beta task"]) {
			expect(notifications.filter((entry) => JSON.stringify(entry).includes(sentinel))).toHaveLength(1);
		}
		const final = parseNotification(notifications[1]!.content);
		expect(final).toMatchObject({
			cohort_complete: true,
			manifest: { agents: [{ name: "alpha" }, { name: "beta" }], unresolved: [] },
		});
	});

	it("reports one failed attempt and finalizes a successful recovery", async () => {
		const { root, harness } = await createRoot();
		const releaseFailure = deferred<void>();
		const retryStarted = deferred<void>();
		const releaseRetry = deferred<void>();
		const synthesized = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				const task = getLastUserText(context);
				if (task === "initial failure") {
					await releaseFailure.promise;
					return fauxAssistantMessage("FAILURE-PARTIAL-SENTINEL", {
						stopReason: "error",
						errorMessage: "recoverable child error",
					});
				}
				retryStarted.resolve();
				await releaseRetry.promise;
				return fauxAssistantMessage("RECOVERY-SUCCESS-SENTINEL");
			}

			const userTexts = getUserTexts(context);
			if (userTexts.some((text) => text.includes('"cohort_complete":true'))) {
				synthesized.resolve();
				return fauxAssistantMessage("recovery synthesis");
			}
			const latestProgress = findLastMatching(userTexts, (text) => text.includes('"completed_attempts"'));
			if (
				latestProgress?.includes("FAILURE-PARTIAL-SENTINEL") &&
				!getToolResultNames(context).includes("agent_action")
			) {
				return fauxAssistantMessage(
					fauxToolCall("agent_action", {
						target: "worker",
						action: "message",
						message: "correct the recoverable child error",
						wake: true,
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (latestProgress?.includes("RECOVERY-SUCCESS-SENTINEL")) {
				return fauxAssistantMessage("recovery completion report");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "initial failure" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("recovery requested");
		};
		harness.setResponses(Array.from({ length: 16 }, () => response));

		await root.prompt("recover a failed child");
		releaseFailure.resolve();
		await retryStarted.promise;
		releaseRetry.resolve();
		await synthesized.promise;
		await root.waitForIdle();

		const notifications = getNotifications(root);
		expect(notifications).toHaveLength(3);
		for (const sentinel of ["FAILURE-PARTIAL-SENTINEL", "RECOVERY-SUCCESS-SENTINEL"]) {
			expect(notifications.filter((entry) => JSON.stringify(entry).includes(sentinel))).toHaveLength(1);
		}
		const failure = parseNotification(notifications[0]!.content);
		const success = parseNotification(notifications[1]!.content);
		const final = parseNotification(notifications[2]!.content);
		if (failure.cohort_complete || success.cohort_complete || !final.cohort_complete) {
			throw new Error("Unexpected recovery notification order");
		}
		expect(failure.completed_attempts[0]).toMatchObject({
			status: "failed",
			attempt: 1,
			result: "FAILURE-PARTIAL-SENTINEL",
			error: "recoverable child error",
		});
		expect(failure.manifest.unresolved).toEqual(["worker"]);
		expect(success.completed_attempts[0]).toMatchObject({
			status: "idle",
			attempt: 2,
			result: "RECOVERY-SUCCESS-SENTINEL",
		});
		expect(success.completed_attempts[0]?.result_id).not.toBe(failure.completed_attempts[0]?.result_id);
		expect(final.manifest.agents).toEqual([
			{
				name: "worker",
				status: "idle",
				attempt: 2,
				result_id: success.completed_attempts[0]?.result_id,
			},
		]);
		expect(JSON.stringify(final)).not.toContain("FAILURE-PARTIAL-SENTINEL");
		expect(JSON.stringify(final)).not.toContain("RECOVERY-SUCCESS-SENTINEL");
	});

	it("marks a second failure exhausted and rejects another recovery", async () => {
		const { root, harness } = await createRoot();
		const releaseFailure = deferred<void>();
		const synthesized = deferred<void>();
		let childAttempt = 0;
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				childAttempt += 1;
				await releaseFailure.promise;
				return fauxAssistantMessage(`EXHAUSTED-PARTIAL-${childAttempt}`, {
					stopReason: "error",
					errorMessage: `failure ${childAttempt}`,
				});
			}

			const userTexts = getUserTexts(context);
			if (userTexts.some((text) => text.includes('"cohort_complete":true'))) {
				synthesized.resolve();
				return fauxAssistantMessage("exhausted synthesis");
			}
			const latestProgress = findLastMatching(userTexts, (text) => text.includes('"completed_attempts"'));
			if (latestProgress?.includes('"attempt":1') && !getToolResultNames(context).includes("agent_action")) {
				return fauxAssistantMessage(
					fauxToolCall("agent_action", {
						target: "worker",
						action: "message",
						message: "try one correction",
						wake: true,
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "fail twice" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("failure progress reported");
		};
		harness.setResponses(Array.from({ length: 16 }, () => response));

		await root.prompt("exhaust a child recovery");
		releaseFailure.resolve();
		await synthesized.promise;
		await root.waitForIdle();

		const notifications = getNotifications(root);
		expect(notifications).toHaveLength(3);
		const secondFailure = parseNotification(notifications[1]!.content);
		const final = parseNotification(notifications[2]!.content);
		if (secondFailure.cohort_complete || !final.cohort_complete) throw new Error("Expected exhausted completion");
		expect(secondFailure.completed_attempts[0]).toMatchObject({ status: "failed", attempt: 2, exhausted: true });
		expect(final.manifest).toMatchObject({
			agents: [{ name: "worker", status: "failed", attempt: 2, exhausted: true }],
			unresolved: [],
		});
		await expect(
			root
				.getToolDefinition("agent_action")
				?.execute(
					"third-attempt",
					{ target: "worker", action: "message", message: "try again", wake: true },
					undefined,
					undefined,
					{} as ExtensionContext,
				),
		).rejects.toThrow("Subagent recovery is exhausted: worker");
	});

	it("treats explicit interruption as terminal without recovery", async () => {
		const { root, harness } = await createRoot();
		const childStarted = deferred<void>();
		const synthesized = deferred<void>();
		const response = async (context: Context, options?: SimpleStreamOptions) => {
			if (!hasTool(context, "spawn_agent")) {
				childStarted.resolve();
				return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("INTERRUPTED-PARTIAL-SENTINEL", { stopReason: "aborted" })),
						{ once: true },
					);
				});
			}

			const lastUserText = getLastUserText(context);
			if (lastUserText.includes('"cohort_complete":true')) {
				synthesized.resolve();
				return fauxAssistantMessage("interruption synthesis");
			}
			if (lastUserText.includes('"completed_attempts"')) {
				return fauxAssistantMessage("interruption reported");
			}
			const toolResults = getToolResultNames(context);
			if (!toolResults.includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "wait forever" }), {
					stopReason: "toolUse",
				});
			}
			if (!toolResults.includes("agent_action")) {
				await childStarted.promise;
				return fauxAssistantMessage(fauxToolCall("agent_action", { target: "worker", action: "interrupt" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("child interrupted");
		};
		harness.setResponses(Array.from({ length: 12 }, () => response));

		await root.prompt("interrupt the child explicitly");
		await synthesized.promise;
		await root.waitForIdle();

		const notifications = getNotifications(root);
		expect(notifications).toHaveLength(2);
		const progress = parseNotification(notifications[0]!.content);
		const final = parseNotification(notifications[1]!.content);
		if (progress.cohort_complete || !final.cohort_complete) throw new Error("Expected terminal interruption");
		expect(progress.completed_attempts).toEqual([
			expect.objectContaining({ name: "worker", status: "interrupted", attempt: 1 }),
		]);
		expect(progress.manifest.unresolved).toEqual([]);
		expect(final.manifest.agents).toEqual([
			expect.objectContaining({ name: "worker", status: "interrupted", attempt: 1 }),
		]);
		expect(
			root.messages.filter((message) => message.role === "toolResult" && message.toolName === "agent_action"),
		).toHaveLength(1);
	});

	it("isolates manifests for consecutive user request cohorts", async () => {
		const { root, harness } = await createRoot();
		const releases = new Map([
			["alpha task", deferred<void>()],
			["beta task", deferred<void>()],
		]);
		const syntheses = new Map([
			["alpha", deferred<void>()],
			["beta", deferred<void>()],
		]);
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				const task = getLastUserText(context);
				await releases.get(task)?.promise;
				return fauxAssistantMessage(`COHORT-OUTPUT-SENTINEL:${task}`);
			}

			const lastUserText = getLastUserText(context);
			if (lastUserText.includes('"cohort_complete":true')) {
				const payload = JSON.parse(lastUserText) as ProgressPayload;
				const name = payload.manifest.agents[0]?.name;
				if (name) syntheses.get(name)?.resolve();
				return fauxAssistantMessage(`synthesized ${name}`);
			}
			if (lastUserText.includes('"completed_attempts"')) {
				return fauxAssistantMessage("cohort progress");
			}

			const requestIndex = findLastMatchingIndex(
				context.messages,
				(message) =>
					message.role === "user" && ["first request", "second request"].includes(getMessageText(message)),
			);
			const request = requestIndex < 0 ? "" : getMessageText(context.messages[requestIndex]);
			const hasSpawnResult = context.messages
				.slice(requestIndex + 1)
				.some((message) => message.role === "toolResult" && message.toolName === "spawn_agent");
			if (!hasSpawnResult) {
				const name = request === "first request" ? "alpha" : "beta";
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name, task: `${name} task` }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("cohort accepted");
		};
		harness.setResponses(Array.from({ length: 20 }, () => response));

		await root.prompt("first request");
		releases.get("alpha task")?.resolve();
		await syntheses.get("alpha")?.promise;
		await root.waitForIdle();
		await root.prompt("second request");
		releases.get("beta task")?.resolve();
		await syntheses.get("beta")?.promise;
		await root.waitForIdle();

		const finals = getNotifications(root)
			.map((entry) => parseNotification(entry.content))
			.filter((payload): payload is Extract<ProgressPayload, { cohort_complete: true }> => payload.cohort_complete);
		expect(finals).toHaveLength(2);
		expect(finals[0]?.manifest.cohort_id).not.toBe(finals[1]?.manifest.cohort_id);
		expect(finals[0]?.manifest.agents.map((agent) => agent.name)).toEqual(["alpha"]);
		expect(finals[1]?.manifest.agents.map((agent) => agent.name)).toEqual(["beta"]);
	});

	it("cancels undispatched notifications on reset", async () => {
		const { root, harness } = await createRoot();
		const childResult = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				await childResult.promise;
				return fauxAssistantMessage("RESET-OUTPUT-SENTINEL");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "resetter", task: "reset task" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("resetter accepted");
		};
		harness.setResponses(Array.from({ length: 6 }, () => response));
		await root.prompt("reset before dispatch");

		vi.useFakeTimers();
		childResult.resolve();
		while (root.getSubagents()[0]?.status !== "idle") await Promise.resolve();
		await root.reload();
		await vi.runAllTimersAsync();

		expect(root.getSubagents()).toEqual([]);
		expect(getNotifications(root)).toEqual([]);
	});

	it("cancels undispatched notifications on disposal", async () => {
		const { root, harness } = await createRoot();
		const childResult = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				await childResult.promise;
				return fauxAssistantMessage("DISPOSE-OUTPUT-SENTINEL");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "disposer", task: "dispose task" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("disposer accepted");
		};
		harness.setResponses(Array.from({ length: 6 }, () => response));
		await root.prompt("dispose before dispatch");

		vi.useFakeTimers();
		childResult.resolve();
		while (root.getSubagents()[0]?.status !== "idle") await Promise.resolve();
		await root.dispose();
		await vi.runAllTimersAsync();

		expect(getNotifications(root)).toEqual([]);
	});

	it("stops an in-flight progress dispatch during disposal", async () => {
		const { root, harness } = await createRoot();
		const childResult = deferred<void>();
		const progressStarted = deferred<void>();
		const response = async (context: Context, options?: SimpleStreamOptions) => {
			if (!hasTool(context, "spawn_agent")) {
				await childResult.promise;
				return fauxAssistantMessage("IN-FLIGHT-DISPOSE-SENTINEL");
			}
			const lastUserText = getLastUserText(context);
			if (lastUserText.includes('"completed_attempts"')) {
				progressStarted.resolve();
				return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("progress aborted", { stopReason: "aborted" })),
						{ once: true },
					);
				});
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "dispose in flight" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("worker accepted");
		};
		harness.setResponses(Array.from({ length: 8 }, () => response));
		await root.prompt("dispose during progress");

		childResult.resolve();
		await progressStarted.promise;
		await root.dispose();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const notifications = getNotifications(root);
		expect(notifications).toHaveLength(1);
		expect(parseNotification(notifications[0]!.content)).toMatchObject({ cohort_complete: false });
	});
});
