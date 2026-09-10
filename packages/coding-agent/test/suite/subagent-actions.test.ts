import type { AgentTool } from "@diffexai/diffex-agent-core";
import type { AssistantMessage, Context } from "@diffexai/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import { createSubagentSession } from "../../src/core/subagents/services.ts";
import type { SubagentActionResult } from "../../src/core/subagents/types.ts";
import { type AgentActionRequest, createAgentActionTool } from "../../src/core/tools/subagents.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";
import {
	createSubagentTestHarness,
	deferred,
	getLastUserText,
	type SubagentTestHarness,
	waitForStatus,
} from "./subagent-harness.ts";

type AgentActionTool = ReturnType<typeof createAgentActionTool>;

function executeAction(tool: AgentActionTool, request: AgentActionRequest) {
	return tool.execute("action-call", request, undefined, undefined, {} as ExtensionContext);
}

function spawnTracked(
	controller: SubagentController,
	name: string,
	task: string,
	createSession: (signal: AbortSignal) => Promise<AgentSession>,
): { readonly session: AgentSession | undefined } {
	let capturedSession: AgentSession | undefined;
	controller.spawn(name, task, async (signal) => {
		const session = await createSession(signal);
		capturedSession = session;
		return session;
	});
	return {
		get session() {
			return capturedSession;
		},
	};
}

describe("subagent actions", () => {
	const fixtures: SubagentTestHarness[] = [];
	const extraControllers: SubagentController[] = [];
	const extraHarnesses: Harness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
		for (const controller of extraControllers.splice(0)) await controller.shutdown();
		for (const harness of extraHarnesses.splice(0)) await harness.cleanup();
	});

	async function setup(maxConcurrent = 1): Promise<SubagentTestHarness> {
		const fixture = await createSubagentTestHarness(maxConcurrent);
		fixtures.push(fixture);
		return fixture;
	}

	it("defines strict actions, normalizes wake, and returns private stable details", async () => {
		const privateMessage = "private child instructions";
		const action = vi.fn(async (request: AgentActionRequest): Promise<SubagentActionResult> => {
			if (request.action === "interrupt") {
				return { target: request.target, action: "interrupt", status: "interrupted" };
			}
			return { target: request.target, action: "message", status: "idle", delivery: "follow_up" };
		});
		const tool = createAgentActionTool(action);

		expect(tool.executionMode).toBe("parallel");
		expect(tool.parameters).toMatchObject({
			type: "object",
			additionalProperties: false,
			properties: {
				target: { type: "string" },
				action: { type: "string", enum: ["message", "interrupt"] },
				message: { type: "string" },
				wake: { type: "boolean" },
			},
		});
		for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
			expect(tool.parameters).not.toHaveProperty(keyword);
		}
		expect(Check(tool.parameters, { target: "worker", action: "message", message: "hello" })).toBe(true);
		expect(Check(tool.parameters, { target: "worker", action: "message", message: "hello", wake: true })).toBe(true);
		expect(Check(tool.parameters, { target: "worker", action: "interrupt" })).toBe(true);
		expect(Check(tool.parameters, { target: "Invalid", action: "interrupt" })).toBe(false);
		expect(Check(tool.parameters, { target: "worker", action: "interrupt", wake: true })).toBe(true);
		expect(Check(tool.parameters, { target: "worker", action: "interrupt", message: "no" })).toBe(true);

		const result = await executeAction(tool, { target: "worker", action: "message", message: privateMessage });
		expect(action).toHaveBeenCalledWith({
			target: "worker",
			action: "message",
			message: privateMessage,
			wake: false,
		});
		expect(result.details).toEqual({
			target: "worker",
			action: "message",
			status: "idle",
			delivery: "follow_up",
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(privateMessage);
		for (const key of ["task", "output", "error", "usage"]) {
			expect(serialized).not.toContain(`"${key}"`);
		}

		await expect(executeAction(tool, { target: "Invalid", action: "interrupt" })).rejects.toThrow(
			"Invalid subagent name: Invalid",
		);
		await expect(executeAction(tool, { target: "worker", action: "message", message: "   " })).rejects.toThrow(
			"Subagent message must be non-empty",
		);
		await expect(executeAction(tool, { target: "worker", action: "message" } as AgentActionRequest)).rejects.toThrow(
			"Subagent message must be non-empty",
		);
		await expect(
			executeAction(tool, { target: "worker", action: "interrupt", wake: true } as AgentActionRequest),
		).rejects.toThrow("Interrupt actions do not accept message fields");
	});

	it("routes running messages and preserves same-target action order", async () => {
		const { harness, controller, createSession } = await setup();
		const firstResponse = deferred<AssistantMessage>();
		harness.setResponses([
			() => firstResponse.promise,
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("follow-up response"),
		]);
		const record = spawnTracked(controller, "worker", "initial task", createSession);
		await waitForStatus(controller, "worker", "running");
		const session = record.session!;
		const calls: string[] = [];
		const originalFollowUp = session.followUp.bind(session);
		const originalSteer = session.steer.bind(session);
		const followUp = vi.spyOn(session, "followUp").mockImplementation(async (message) => {
			calls.push(`follow:${message}`);
			return originalFollowUp(message);
		});
		const steer = vi.spyOn(session, "steer").mockImplementation(async (message) => {
			calls.push(`steer:${message}`);
			return originalSteer(message);
		});

		const followResult = controller.message("worker", "later message");
		const steerResult = controller.message("worker", "urgent message", true);
		await expect(followResult).resolves.toMatchObject({ delivery: "follow_up", status: "running" });
		await expect(steerResult).resolves.toMatchObject({ delivery: "steer", status: "running" });
		expect(calls).toEqual(["follow:later message", "steer:urgent message"]);
		expect(followUp).toHaveBeenCalledOnce();
		expect(steer).toHaveBeenCalledOnce();

		firstResponse.resolve(fauxAssistantMessage("initial response"));
		await waitForStatus(controller, "worker", "idle");
		expect(getUserTexts({ ...harness, session })).toEqual(["initial task", "urgent message", "later message"]);
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("idle");
	});

	it("keeps unrelated children parallel while serializing each child", async () => {
		const { harness, controller, createSession } = await setup(2);
		harness.setResponses([fauxAssistantMessage("first idle"), fauxAssistantMessage("second idle")]);
		const first = spawnTracked(controller, "first", "first task", createSession);
		const second = spawnTracked(controller, "second", "second task", createSession);
		await Promise.all([waitForStatus(controller, "first", "idle"), waitForStatus(controller, "second", "idle")]);
		const firstGate = deferred<void>();
		const firstStarted = deferred<void>();
		vi.spyOn(first.session!, "followUp").mockImplementation(async () => {
			firstStarted.resolve();
			await firstGate.promise;
		});
		const secondFollowUp = vi.spyOn(second.session!, "followUp").mockResolvedValue();

		const firstAction = controller.message("first", "blocked");
		await firstStarted.promise;
		const secondAction = controller.message("second", "independent");
		await expect(secondAction).resolves.toMatchObject({ target: "second", delivery: "follow_up" });
		expect(secondFollowUp).toHaveBeenCalledOnce();
		firstGate.resolve();
		await firstAction;
	});

	it("queues idle follow-up without revision and wakes through the same session first", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([
			fauxAssistantMessage("initial result"),
			fauxAssistantMessage("wake result"),
			fauxAssistantMessage("older follow-up result"),
		]);
		const record = spawnTracked(controller, "worker", "initial task", createSession);
		await waitForStatus(controller, "worker", "idle");
		const session = record.session;
		const revision = controller.snapshot().revision;

		await expect(controller.message("worker", "older follow-up")).resolves.toMatchObject({
			status: "idle",
			delivery: "follow_up",
		});
		expect(controller.snapshot().revision).toBe(revision);
		await expect(controller.message("worker", "wake prompt", true)).resolves.toMatchObject({
			status: "queued",
			delivery: "prompt",
		});
		await waitForStatus(controller, "worker", "idle");

		expect(record.session).toBe(session);
		expect(getUserTexts({ ...harness, session: session! })).toEqual([
			"initial task",
			"wake prompt",
			"older follow-up",
		]);
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("idle");
	});

	it("keeps the wake result when prompt preflight compacts child history", async () => {
		const fixture = await createSubagentTestHarness(1, {
			settings: {
				compaction: { keepRecentTokens: 1 },
				retry: { enabled: false },
			},
		});
		fixtures.push(fixture);
		const { harness, controller, createSession } = fixture;
		harness.setResponses([fauxAssistantMessage("initial response")]);
		const record = spawnTracked(controller, "worker", "initial task", createSession);
		await waitForStatus(controller, "worker", "idle");

		const session = record.session!;
		const model = session.model!;
		const now = Date.now();
		for (let index = 0; index < 20; index += 1) {
			session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `historical user ${index}` }],
				timestamp: now + index * 2,
			});
			session.sessionManager.appendMessage({
				...fauxAssistantMessage(`historical assistant ${index}`),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1_000_000,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_000_001,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: now + index * 2 + 1,
			});
		}
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		const messagesBeforeCompaction = session.messages.length;
		const compactions: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end" && !event.aborted && event.result) {
				compactions.push(event.reason);
			}
		});
		harness.setResponses([
			fauxAssistantMessage("compacted history"),
			fauxAssistantMessage("compacted turn prefix"),
			fauxAssistantMessage("wake succeeded"),
		]);

		await controller.message("worker", "wake after compaction", true);
		await waitForStatus(controller, "worker", "idle");

		expect(compactions).toEqual(["overflow"]);
		expect(session.messages.length).toBeLessThan(messagesBeforeCompaction);
		expect(session.getLastAssistantText()).toBe("wake succeeded");
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("idle");
	});

	it("clears queued messages when interrupting an idle child", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([fauxAssistantMessage("idle")]);
		const record = spawnTracked(controller, "worker", "initial", createSession);
		await waitForStatus(controller, "worker", "idle");
		await controller.message("worker", "pending follow-up");
		expect(record.session?.pendingMessageCount).toBe(1);

		await expect(controller.interrupt("worker")).resolves.toEqual({
			target: "worker",
			action: "interrupt",
			status: "idle",
		});
		expect(record.session?.pendingMessageCount).toBe(0);
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("idle");
	});

	it("restarts failed and interrupted children only when wake is requested", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([
			fauxAssistantMessage("failed text", { stopReason: "error", errorMessage: "provider failed" }),
			fauxAssistantMessage("failed restart result"),
			fauxAssistantMessage("interrupted text", { stopReason: "aborted" }),
			fauxAssistantMessage("interrupted restart result"),
		]);
		const failed = spawnTracked(controller, "failed", "fail", createSession);
		await waitForStatus(controller, "failed", "failed");
		await expect(controller.message("failed", "no wake")).rejects.toThrow(
			"Cannot message failed subagent without wake: failed",
		);
		const failedSession = failed.session;
		await controller.message("failed", "restart failed", true);
		await waitForStatus(controller, "failed", "idle");
		expect(failed.session).toBe(failedSession);
		expect(controller.snapshot().agents.find((agent) => agent.name === "failed")?.status).toBe("idle");

		const interrupted = spawnTracked(controller, "interrupted", "interrupt", createSession);
		await waitForStatus(controller, "interrupted", "interrupted");
		await expect(controller.message("interrupted", "no wake")).rejects.toThrow(
			"Cannot message interrupted subagent without wake: interrupted",
		);
		const interruptedSession = interrupted.session;
		await controller.message("interrupted", "restart interrupted", true);
		await waitForStatus(controller, "interrupted", "idle");
		expect(interrupted.session).toBe(interruptedSession);
		expect(controller.snapshot().agents.find((agent) => agent.name === "interrupted")?.status).toBe("idle");
	});

	it("retries failed construction with the retained session factory", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([fauxAssistantMessage("retry result")]);
		let attempts = 0;
		const factory = vi.fn(async (signal: AbortSignal) => {
			attempts += 1;
			if (attempts === 1) throw new Error("construction failed");
			return createSession(signal);
		});
		const record = spawnTracked(controller, "worker", "initial task", factory);
		await waitForStatus(controller, "worker", "failed");
		expect(record.session).toBeUndefined();

		await controller.message("worker", "retry prompt", true);
		await waitForStatus(controller, "worker", "idle");
		expect(factory).toHaveBeenCalledTimes(2);
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("idle");
	});

	it("admits wake restarts through the shared concurrency limit", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([fauxAssistantMessage("first idle"), fauxAssistantMessage("second idle")]);
		spawnTracked(controller, "first", "first task", createSession);
		await waitForStatus(controller, "first", "idle");
		spawnTracked(controller, "second", "second task", createSession);
		await waitForStatus(controller, "second", "idle");

		const firstGate = deferred<AssistantMessage>();
		const secondGate = deferred<AssistantMessage>();
		const firstStarted = deferred<void>();
		const secondStarted = deferred<void>();
		const starts: string[] = [];
		const response = (context: Context): Promise<AssistantMessage> => {
			const prompt = getLastUserText(context);
			starts.push(prompt);
			if (prompt === "wake first") {
				firstStarted.resolve();
				return firstGate.promise;
			}
			secondStarted.resolve();
			return secondGate.promise;
		};
		harness.setResponses([response, response]);

		await controller.message("first", "wake first", true);
		await waitForStatus(controller, "first", "running");
		await firstStarted.promise;
		await controller.message("second", "wake second", true);
		expect(controller.snapshot().agents.find((agent) => agent.name === "second")?.status).toBe("queued");
		expect(starts).toEqual(["wake first"]);

		firstGate.resolve(fauxAssistantMessage("first restarted"));
		await waitForStatus(controller, "first", "idle");
		await waitForStatus(controller, "second", "running");
		await secondStarted.promise;
		expect(starts).toEqual(["wake first", "wake second"]);
		secondGate.resolve(fauxAssistantMessage("second restarted"));
		await waitForStatus(controller, "second", "idle");
	});

	it("rejects queued messages and interrupts before child construction", async () => {
		const { harness, controller, createSession } = await setup();
		const blockerResponse = deferred<AssistantMessage>();
		harness.setResponses([() => blockerResponse.promise]);
		controller.spawn("blocker", "block", createSession);
		await waitForStatus(controller, "blocker", "running");
		const factory = vi.fn(createSession);
		controller.spawn("queued", "queued task", factory);

		await expect(controller.message("queued", "message")).rejects.toThrow("Cannot message queued subagent: queued");
		await expect(controller.interrupt("queued")).resolves.toEqual({
			target: "queued",
			action: "interrupt",
			status: "interrupted",
		});
		expect(factory).not.toHaveBeenCalled();
		expect(controller.snapshot().agents.find((agent) => agent.name === "queued")?.status).toBe("interrupted");

		blockerResponse.resolve(fauxAssistantMessage("unblocked"));
		await waitForStatus(controller, "blocker", "idle");
	});

	it("interrupts queued construction before attachment or prompting", async () => {
		const { controller, config } = await setup();
		const lateSession = await createSubagentSession(config);
		const construction = deferred<void>();
		const entered = deferred<void>();
		const prompt = vi.spyOn(lateSession, "prompt");
		const dispose = vi.spyOn(lateSession, "dispose");
		controller.spawn("worker", "task", async () => {
			entered.resolve();
			await construction.promise;
			return lateSession;
		});
		await entered.promise;

		const interrupt = controller.interrupt("worker");
		construction.resolve();
		await expect(interrupt).resolves.toMatchObject({ status: "interrupted" });
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("interrupted");
		expect(prompt).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("serializes concurrent wakes and message-interrupt ordering", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([fauxAssistantMessage("idle")]);
		const record = spawnTracked(controller, "worker", "initial", createSession);
		await waitForStatus(controller, "worker", "idle");
		const wakeResponse = deferred<AssistantMessage>();
		harness.setResponses([
			(_context, options) => {
				options?.signal?.addEventListener(
					"abort",
					() => wakeResponse.resolve(fauxAssistantMessage("interrupted", { stopReason: "aborted" })),
					{ once: true },
				);
				return wakeResponse.promise;
			},
		]);

		const firstWake = controller.message("worker", "first wake", true);
		const secondWake = controller.message("worker", "second wake", true);
		await expect(firstWake).resolves.toMatchObject({ status: "queued", delivery: "prompt" });
		await expect(secondWake).resolves.toMatchObject({ status: "running", delivery: "steer" });
		await waitForStatus(controller, "worker", "running");

		const message = controller.message("worker", "queued follow-up");
		const interrupt = controller.interrupt("worker");
		await expect(message).resolves.toMatchObject({ delivery: "follow_up" });
		await expect(interrupt).resolves.toMatchObject({ status: "interrupted" });
		expect(record.session?.pendingMessageCount).toBe(0);
		await expect(controller.interrupt("worker")).resolves.toMatchObject({ status: "interrupted" });
		wakeResponse.resolve(fauxAssistantMessage("late success"));
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("interrupted");
	});

	it("re-evaluates a running record after its session reaches idle", async () => {
		const { controller, config } = await setup();
		const session = await createSubagentSession(config);
		controller.reserve("worker", "task");
		controller.attachSession("worker", session);
		controller.markRunning("worker");
		const completion = deferred<void>();
		const run = completion.promise.then(() => controller.markIdle("worker", "done"));
		controller.trackRun("worker", run);
		const followUp = vi.spyOn(session, "followUp").mockResolvedValue();

		const action = controller.message("worker", "boundary message");
		expect(followUp).not.toHaveBeenCalled();
		completion.resolve();
		await expect(action).resolves.toMatchObject({ status: "idle", delivery: "follow_up" });
		expect(followUp).toHaveBeenCalledWith("boundary message");
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("idle");
	});

	it("interrupts a signal-aware provider and gives interruption precedence", async () => {
		const { harness, controller, createSession } = await setup();
		const providerStarted = deferred<void>();
		harness.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					providerStarted.resolve();
					options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("racing success")), {
						once: true,
					});
				}),
		]);
		controller.spawn("worker", "long request", createSession);
		await providerStarted.promise;

		await expect(controller.interrupt("worker")).resolves.toMatchObject({ status: "interrupted" });
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("interrupted");
	});

	it("interrupts signal-aware tools, persists abort results, and clears pending messages", async () => {
		const toolStarted = deferred<void>();
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Block until interrupted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise((resolve) => {
					toolStarted.resolve();
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						{ once: true },
					);
				}),
		};
		const child = await createHarness({
			tools: [blockingTool],
			initialActiveToolNames: ["block"],
			settings: { retry: { enabled: false } },
		});
		extraHarnesses.push(child);
		child.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const controller = new SubagentController({ maxConcurrent: 1 });
		extraControllers.push(controller);
		controller.spawn("worker", "run tool", async () => child.session);
		await toolStarted.promise;
		await controller.message("worker", "steer pending", true);
		await controller.message("worker", "follow pending");
		expect(child.session.pendingMessageCount).toBe(2);

		await controller.interrupt("worker");
		expect(controller.snapshot().agents.find((agent) => agent.name === "worker")?.status).toBe("interrupted");
		expect(child.session.pendingMessageCount).toBe(0);
		const toolResults = child.session.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(toolResults.map((message) => getMessageText(message))).toContain("tool aborted");
	});

	it("shuts down queued and running restarts without late revisions or double disposal", async () => {
		const { harness, controller, createSession } = await setup();
		harness.setResponses([fauxAssistantMessage("first idle"), fauxAssistantMessage("second idle")]);
		const first = spawnTracked(controller, "first", "first", createSession);
		await waitForStatus(controller, "first", "idle");
		const second = spawnTracked(controller, "second", "second", createSession);
		await waitForStatus(controller, "second", "idle");
		const runningResponse = deferred<AssistantMessage>();
		harness.setResponses([() => runningResponse.promise]);
		await controller.message("first", "restart first", true);
		await waitForStatus(controller, "first", "running");
		await controller.message("second", "restart second", true);
		expect(controller.snapshot().agents.find((agent) => agent.name === "second")?.status).toBe("queued");
		const firstDispose = vi.spyOn(first.session!, "dispose");
		const secondDispose = vi.spyOn(second.session!, "dispose");
		const revision = controller.snapshot().revision;

		const shutdown = controller.shutdown();
		runningResponse.resolve(fauxAssistantMessage("late response"));
		await shutdown;
		expect(controller.snapshot()).toEqual({ revision: revision + 1, agents: [] });
		expect(firstDispose).toHaveBeenCalledOnce();
		expect(secondDispose).toHaveBeenCalledOnce();
		await controller.shutdown();
		expect(firstDispose).toHaveBeenCalledOnce();
		expect(secondDispose).toHaveBeenCalledOnce();
	});
});
