import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import type { SubagentLifecycleEvent } from "../../src/core/subagents/types.ts";
import { createSubagentTestHarness, type SubagentTestHarness } from "./subagent-harness.ts";

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

		const idle = subject.spawn("idle", "private idle task", createSession);
		await idle.run;
		const failed = subject.spawn("failed", "private failed task", createSession);
		await failed.run;
		const interrupted = subject.spawn("interrupted", "private interrupted task", createSession);
		await interrupted.run;

		const result = await subject.queryAgents({ timeoutMs: 0 });
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

	it("rejects controller shutdown during an active wait", async () => {
		const subject = controller();
		subject.reserve("worker", "task");
		const waiting = subject.queryAgents({ timeoutMs: 100, until: "all" });

		await subject.shutdown();
		await expect(waiting).rejects.toThrow("Subagent controller is shut down");
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
});
