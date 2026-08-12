import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentController } from "../src/core/subagents/controller.ts";
import type { SubagentLifecycleEvent } from "../src/core/subagents/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
	const pending = Symbol("pending");
	return (await Promise.race([promise.then(() => false), Promise.resolve(pending)])) === pending;
}

describe("SubagentController", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness();
		harnesses.push(created);
		return created;
	}

	it("requires a positive integer concurrency limit", () => {
		for (const maxConcurrent of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => new SubagentController({ maxConcurrent })).toThrow("maxConcurrent must be a positive integer");
		}
		expect(() => new SubagentController({ maxConcurrent: 1 })).not.toThrow();
	});

	it("validates names and reserves each name synchronously", () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		for (const name of ["", "A", "1agent", "agent.name", "agent/name", `a${"b".repeat(64)}`]) {
			expect(() => controller.reserve(name, "task")).toThrow(`Invalid subagent name: ${name}`);
		}

		const record = controller.reserve("agent_1", "first task");
		expect(record).toMatchObject({ name: "agent_1", task: "first task", status: "queued" });
		expect(() => controller.reserve("agent_1", "second task")).toThrow("Subagent already reserved: agent_1");
	});

	it("allows only the declared status transitions", () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const idle = controller.reserve("idle", "task");
		controller.markRunning("idle");
		controller.markIdle("idle", "result");
		expect(idle).toMatchObject({ status: "idle", finalText: "result" });

		const queuedFailure = controller.reserve("queued-failure", "task");
		controller.markFailed("queued-failure", "failed");
		expect(queuedFailure.status).toBe("failed");

		const queuedInterrupt = controller.reserve("queued-interrupt", "task");
		controller.markInterrupted("queued-interrupt");
		expect(queuedInterrupt.status).toBe("interrupted");

		const runningFailure = controller.reserve("running-failure", "task");
		controller.markRunning("running-failure");
		controller.markFailed("running-failure", "failed");
		expect(runningFailure.status).toBe("failed");

		const runningInterrupt = controller.reserve("running-interrupt", "task");
		controller.markRunning("running-interrupt");
		controller.markInterrupted("running-interrupt");
		expect(runningInterrupt.status).toBe("interrupted");

		const queued = controller.reserve("queued", "task");
		expect(() => controller.markIdle("queued", "result")).toThrow(
			"Invalid subagent status transition: queued -> idle",
		);
		expect(queued.status).toBe("queued");
		expect(() => controller.markRunning("idle")).toThrow("Invalid subagent status transition: idle -> running");
		expect(() => controller.markRunning("missing")).toThrow("Unknown subagent: missing");
	});

	it("queues terminal children for restart and clears stale run state", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const permit = await controller.acquirePermit();
		const states = ["idle", "failed", "interrupted"] as const;

		for (const status of states) {
			const child = await harness();
			const record = controller.reserve(status, "task");
			controller.attachSession(status, child.session);
			controller.markRunning(status);
			if (status === "idle") controller.markIdle(status, "old result");
			if (status === "failed") controller.markFailed(status, "old error", "old result");
			if (status === "interrupted") controller.markInterrupted(status, "old result");
			expect(record.startedAt).toBeDefined();
			expect(record.completedAt).toBeDefined();

			await expect(controller.message(status, "restart", true)).resolves.toMatchObject({
				status: "queued",
				delivery: "prompt",
			});
			expect(record).toMatchObject({
				status: "queued",
				startedAt: undefined,
				completedAt: undefined,
				finalText: undefined,
				error: undefined,
			});
			await expect(controller.interrupt(status)).resolves.toMatchObject({ status: "interrupted" });
		}

		permit.release();
		await controller.shutdown();
	});

	it("publishes monotonic revisions and immutable name-sorted snapshots", () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		expect(controller.snapshot()).toEqual({ revision: 0, agents: [] });

		controller.reserve("zeta", "z task");
		controller.reserve("alpha", "a task");
		controller.markRunning("alpha");
		const snapshot = controller.snapshot();

		expect(snapshot.revision).toBe(3);
		expect(snapshot.agents.map((agent) => agent.name)).toEqual(["alpha", "zeta"]);
		expect(snapshot.agents[0]?.status).toBe("running");
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.agents)).toBe(true);
		expect(snapshot.agents.every(Object.isFrozen)).toBe(true);
		expect(Reflect.set(snapshot, "revision", 100)).toBe(false);
		expect(Reflect.set(snapshot.agents[0]!, "status", "failed")).toBe(false);
	});

	it("publishes safe typed lifecycle events through the revision path", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const events: SubagentLifecycleEvent[] = [];
		const unsubscribe = controller.subscribe((event) => events.push(event));
		controller.subscribe(() => {
			throw new Error("observer failed");
		});

		const record = controller.reserve("worker", "private task text");
		const child = await harness();
		const dispose = vi.spyOn(child.session, "dispose").mockResolvedValue();
		controller.attachSession("worker", child.session);
		controller.trackRun("worker", Promise.resolve());
		controller.markRunning("worker");
		controller.markIdle("worker", "private child output");
		controller.reserve("failure", "private failure task");
		controller.markFailed("failure", "private error details");
		const snapshot = controller.snapshot();
		await controller.shutdown();
		unsubscribe();

		expect(events.map((event) => event.revision)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(events.map((event) => event.type)).toEqual([
			"subagent_reserved",
			"subagent_status_changed",
			"subagent_status_changed",
			"subagent_reserved",
			"subagent_status_changed",
			"subagent_controller_disposed",
		]);
		expect(events.every(Object.isFrozen)).toBe(true);
		expect(dispose).toHaveBeenCalledOnce();

		const serializedEvents = JSON.stringify(events);
		const serializedSnapshot = JSON.stringify(snapshot);
		for (const secret of [
			record.task,
			"private run result",
			"private child output",
			"private failure task",
			"private error details",
		]) {
			expect(serializedEvents).not.toContain(secret);
			expect(serializedSnapshot).not.toContain(secret);
		}
		for (const key of ["task", "session", "run", "result", "finalText", "error"]) {
			expect(serializedEvents).not.toContain(`"${key}"`);
			expect(serializedSnapshot).not.toContain(`"${key}"`);
		}
	});

	it("admits permits in FIFO order without exceeding the limit", async () => {
		const controller = new SubagentController({ maxConcurrent: 2 });
		const first = await controller.acquirePermit();
		const second = await controller.acquirePermit();
		const admitted: string[] = [];
		let active = 2;
		let peakActive = active;
		const thirdPromise = controller.acquirePermit().then((permit) => {
			admitted.push("third");
			active += 1;
			peakActive = Math.max(peakActive, active);
			return permit;
		});
		const fourthPromise = controller.acquirePermit().then((permit) => {
			admitted.push("fourth");
			active += 1;
			peakActive = Math.max(peakActive, active);
			return permit;
		});

		expect(await isPending(thirdPromise)).toBe(true);
		expect(await isPending(fourthPromise)).toBe(true);
		active -= 1;
		second.release();
		const third = await thirdPromise;
		expect(admitted).toEqual(["third"]);
		expect(await isPending(fourthPromise)).toBe(true);

		active -= 1;
		first.release();
		const fourth = await fourthPromise;
		expect(admitted).toEqual(["third", "fourth"]);
		expect(peakActive).toBe(2);
		third.release();
		fourth.release();
	});

	it("makes permit release idempotent", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const first = await controller.acquirePermit();
		const secondPromise = controller.acquirePermit();
		first.release();
		first.release();
		const second = await secondPromise;
		const thirdPromise = controller.acquirePermit();
		expect(await isPending(thirdPromise)).toBe(true);
		second.release();
		const third = await thirdPromise;
		third.release();
	});

	it("releases a permit after admitted work rejects", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		async function runWithPermit(work: () => Promise<void>): Promise<void> {
			const permit = await controller.acquirePermit();
			try {
				await work();
			} finally {
				permit.release();
			}
		}

		await expect(runWithPermit(() => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed");
		await expect(runWithPermit(() => Promise.resolve())).resolves.toBeUndefined();
	});

	it("removes canceled permit requests without disturbing FIFO order", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const active = await controller.acquirePermit();
		const abortController = new AbortController();
		const reason = new Error("caller canceled");
		const canceled = controller.acquirePermit(abortController.signal);
		const next = controller.acquirePermit();

		abortController.abort(reason);
		await expect(canceled).rejects.toBe(reason);
		expect(await isPending(next)).toBe(true);
		active.release();
		const admitted = await next;
		admitted.release();
	});

	it("returns immediate and later revision changes", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		controller.reserve("existing", "task");
		await expect(controller.waitForChange(0, { timeoutMs: 100 })).resolves.toMatchObject({
			reason: "changed",
			snapshot: { revision: 1 },
		});

		const waiting = controller.waitForChange(1, { timeoutMs: 100 });
		controller.reserve("later", "task");
		await expect(waiting).resolves.toMatchObject({ reason: "changed", snapshot: { revision: 2 } });
	});

	it("does not miss a change completed before the revision recheck", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const abortController = new AbortController();
		const addEventListener = abortController.signal.addEventListener.bind(abortController.signal);
		vi.spyOn(abortController.signal, "addEventListener").mockImplementationOnce((...args) => {
			controller.reserve("racing", "task");
			return addEventListener(...args);
		});

		await expect(
			controller.waitForChange(0, { timeoutMs: 100, signal: abortController.signal }),
		).resolves.toMatchObject({ reason: "changed", snapshot: { revision: 1 } });
	});

	it("settles waits on timeout, caller cancellation, and disposal", async () => {
		const timeoutController = new SubagentController({ maxConcurrent: 1 });
		const timeoutSignal = new AbortController();
		const timeoutRemove = vi.spyOn(timeoutSignal.signal, "removeEventListener");
		await expect(timeoutController.waitForChange(0, { timeoutMs: 1, signal: timeoutSignal.signal })).resolves.toEqual(
			{ reason: "timeout" },
		);
		expect(timeoutRemove).toHaveBeenCalled();

		const abortController = new AbortController();
		const abortRemove = vi.spyOn(abortController.signal, "removeEventListener");
		const reason = new Error("wait canceled");
		const aborted = timeoutController.waitForChange(0, { timeoutMs: 100, signal: abortController.signal });
		abortController.abort(reason);
		await expect(aborted).rejects.toBe(reason);
		expect(abortRemove).toHaveBeenCalled();

		const disposedController = new SubagentController({ maxConcurrent: 1 });
		const disposed = disposedController.waitForChange(0, { timeoutMs: 100 });
		await disposedController.shutdown();
		await expect(disposed).resolves.toEqual({ reason: "disposed" });
		await expect(disposedController.waitForChange(0, { timeoutMs: 100 })).resolves.toEqual({
			reason: "disposed",
		});
	});

	it("aborts active sessions, waits for runs, and disposes captured sessions", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const child = await harness();
		const abort = vi.spyOn(child.session, "abort").mockResolvedValue();
		const dispose = vi.spyOn(child.session, "dispose").mockResolvedValue();
		const run = deferred<void>();
		controller.reserve("worker", "task");
		controller.attachSession("worker", child.session);
		controller.trackRun("worker", run.promise);
		controller.markRunning("worker");

		const shutdown = controller.shutdown();
		expect(abort).toHaveBeenCalledOnce();
		expect(await isPending(shutdown)).toBe(true);
		expect(dispose).not.toHaveBeenCalled();
		run.resolve();
		await shutdown;
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("is idempotent and closes admission before awaiting cleanup", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const active = await controller.acquirePermit();
		const queued = controller.acquirePermit();
		const run = deferred<void>();
		controller.reserve("worker", "task");
		controller.trackRun("worker", run.promise);

		const firstShutdown = controller.shutdown();
		const secondShutdown = controller.shutdown();
		expect(firstShutdown).toBe(secondShutdown);
		expect(() => controller.reserve("later", "task")).toThrow("Subagent controller is shut down");
		await expect(controller.acquirePermit()).rejects.toThrow("Subagent controller is shut down");
		await expect(queued).rejects.toThrow("Subagent controller is shut down");
		active.release();
		run.resolve();
		await firstShutdown;
		await expect(controller.shutdown()).resolves.toBeUndefined();
	});

	it("blocks admission during reset, settles waiters, and reuses names after cleanup", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const child = await harness();
		const activePermit = await controller.acquirePermit();
		const queuedPermit = controller.acquirePermit();
		const disposeStarted = deferred<void>();
		const disposeGate = deferred<void>();
		const dispose = vi.spyOn(child.session, "dispose").mockImplementation(async () => {
			disposeStarted.resolve();
			await disposeGate.promise;
		});
		controller.reserve("worker", "private task");
		controller.attachSession("worker", child.session);
		controller.trackRun("worker", Promise.resolve());
		controller.markRunning("worker");
		const waiter = controller.waitForChange(controller.snapshot().revision, { timeoutMs: 100 });
		const events: SubagentLifecycleEvent[] = [];
		controller.subscribe((event) => events.push(event));

		const firstReset = controller.reset();
		const secondReset = controller.reset();
		expect(firstReset).toBe(secondReset);
		expect(controller.snapshot().agents).toEqual([]);
		expect(() => controller.reserve("later", "task")).toThrow("Subagent controller is resetting");
		expect(() => controller.message("worker", "message")).toThrow("Subagent controller is resetting");
		await expect(controller.queryAgents({ timeoutMs: 0 })).rejects.toThrow("Subagent controller is resetting");
		await expect(controller.acquirePermit()).rejects.toThrow("Subagent controller is resetting");
		await expect(queuedPermit).rejects.toThrow("Subagent controller is resetting");
		await expect(waiter).resolves.toEqual({ reason: "reset" });
		await expect(controller.waitForChange(0, { timeoutMs: 100 })).resolves.toEqual({ reason: "reset" });
		activePermit.release();
		await disposeStarted.promise;
		expect(await isPending(firstReset)).toBe(true);
		disposeGate.resolve();
		await firstReset;

		expect(dispose).toHaveBeenCalledOnce();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "subagent_controller_reset" });
		expect(JSON.stringify(events[0])).not.toContain("private task");
		expect(() => controller.reserve("worker", "reused task")).not.toThrow();
		expect(events.map((event) => event.type)).toEqual(["subagent_controller_reset", "subagent_reserved"]);
	});

	it("reopens after aggregating reset cleanup failures", async () => {
		const controller = new SubagentController({ maxConcurrent: 2 });
		const first = await harness();
		const second = await harness();
		const abortFailure = new Error("reset abort failed");
		const disposeFailure = new Error("reset dispose failed");
		vi.spyOn(first.session, "abort").mockRejectedValue(abortFailure);
		vi.spyOn(first.session, "dispose").mockRejectedValue(disposeFailure);
		const secondDispose = vi.spyOn(second.session, "dispose").mockResolvedValue();
		controller.reserve("first", "task");
		controller.attachSession("first", first.session);
		controller.markRunning("first");
		controller.reserve("second", "task");
		controller.attachSession("second", second.session);
		controller.markRunning("second");
		controller.markIdle("second");

		const error = await controller.reset().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([abortFailure, disposeFailure]);
		expect(secondDispose).toHaveBeenCalledOnce();
		expect(controller.snapshot().agents).toEqual([]);
		expect(() => controller.reserve("first", "reused")).not.toThrow();
	});

	it("keeps shutdown permanent when it races reset", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const child = await harness();
		const disposeStarted = deferred<void>();
		const disposeGate = deferred<void>();
		vi.spyOn(child.session, "dispose").mockImplementation(async () => {
			disposeStarted.resolve();
			await disposeGate.promise;
		});
		controller.reserve("worker", "task");
		controller.attachSession("worker", child.session);
		controller.markRunning("worker");
		controller.markIdle("worker");

		const resetResult = controller.reset().catch((reason: unknown) => reason);
		const shutdown = controller.shutdown();
		await disposeStarted.promise;
		expect(await isPending(shutdown)).toBe(true);
		disposeGate.resolve();
		await expect(shutdown).resolves.toBeUndefined();
		await expect(resetResult).resolves.toMatchObject({ message: "Subagent controller is shut down" });
		expect(() => controller.reserve("worker", "reused")).toThrow("Subagent controller is shut down");
		await expect(controller.reset()).rejects.toThrow("Subagent controller is shut down");
	});

	it("shares lifecycle promises with reentrant listeners", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		let nestedReset: Promise<void> | undefined;
		let nestedShutdown: Promise<void> | undefined;
		controller.subscribe((event) => {
			if (event.type === "subagent_controller_reset") nestedReset = controller.reset();
			if (event.type === "subagent_controller_disposed") nestedShutdown = controller.shutdown();
		});

		const reset = controller.reset();
		expect(nestedReset).toBe(reset);
		await reset;
		const shutdown = controller.shutdown();
		expect(nestedShutdown).toBe(shutdown);
		await shutdown;
	});

	it("finishes cleanup before aggregating abort and disposal failures", async () => {
		const controller = new SubagentController({ maxConcurrent: 2 });
		const first = await harness();
		const second = await harness();
		const abortFailure = new Error("abort failed");
		const firstDisposeFailure = new Error("first dispose failed");
		const secondDisposeFailure = new Error("second dispose failed");
		vi.spyOn(first.session, "abort").mockImplementation(() => {
			throw abortFailure;
		});
		vi.spyOn(first.session, "dispose").mockImplementation(() => {
			throw firstDisposeFailure;
		});
		vi.spyOn(second.session, "dispose").mockImplementation(() => {
			throw secondDisposeFailure;
		});

		controller.reserve("first", "task");
		controller.attachSession("first", first.session);
		controller.markRunning("first");
		controller.reserve("second", "task");
		controller.attachSession("second", second.session);
		controller.markFailed("second", "run failed");

		const error = await controller.shutdown().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([abortFailure, firstDisposeFailure, secondDisposeFailure]);
		expect(first.session.dispose).toHaveBeenCalledOnce();
		expect(second.session.dispose).toHaveBeenCalledOnce();
	});

	it("ignores late completion updates after shutdown", async () => {
		const controller = new SubagentController({ maxConcurrent: 1 });
		const run = deferred<string>();
		const record = controller.reserve("worker", "task");
		controller.markRunning("worker");
		const tracked = run.promise.then((result) => controller.markIdle("worker", result));
		controller.trackRun("worker", tracked);
		const revisionBeforeShutdown = controller.snapshot().revision;

		const shutdown = controller.shutdown();
		run.resolve("late result");
		await shutdown;
		expect(record).toMatchObject({ status: "running", finalText: undefined, completedAt: undefined });
		expect(controller.snapshot()).toEqual({ revision: revisionBeforeShutdown + 1, agents: [] });
	});
});
