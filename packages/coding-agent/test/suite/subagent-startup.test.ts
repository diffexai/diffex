import type { AssistantMessage, Context } from "@earendil-works/diffex-ai";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createSubagentSession } from "../../src/core/subagents/services.ts";
import type { SubagentLifecycleEvent, SubagentRecord } from "../../src/core/subagents/types.ts";
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
		let record: SubagentRecord | undefined;
		const tool = createSpawnAgentTool((name, task) => {
			record = controller.spawn(name, task, createSession);
		});

		const accepted = executeSpawnTool(tool, "worker", "blocked task");
		expect(tool.executionMode).toBe("parallel");
		expect(record).toMatchObject({ name: "worker", task: "blocked task", status: "queued" });
		expect(controller.snapshot()).toMatchObject({ revision: 1, agents: [{ name: "worker", status: "queued" }] });
		await expect(accepted).resolves.toMatchObject({ details: { name: "worker", status: "queued" } });
		await waitForStatus(controller, "worker", "running");
		expect(record?.run).toBeInstanceOf(Promise);

		await expect(executeSpawnTool(tool, "worker", "duplicate")).rejects.toThrow("Subagent already reserved: worker");
		expect(controller.snapshot().agents).toHaveLength(1);

		response.resolve(fauxAssistantMessage("finished"));
		await record?.run;
		expect(record).toMatchObject({ status: "idle", finalText: "finished" });
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
		const records = ["first", "second", "third", "fourth"].map((name) => controller.spawn(name, name, createSession));

		try {
			await Promise.all([providerStarts.get("first")!.promise, providerStarts.get("second")!.promise]);
			expect(controller.snapshot().agents.filter((agent) => agent.status === "running")).toHaveLength(2);
			expect(controller.snapshot().agents.find((agent) => agent.name === "third")?.status).toBe("queued");
			expect(controller.snapshot().agents.find((agent) => agent.name === "fourth")?.status).toBe("queued");

			gates.get("second")!.resolve(fauxAssistantMessage("second done"));
			await records[1]!.run;
			await providerStarts.get("third")!.promise;
			expect(started).toEqual(["first", "second", "third"]);
			expect(controller.snapshot().agents.find((agent) => agent.name === "fourth")?.status).toBe("queued");

			gates.get("first")!.resolve(fauxAssistantMessage("first done"));
			await records[0]!.run;
			await providerStarts.get("fourth")!.promise;
			expect(started).toEqual(["first", "second", "third", "fourth"]);
		} finally {
			for (const [name, gate] of gates) gate.resolve(fauxAssistantMessage(`${name} done`));
		}
		await Promise.all(records.map((record) => record.run));
		expect(records.every((record) => record.status === "idle")).toBe(true);
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

		const failed = controller.spawn("failed", "error task", createSession);
		await failed.run;
		expect(failed).toMatchObject({ status: "failed", finalText: "partial error text", error: "provider failed" });

		const interrupted = controller.spawn("interrupted", "abort task", createSession);
		await interrupted.run;
		expect(interrupted).toMatchObject({ status: "interrupted", finalText: "partial abort text" });

		const startup = controller.spawn("startup", "startup task", async () => {
			throw new Error("startup failed");
		});
		await startup.run;
		expect(startup).toMatchObject({ status: "failed", error: "startup failed" });

		const preflight = controller.spawn("preflight", "preflight task", async (signal) => {
			const session = await createSubagentSession(config, { signal });
			Object.defineProperty(session.agent.state, "model", { value: undefined, writable: true });
			return session;
		});
		await preflight.run;
		expect(preflight).toMatchObject({ status: "failed" });
		expect(preflight.error).toContain("No model selected");

		const promptFailure = controller.spawn("prompt", "prompt task", async (signal) => {
			const session = await createSession(signal);
			vi.spyOn(session, "prompt").mockImplementation(async () => {
				session.agent.state.messages.push(fauxAssistantMessage("partial thrown text"));
				throw "prompt failed";
			});
			return session;
		});
		await promptFailure.run;
		expect(promptFailure).toMatchObject({
			status: "failed",
			finalText: "partial thrown text",
			error: "prompt failed",
		});

		const idle = controller.spawn("idle", "success task", async (signal) => {
			const session = await createSession(signal);
			session.agent.state.messages.push(fauxAssistantMessage("older assistant text"));
			return session;
		});
		await idle.run;
		expect(idle).toMatchObject({ status: "idle", finalText: "successful text" });

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
		const record = controller.spawn("late", "task", async () => {
			entered.resolve();
			await construction.promise;
			return lateChild;
		});
		await entered.promise;

		const shutdown = controller.shutdown();
		construction.resolve();
		await shutdown;
		await record.run;

		expect(dispose).toHaveBeenCalledOnce();
		expect(events.map((event) => event.type)).toEqual(["subagent_reserved", "subagent_controller_disposed"]);
	});

	it("aborts and disposes an executing child once during shutdown", async () => {
		const { harness, controller, createSession } = await setup();
		const response = deferred<AssistantMessage>();
		harness.setResponses([() => response.promise]);
		let child: AgentSession | undefined;
		const events: SubagentLifecycleEvent[] = [];
		controller.subscribe((event) => events.push(event));
		const record = controller.spawn("active", "task", async (signal) => {
			child = await createSession(signal);
			return child;
		});
		await waitForStatus(controller, "active", "running");
		const abort = vi.spyOn(child!, "abort");
		const dispose = vi.spyOn(child!, "dispose");

		const shutdown = controller.shutdown();
		expect(abort).toHaveBeenCalledOnce();
		response.resolve(fauxAssistantMessage("late response"));
		await shutdown;
		await record.run;

		expect(dispose).toHaveBeenCalledOnce();
		expect(events.at(-1)?.type).toBe("subagent_controller_disposed");
		const disposalIndex = events.findIndex((event) => event.type === "subagent_controller_disposed");
		expect(events.slice(disposalIndex + 1)).toEqual([]);
	});
});
