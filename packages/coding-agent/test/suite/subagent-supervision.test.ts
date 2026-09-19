import { type AssistantMessage, fauxAssistantMessage } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

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
		await expect(controller.renew("worker", "", 1000)).rejects.toThrow();
		await expect(
			controller.renew("worker", "Compiler is still building required targets", 1000),
		).resolves.toMatchObject({ deadline: now + 1500 });
		await vi.advanceTimersByTimeAsync(101);
		await expect(waiting).resolves.toMatchObject({ timedOut: true });
		expect(controller.snapshot().agents[0]?.status).toBe("running");
		await vi.advanceTimersByTimeAsync(499);
		expect(controller.snapshot().agents[0]?.status).toBe("interrupted");
		const reportCount = reports.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(reports).toHaveLength(reportCount);
		await expect(controller.renew("worker", "Too late")).rejects.toThrow("inactive or expired");
	});
});
