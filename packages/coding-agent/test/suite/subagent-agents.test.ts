import { fauxAssistantMessage } from "@diffexai/diffex-ai";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import type {
	SubagentLifecycleEvent,
	SubagentQueryOptions,
	SubagentQueryResult,
} from "../../src/core/subagents/types.ts";
import { type AgentsRequest, createAgentsTool } from "../../src/core/tools/subagents.ts";
import { createSubagentTestHarness, deferred, type SubagentTestHarness, waitForStatus } from "./subagent-harness.ts";

type AgentsTool = ReturnType<typeof createAgentsTool>;

function executeAgents(tool: AgentsTool, request: AgentsRequest, signal?: AbortSignal) {
	return tool.execute("agents-call", request, signal, undefined, {} as ExtensionContext);
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
	const pending = Symbol("pending");
	return (await Promise.race([promise.then(() => false), Promise.resolve(pending)])) === pending;
}

describe("subagent queries", () => {
	const controllers: SubagentController[] = [];
	const fixtures: SubagentTestHarness[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
		for (const controller of controllers.splice(0)) await controller.shutdown();
	});

	function controller(): SubagentController {
		const created = new SubagentController({ maxConcurrent: 2 });
		controllers.push(created);
		return created;
	}

	async function setup(): Promise<SubagentTestHarness> {
		const fixture = await createSubagentTestHarness(2);
		fixtures.push(fixture);
		return fixture;
	}

	it("returns immediate empty and name-sorted snapshots", async () => {
		const subject = controller();
		await expect(subject.queryAgents({ timeoutMs: 0 })).resolves.toEqual({ timedOut: false, agents: [] });
		await expect(subject.queryAgents({ timeoutMs: 100, until: "all" })).resolves.toEqual({
			timedOut: false,
			agents: [],
		});

		subject.reserve("zeta", "private zeta task");
		subject.reserve("alpha", "private alpha task");
		await expect(subject.queryAgents({ timeoutMs: 0 })).resolves.toEqual({
			timedOut: false,
			agents: [
				{ name: "alpha", status: "queued" },
				{ name: "zeta", status: "queued" },
			],
		});
	});

	it("projects terminal results and preserves partial failure output", async () => {
		const { harness, controller: subject, createSession } = await setup();
		harness.setResponses([
			fauxAssistantMessage("idle result"),
			fauxAssistantMessage("partial result", { stopReason: "error", errorMessage: "provider failed" }),
			fauxAssistantMessage("interrupted result", { stopReason: "aborted" }),
		]);

		subject.spawn("idle", "private idle task", createSession);
		await subject.queryAgents({ timeoutMs: 1_000, targets: ["idle"], until: "all" });
		subject.spawn("failed", "private failed task", createSession);
		await subject.queryAgents({ timeoutMs: 1_000, targets: ["failed"], until: "all" });
		subject.spawn("interrupted", "private interrupted task", createSession);
		await subject.queryAgents({ timeoutMs: 1_000, targets: ["interrupted"], until: "all" });

		const result = await subject.queryAgents({ timeoutMs: 100, until: "all" });
		expect(result).toEqual({
			timedOut: false,
			agents: [
				{ name: "failed", status: "failed", result: "partial result", error: "provider failed" },
				{ name: "idle", status: "idle", result: "idle result" },
				{ name: "interrupted", status: "interrupted", result: "interrupted result" },
			],
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.agents)).toBe(true);
		expect(result.agents.every(Object.isFrozen)).toBe(true);
	});

	it("validates query options and explicit targets", async () => {
		const subject = controller();
		subject.reserve("worker", "task");

		for (const timeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(subject.queryAgents({ timeoutMs })).rejects.toThrow("timeoutMs must be a non-negative integer");
		}
		await expect(subject.queryAgents({ timeoutMs: 0, targets: [] })).rejects.toThrow(
			"Subagent query targets must be a non-empty array",
		);
		await expect(subject.queryAgents({ timeoutMs: 0, targets: ["worker", "worker"] })).rejects.toThrow(
			"Duplicate subagent target: worker",
		);
		await expect(subject.queryAgents({ timeoutMs: 0, targets: ["Invalid"] })).rejects.toThrow(
			"Invalid subagent name: Invalid",
		);
		await expect(subject.queryAgents({ timeoutMs: 0, targets: ["missing"] })).rejects.toThrow(
			"Unknown subagent: missing",
		);
		await expect(subject.queryAgents({ timeoutMs: 0, until: "later" as "any" })).rejects.toThrow(
			"Invalid subagent query condition: later",
		);
	});

	it("filters targets and freezes implicit selection", async () => {
		const subject = controller();
		subject.reserve("alpha", "task");
		subject.markRunning("alpha");
		const waiting = subject.queryAgents({ timeoutMs: 100, until: "all" });

		subject.reserve("later", "task");
		subject.markRunning("later");
		subject.markIdle("alpha", "alpha result");

		await expect(waiting).resolves.toEqual({
			timedOut: false,
			agents: [{ name: "alpha", status: "idle", result: "alpha result" }],
		});
		await expect(subject.queryAgents({ timeoutMs: 0, targets: ["later"] })).resolves.toEqual({
			timedOut: false,
			agents: [{ name: "later", status: "running" }],
		});
	});

	it("returns on the next revision when no condition is supplied", async () => {
		const subject = controller();
		subject.reserve("selected", "task");
		subject.markRunning("selected");
		const waiting = subject.queryAgents({ timeoutMs: 100, targets: ["selected"] });

		subject.reserve("unrelated", "task");
		await expect(waiting).resolves.toEqual({
			timedOut: false,
			agents: [{ name: "selected", status: "running" }],
		});
	});

	it("times out while waiting for the next revision", async () => {
		vi.useFakeTimers();
		const subject = controller();
		subject.reserve("worker", "task");
		const waiting = subject.queryAgents({ timeoutMs: 25, targets: ["worker"] });
		await Promise.resolve();

		await vi.advanceTimersByTimeAsync(25);
		await expect(waiting).resolves.toEqual({
			timedOut: true,
			agents: [{ name: "worker", status: "queued" }],
		});
	});

	it("waits for any selected agent to become terminal", async () => {
		const subject = controller();
		subject.reserve("queued", "task");
		subject.reserve("running", "task");
		subject.markRunning("running");
		const waiting = subject.queryAgents({ timeoutMs: 100, until: "any" });

		subject.reserve("unrelated", "task");
		expect(await isPending(waiting)).toBe(true);
		subject.markFailed("queued", "queued failure", "partial");

		await expect(waiting).resolves.toEqual({
			timedOut: false,
			agents: [
				{ name: "queued", status: "failed", result: "partial", error: "queued failure" },
				{ name: "running", status: "running" },
			],
		});
	});

	it("waits for all selected agents to become terminal", async () => {
		const subject = controller();
		subject.reserve("first", "task");
		subject.markRunning("first");
		subject.reserve("second", "task");
		subject.markRunning("second");
		const waiting = subject.queryAgents({ timeoutMs: 100, until: "all" });

		subject.markIdle("first", "done");
		expect(await isPending(waiting)).toBe(true);
		subject.markInterrupted("second", "stopped");

		await expect(waiting).resolves.toEqual({
			timedOut: false,
			agents: [
				{ name: "first", status: "idle", result: "done" },
				{ name: "second", status: "interrupted", result: "stopped" },
			],
		});
	});

	it("uses one deadline and returns the latest selected timeout snapshot", async () => {
		vi.useFakeTimers();
		const subject = controller();
		subject.reserve("first", "task");
		subject.markRunning("first");
		subject.reserve("second", "task");
		subject.markRunning("second");
		const waiting = subject.queryAgents({ timeoutMs: 100, targets: ["first", "second"], until: "all" });
		await Promise.resolve();

		await vi.advanceTimersByTimeAsync(40);
		subject.reserve("noise", "task");
		await vi.advanceTimersByTimeAsync(10);
		subject.markIdle("first", "latest result");
		await vi.advanceTimersByTimeAsync(49);
		expect(await isPending(waiting)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);

		await expect(waiting).resolves.toEqual({
			timedOut: true,
			agents: [
				{ name: "first", status: "idle", result: "latest result" },
				{ name: "second", status: "running" },
			],
		});
	});

	it("rejects cancellation and cleans up the active waiter", async () => {
		vi.useFakeTimers();
		const subject = controller();
		subject.reserve("worker", "task");
		const abortController = new AbortController();
		const removeEventListener = vi.spyOn(abortController.signal, "removeEventListener");
		const reason = new Error("caller canceled");
		const waiting = subject.queryAgents({
			timeoutMs: 100,
			targets: ["worker"],
			until: "all",
			signal: abortController.signal,
		});
		await Promise.resolve();

		abortController.abort(reason);
		await expect(waiting).rejects.toBe(reason);
		expect(removeEventListener).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects cancellation that races a completed revision wait", async () => {
		const subject = controller();
		subject.reserve("worker", "task");
		subject.markRunning("worker");
		const abortController = new AbortController();
		const reason = new Error("canceled after revision");
		subject.subscribe((event) => {
			if (event.type === "subagent_status_changed" && event.status === "idle") {
				abortController.abort(reason);
			}
		});
		const waiting = subject.queryAgents({ timeoutMs: 100, until: "all", signal: abortController.signal });

		subject.markIdle("worker", "completed result");
		await expect(waiting).rejects.toBe(reason);
	});

	it("rejects controller shutdown during an active wait", async () => {
		const subject = controller();
		subject.reserve("worker", "task");
		const abortController = new AbortController();
		const removeEventListener = vi.spyOn(abortController.signal, "removeEventListener");
		const waiting = subject.queryAgents({ timeoutMs: 100, until: "all", signal: abortController.signal });

		await subject.shutdown();
		await expect(waiting).rejects.toThrow("Subagent controller is shut down");
		expect(removeEventListener).toHaveBeenCalled();
	});

	it("does not lose completion during waiter registration", async () => {
		const subject = controller();
		subject.reserve("worker", "task");
		subject.markRunning("worker");
		const abortController = new AbortController();
		const addEventListener = abortController.signal.addEventListener.bind(abortController.signal);
		vi.spyOn(abortController.signal, "addEventListener").mockImplementationOnce((...args) => {
			subject.markIdle("worker", "racing result");
			return addEventListener(...args);
		});

		await expect(
			subject.queryAgents({ timeoutMs: 100, until: "all", signal: abortController.signal }),
		).resolves.toEqual({
			timedOut: false,
			agents: [{ name: "worker", status: "idle", result: "racing result" }],
		});
	});

	it("only consumes the coordinated attempt returned by a racing agents query", async () => {
		const { harness, controller: subject, createSession } = await setup();
		const releaseRetry = deferred<void>();
		harness.setResponses([
			fauxAssistantMessage("initial partial", {
				stopReason: "error",
				errorMessage: "initial failure",
			}),
			async () => {
				await releaseRetry.promise;
				return fauxAssistantMessage("retry result");
			},
		]);
		subject.beginCoordinationCycle();
		subject.spawn("worker", "fail once", createSession, {
			type: "agent_tool_call",
			toolCallId: "spawn-worker",
			assistantEntryId: "assistant-entry",
			contextEntryId: null,
		});
		await waitForStatus(subject, "worker", "failed");

		const agentsTool = subject.createToolDefinitions().find((tool) => tool.name === "agents") as
			| AgentsTool
			| undefined;
		if (!agentsTool) throw new Error("agents tool is unavailable");

		const retry = subject.message("worker", "correct the failure", true, true);
		const explicitQuery = executeAgents(agentsTool, { timeout_ms: 0 });
		const [, explicitResult] = await Promise.all([retry, explicitQuery]);
		expect(explicitResult.details).toEqual({
			timed_out: false,
			agents: [{ name: "worker", status: "failed", result: "initial partial", error: "initial failure" }],
		});

		releaseRetry.resolve();
		await waitForStatus(subject, "worker", "idle");
		const retryBatch = subject.freezeUnconsumedBatch();
		if (!retryBatch) throw new Error("retry batch was consumed by the stale query");
		expect(retryBatch).toMatchObject({ attempts: [{ name: "worker" }] });
		expect(subject.consumeBatch(retryBatch)).toEqual([
			{
				name: "worker",
				status: "idle",
				attempt: "retry",
				retryAvailable: false,
				result: "retry result",
			},
		]);
	});

	it("keeps lifecycle snapshots and events free of results and errors", async () => {
		const subject = controller();
		const events: SubagentLifecycleEvent[] = [];
		subject.subscribe((event) => events.push(event));
		subject.reserve("worker", "private task");
		subject.markFailed("worker", "private error", "private result");

		const serializedLifecycle = JSON.stringify({ events, snapshot: subject.snapshot() });
		for (const secret of ["private task", "private error", "private result"]) {
			expect(serializedLifecycle).not.toContain(secret);
		}
		for (const key of ["task", "result", "finalText", "error"]) {
			expect(serializedLifecycle).not.toContain(`"${key}"`);
		}
	});

	it("defines a strict agents tool schema", () => {
		const tool = createAgentsTool(() => Promise.resolve({ timedOut: false, agents: [] }));

		expect(tool.executionMode).toBe("parallel");
		expect(Check(tool.parameters, { timeout_ms: 0 })).toBe(true);
		expect(Check(tool.parameters, { timeout_ms: 100, targets: ["first", "second"], until: "all" })).toBe(true);
		for (const request of [
			{},
			{ timeout_ms: -1 },
			{ timeout_ms: 1.5 },
			{ timeout_ms: 0, targets: [] },
			{ timeout_ms: 0, targets: ["worker", "worker"] },
			{ timeout_ms: 0, targets: [""] },
			{ timeout_ms: 0, targets: ["Invalid"] },
			{ timeout_ms: 0, until: "later" },
			{ timeout_ms: 0, extra: true },
		]) {
			expect(Check(tool.parameters, request)).toBe(false);
		}
	});

	it("defensively validates agents tool requests", async () => {
		const tool = createAgentsTool(() => Promise.resolve({ timedOut: false, agents: [] }));

		await expect(executeAgents(tool, {} as AgentsRequest)).rejects.toThrow(
			"timeout_ms must be a non-negative integer",
		);
		await expect(executeAgents(tool, { timeout_ms: -1 })).rejects.toThrow(
			"timeout_ms must be a non-negative integer",
		);
		await expect(executeAgents(tool, { timeout_ms: 0, targets: [] })).rejects.toThrow(
			"targets must be a non-empty array",
		);
		await expect(
			executeAgents(tool, { timeout_ms: 0, targets: "worker" } as unknown as AgentsRequest),
		).rejects.toThrow("targets must be a non-empty array");
		await expect(executeAgents(tool, { timeout_ms: 0, targets: ["worker", "worker"] })).rejects.toThrow(
			"Duplicate subagent target: worker",
		);
		await expect(executeAgents(tool, { timeout_ms: 0, targets: ["Invalid"] })).rejects.toThrow(
			"Invalid subagent name: Invalid",
		);
		await expect(executeAgents(tool, { timeout_ms: 0, until: "later" as "all" })).rejects.toThrow(
			"Invalid agents wait condition: later",
		);
		await expect(executeAgents(tool, { timeout_ms: 0, extra: true } as AgentsRequest)).rejects.toThrow(
			"Unknown agents request field: extra",
		);
	});

	it("maps snake-case requests and serializes identical result details", async () => {
		const abortController = new AbortController();
		const queryResult: SubagentQueryResult = {
			timedOut: true,
			agents: [{ name: "worker", status: "failed", result: "partial", error: "failed" }],
		};
		const query = vi.fn((_options: SubagentQueryOptions) => Promise.resolve(queryResult));
		const tool = createAgentsTool(query);

		const result = await executeAgents(
			tool,
			{ timeout_ms: 250, targets: ["worker"], until: "any" },
			abortController.signal,
		);

		expect(query).toHaveBeenCalledWith({
			timeoutMs: 250,
			targets: ["worker"],
			until: "any",
			signal: abortController.signal,
		});
		expect(result.details).toEqual({
			timed_out: true,
			agents: [{ name: "worker", status: "failed", result: "partial", error: "failed" }],
		});
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
	});

	it("surfaces controller target errors through the agents tool", async () => {
		const subject = controller();
		const tool = createAgentsTool((options) => subject.queryAgents(options));

		await expect(executeAgents(tool, { timeout_ms: 0, targets: ["missing"] })).rejects.toThrow(
			"Unknown subagent: missing",
		);
	});
});
