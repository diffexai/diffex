import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import { captureSubagentSessionConfig, createSubagentSession } from "../../src/core/subagents/services.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred, getLastUserText } from "./subagent-harness.ts";

describe("subagent supervision", () => {
	let harness: Harness | undefined;
	let controller: SubagentController | undefined;
	afterEach(async () => {
		await controller?.shutdown();
		await harness?.cleanup();
		vi.useRealTimers();
	});

	it("expires the default 15-minute lease and waits for model cancellation", async () => {
		harness = await createHarness();
		vi.useFakeTimers();
		controller = new SubagentController({ maxConcurrent: 1 });
		const started = deferred<void>();
		const aborted = deferred<void>();
		harness.setResponses([
			async (_context, options) => {
				options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				started.resolve();
				await aborted.promise;
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
		]);
		controller.spawn("worker", "Build", async () => harness!.session);
		await started.promise;
		await vi.advanceTimersByTimeAsync(899_999);
		expect(controller.snapshot().agents[0]?.status).toBe("running");
		await vi.advanceTimersByTimeAsync(1);
		expect(controller.snapshot().agents[0]?.status).toBe("interrupted");
	});

	it("reports only status and activity times every two minutes by default", async () => {
		harness = await createHarness();
		vi.useFakeTimers();
		controller = new SubagentController({ maxConcurrent: 1 });
		const reports: Array<{ name: string; text: string }> = [];
		controller.bindParent(
			harness.session,
			() => [],
			async (name, text) => {
				reports.push({ name, text });
			},
		);
		const started = deferred<void>();
		harness.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" })),
						{ once: true },
					);
					started.resolve();
				}),
		]);
		controller.spawn("worker", "Build", async () => harness!.session);
		await started.promise;
		controller.spawn("queued", "Wait for capacity", async () => harness!.session);
		await vi.advanceTimersByTimeAsync(119_999);
		expect(reports).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(reports).toEqual([
			{ name: "worker", text: 'Runtime supervision: {"status":"running","elapsed_ms":120000,"inactive_ms":120000}' },
			{ name: "queued", text: 'Runtime supervision: {"status":"queued","elapsed_ms":120000,"inactive_ms":120000}' },
		]);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(reports.slice(2)).toEqual([
			{ name: "worker", text: 'Runtime supervision: {"status":"running","elapsed_ms":240000,"inactive_ms":240000}' },
			{ name: "queued", text: 'Runtime supervision: {"status":"queued","elapsed_ms":240000,"inactive_ms":240000}' },
		]);
	});

	it("requests one checkpoint per allowance and adds fifteen minutes on parent approval", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		const config = captureSubagentSessionConfig(harness.session, harness.tempDir);
		vi.useFakeTimers();
		const now = Date.now();
		controller = new SubagentController({ maxConcurrent: 1 });
		const reports: string[] = [];
		controller.bindParent(
			harness.session,
			() => [],
			async (_name, text) => {
				reports.push(text);
			},
		);
		const started = deferred<void>();
		const firstResponse = deferred<AssistantMessage>();
		const resumed = deferred<void>();
		let checkpointInstruction = "";
		const checkpoint =
			"Current progress: compiled the core. Remaining work: run validation. Goal: deliver a verified build. An extension is needed.";
		harness.setResponses([
			(_context, options) => {
				options?.signal?.addEventListener(
					"abort",
					() => firstResponse.resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" })),
					{ once: true },
				);
				started.resolve();
				return firstResponse.promise;
			},
			(context) => {
				checkpointInstruction = getLastUserText(context);
				return fauxAssistantMessage(fauxToolCall("escalate_to_parent", { message: checkpoint }), {
					stopReason: "toolUse",
				});
			},
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" })),
						{ once: true },
					);
					resumed.resolve();
				}),
		]);
		let child: AgentSession | undefined;
		controller.spawn("worker", "Deliver a verified build", async (signal, escalateToParent) => {
			child = await createSubagentSession(config, { signal, escalateToParent });
			return child;
		});
		await started.promise;
		await vi.advanceTimersByTimeAsync(12 * 60_000 - 1);
		expect(child!.getSteeringMessages()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(child!.getSteeringMessages()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(child!.getSteeringMessages()).toHaveLength(1);
		firstResponse.resolve(fauxAssistantMessage("Core compiled; validation remains."));
		await resumed.promise;
		for (const field of [
			"escalate_to_parent",
			"current progress",
			"remaining work",
			"the goal",
			"decision or extension needed",
		]) {
			expect(checkpointInstruction).toContain(field);
		}
		expect(checkpointInstruction).not.toContain("expected duration");
		expect(reports).toContain(checkpoint);
		expect(child!.getSteeringMessages()).toHaveLength(0);
		const action = controller.createToolDefinitions().find((tool) => tool.name === "agent_action")!;
		await expect(
			action.execute(
				"approve",
				{
					target: "worker",
					action: "renew",
					reason: "Core compiled; validation is required for the build goal.",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).resolves.toMatchObject({ details: { deadline: now + 30 * 60_000 } });
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(reports.at(-1)).toBe('Runtime supervision: {"status":"running","elapsed_ms":960000,"inactive_ms":120000}');
		expect(controller.snapshot().agents[0]?.status).toBe("running");
		await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
		expect(child!.getSteeringMessages()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(child!.getSteeringMessages()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(child!.getSteeringMessages()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(controller.snapshot().agents[0]?.status).toBe("interrupted");
	});

	it("preserves extended deadlines beyond one native timer interval", async () => {
		harness = await createHarness();
		vi.useFakeTimers();
		const now = Date.now();
		const allowance = 2_147_483_647;
		controller = new SubagentController({ maxConcurrent: 1, leaseMs: allowance, supervisionIntervalMs: allowance });
		const started = deferred<void>();
		harness.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" })),
						{ once: true },
					);
					started.resolve();
				}),
		]);
		controller.spawn("worker", "Build", async () => harness!.session);
		await started.promise;
		await expect(controller.renew("worker", "Required work remains")).resolves.toMatchObject({
			deadline: now + 2 * allowance,
		});
		await vi.advanceTimersByTimeAsync(allowance);
		expect(controller.snapshot().agents[0]?.status).toBe("running");
		await vi.advanceTimersByTimeAsync(allowance);
		expect(controller.snapshot().agents[0]?.status).toBe("interrupted");
	});

	it("reports activity and renews a justified build only up to the parent deadline", async () => {
		harness = await createHarness();
		vi.useFakeTimers();
		const now = Date.now();
		controller = new SubagentController({
			maxConcurrent: 1,
			leaseMs: 1000,
			supervisionIntervalMs: 100,
			parentDeadline: now + 1500,
		});
		const reports: string[] = [];
		controller.bindParent(
			harness.session,
			() => [],
			async (_name, text) => {
				reports.push(text);
			},
		);
		const started = deferred<void>();
		harness.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" })),
						{ once: true },
					);
					started.resolve();
				}),
		]);
		controller.spawn("worker", "Build", async () => harness!.session);
		await started.promise;
		await vi.advanceTimersByTimeAsync(900);
		expect(reports.join("\n")).toContain("Runtime supervision");
		expect(reports.join("\n")).not.toContain("tokens");
		expect(harness.session.getSteeringMessages().join("\n")).toContain("concise checkpoint");
		const waiting = controller.queryAgents({ timeoutMs: 10_000, targets: ["worker"], until: "all" });
		await expect(controller.renew("worker", "")).rejects.toThrow();
		await expect(controller.renew("worker", "Compiler is still building required targets")).resolves.toMatchObject({
			deadline: now + 1500,
		});
		await vi.advanceTimersByTimeAsync(101);
		await expect(waiting).resolves.toMatchObject({ timedOut: true });
		expect(controller.snapshot().agents[0]?.status).toBe("running");
		await vi.advanceTimersByTimeAsync(299);
		expect(harness.session.getSteeringMessages()).toHaveLength(2);
		await expect(controller.renew("worker", "Still needed, but capped")).resolves.toMatchObject({
			deadline: now + 1500,
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(harness.session.getSteeringMessages()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.snapshot().agents[0]?.status).toBe("interrupted");
		const reportCount = reports.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(reports).toHaveLength(reportCount);
		await expect(controller.renew("worker", "Too late")).rejects.toThrow("inactive or expired");
	});
});
