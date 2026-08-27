import type { AssistantMessage, Context } from "@earendil-works/diffex-ai";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createSubagentSession } from "../../src/core/subagents/services.ts";
import type { SubagentLifecycleEvent } from "../../src/core/subagents/types.ts";
import { createSpawnAgentTool } from "../../src/core/tools/subagents.ts";
import {
	createSubagentTestHarness,
	deferred,
	getLastUserText,
	type SubagentTestHarness,
	waitForStatus,
} from "./subagent-harness.ts";

describe("asynchronous subagent startup", () => {
	const harnesses: SubagentTestHarness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	async function setup(maxConcurrent = 1): Promise<SubagentTestHarness> {
		const harness = await createSubagentTestHarness(maxConcurrent);
		harnesses.push(harness);
		return harness;
	}

	function executeSpawnTool(tool: ReturnType<typeof createSpawnAgentTool>, name: string, task: string) {
		return tool.execute("spawn-call", { name, task }, undefined, undefined, {} as ExtensionContext);
	}

	it("accepts immediately, reserves synchronously, and rejects duplicates", async () => {
		const { harness, controller, createSession } = await setup();
		const response = deferred<AssistantMessage>();
		harness.setResponses([() => response.promise]);
		let capturedToolCallId: string | undefined;
		const tool = createSpawnAgentTool((name, task, toolCallId) => {
			capturedToolCallId = toolCallId;
			controller.spawn(name, task, createSession);
		});

		const accepted = executeSpawnTool(tool, "worker", "blocked task");
		try {
			expect(tool.executionMode).toBe("parallel");
			expect(capturedToolCallId).toBe("spawn-call");
			expect(controller.snapshot()).toMatchObject({ revision: 1, agents: [{ name: "worker", status: "queued" }] });
			await expect(accepted).resolves.toMatchObject({ details: { name: "worker", status: "queued" } });
			await waitForStatus(controller, "worker", "running");
			await expect(executeSpawnTool(tool, "worker", "duplicate")).rejects.toThrow(
				"Subagent already reserved: worker",
			);
			expect(controller.snapshot().agents).toHaveLength(1);
		} finally {
			response.resolve(fauxAssistantMessage("finished"));
		}
		await waitForStatus(controller, "worker", "idle");
	});

	it("validates names and non-empty tasks before spawning", async () => {
		const spawn = vi.fn();
		const tool = createSpawnAgentTool(spawn);

		await expect(executeSpawnTool(tool, "Invalid", "task")).rejects.toThrow("Invalid subagent name: Invalid");
		await expect(executeSpawnTool(tool, "worker", "   ")).rejects.toThrow("Subagent task must be non-empty");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("admits parallel children in FIFO order as permits release", async () => {
		const { harness, controller, createSession } = await setup(2);
		const gates = new Map(
			["first", "second", "third", "fourth"].map((name) => [name, deferred<AssistantMessage>()] as const),
		);
		const providerStarts = new Map(
			["first", "second", "third", "fourth"].map((name) => [name, deferred<void>()] as const),
		);
		const started: string[] = [];
		const response = async (context: Context): Promise<AssistantMessage> => {
			const task = getLastUserText(context);
			started.push(task);
			providerStarts.get(task)!.resolve();
			return gates.get(task)!.promise;
		};
		harness.setResponses([response, response, response, response]);
		for (const name of ["first", "second", "third", "fourth"]) {
			controller.spawn(name, name, createSession);
		}

		try {
			await Promise.all([providerStarts.get("first")!.promise, providerStarts.get("second")!.promise]);
			expect(controller.snapshot().agents.filter((agent) => agent.status === "running")).toHaveLength(2);
			expect(controller.snapshot().agents.find((agent) => agent.name === "third")?.status).toBe("queued");
			expect(controller.snapshot().agents.find((agent) => agent.name === "fourth")?.status).toBe("queued");

			gates.get("second")!.resolve(fauxAssistantMessage("second done"));
			await waitForStatus(controller, "second", "idle");
			await providerStarts.get("third")!.promise;
			expect(started.slice(0, 2).sort()).toEqual(["first", "second"]);
			expect(started[2]).toBe("third");
			expect(controller.snapshot().agents.find((agent) => agent.name === "fourth")?.status).toBe("queued");

			gates.get("first")!.resolve(fauxAssistantMessage("first done"));
			await waitForStatus(controller, "first", "idle");
			await providerStarts.get("fourth")!.promise;
			expect(started[3]).toBe("fourth");
		} finally {
			for (const [name, gate] of gates) gate.resolve(fauxAssistantMessage(`${name} done`));
		}
		await Promise.all(["first", "second", "third", "fourth"].map((name) => waitForStatus(controller, name, "idle")));
	});

	it("classifies terminal responses and releases permits after failures", async () => {
		const { harness, controller, config, createSession } = await setup();
		harness.setResponses([
			fauxAssistantMessage("partial error text", { stopReason: "error", errorMessage: "provider failed" }),
			fauxAssistantMessage("partial abort text", { stopReason: "aborted", errorMessage: "request aborted" }),
			fauxAssistantMessage("successful text"),
		]);
		const events: SubagentLifecycleEvent[] = [];
		controller.subscribe((event) => events.push(event));

		controller.spawn("failed", "error task", createSession);
		await waitForStatus(controller, "failed", "failed");

		controller.spawn("interrupted", "abort task", createSession);
		await waitForStatus(controller, "interrupted", "interrupted");

		controller.spawn("startup", "startup task", async () => {
			throw new Error("startup failed");
		});
		await waitForStatus(controller, "startup", "failed");

		controller.spawn("preflight", "preflight task", async (signal) => {
			const session = await createSubagentSession(config, { signal });
			Object.defineProperty(session.agent.state, "model", { value: undefined, writable: true });
			return session;
		});
		await waitForStatus(controller, "preflight", "failed");

		controller.spawn("prompt", "prompt task", async (signal) => {
			const session = await createSession(signal);
			vi.spyOn(session, "prompt").mockImplementation(async () => {
				session.agent.state.messages.push(fauxAssistantMessage("partial thrown text"));
				throw "prompt failed";
			});
			return session;
		});
		await waitForStatus(controller, "prompt", "failed");

		controller.spawn("idle", "success task", async (signal) => {
			const session = await createSession(signal);
			session.agent.state.messages.push(fauxAssistantMessage("older assistant text"));
			return session;
		});
		await waitForStatus(controller, "idle", "idle");

		const idleEvents = events.flatMap((event) =>
			"name" in event && event.name === "idle" ? [{ status: event.status, revision: event.revision }] : [],
		);
		expect(idleEvents.map((event) => event.status)).toEqual(["queued", "running", "idle"]);
		expect(idleEvents.map((event) => event.revision)).toEqual(
			[...idleEvents.map((event) => event.revision)].sort((a, b) => a - b),
		);
	});

	it("disposes a child created after shutdown without late transitions", async () => {
		const { controller, config } = await setup();
		const lateChild = await createSubagentSession(config);
		const dispose = vi.spyOn(lateChild, "dispose");
		const construction = deferred<void>();
		const entered = deferred<void>();
		const events: SubagentLifecycleEvent[] = [];
		controller.subscribe((event) => events.push(event));
		controller.spawn("late", "task", async () => {
			entered.resolve();
			await construction.promise;
			return lateChild;
		});
		await entered.promise;

		const shutdown = controller.shutdown();
		construction.resolve();
		await shutdown;

		expect(dispose).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(["subagent_reserved", "subagent_controller_disposed"]);
	});

	it("interrupts an attached child during prompt preflight without starting the provider", async () => {
		const { harness, controller, createSession } = await setup();
		const authStarted = deferred<void>();
		let child: AgentSession | undefined;
		harness.setResponses([fauxAssistantMessage("must not run")]);
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async (_providerId, options) => {
			authStarted.resolve();
			const signal = options?.signal;
			if (!signal) throw new Error("Expected the controller run signal during prompt preflight");
			return new Promise<never>((_resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		controller.spawn("worker", "task", async (signal) => {
			child = await createSession(signal);
			return child;
		});
		await authStarted.promise;

		expect(controller.snapshot().agents).toMatchObject([{ name: "worker", status: "queued" }]);
		await expect(controller.interrupt("worker")).resolves.toMatchObject({ status: "interrupted" });
		expect(controller.snapshot().agents).toMatchObject([{ name: "worker", status: "interrupted" }]);
		expect(child?.messages).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("aborts and disposes an executing child once during shutdown", async () => {
		const { harness, controller, createSession } = await setup();
		const response = deferred<AssistantMessage>();
		harness.setResponses([() => response.promise]);
		let child: AgentSession | undefined;
		const events: SubagentLifecycleEvent[] = [];
		controller.subscribe((event) => events.push(event));
		controller.spawn("active", "task", async (signal) => {
			child = await createSession(signal);
			return child;
		});
		await waitForStatus(controller, "active", "running");
		const abort = vi.spyOn(child!, "abort");
		const dispose = vi.spyOn(child!, "dispose");

		const shutdown = controller.shutdown();
		try {
			expect(abort).toHaveBeenCalledOnce();
		} finally {
			response.resolve(fauxAssistantMessage("late response"));
		}
		await shutdown;

		expect(dispose).toHaveBeenCalledOnce();
		expect(events.at(-1)?.type).toBe("subagent_controller_disposed");
		const disposalIndex = events.findIndex((event) => event.type === "subagent_controller_disposed");
		expect(events.slice(disposalIndex + 1)).toEqual([]);
	});
});
