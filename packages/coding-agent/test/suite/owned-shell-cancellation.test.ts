import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

describe.skipIf(process.platform === "win32")("owned shell cancellation", () => {
	let harness: Harness | undefined;
	let controller: SubagentController | undefined;
	let pid: number | undefined;
	afterEach(async () => {
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		harness?.session.abortBash();
		await controller?.shutdown();
		await harness?.cleanup();
	});

	it("interrupts background work even after its bash tool has returned", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		controller = new SubagentController({ maxConcurrent: 1 });
		const waiting = deferred<void>();
		const providerAborted = deferred<void>();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 60 >/dev/null 2>&1 & echo $! > child.pid" }), {
				stopReason: "toolUse",
			}),
			async (_context, options) => {
				pid = Number(readFileSync(join(harness!.tempDir, "child.pid"), "utf8").trim());
				options?.signal?.addEventListener("abort", () => providerAborted.resolve(), { once: true });
				waiting.resolve();
				await providerAborted.promise;
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
		]);
		controller.spawn("worker", "Run the build", async () => harness!.session);
		await waiting.promise;
		await controller.interrupt("worker");
		expect(() => process.kill(pid!, 0)).toThrow();
		expect(controller.snapshot().agents[0]?.status).toBe("interrupted");
	});

	it("cleans up background jobs before declaring normal child completion", async () => {
		harness = await createHarness();
		controller = new SubagentController({ maxConcurrent: 1 });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 60 >/dev/null 2>&1 & echo $! > child.pid" }), {
				stopReason: "toolUse",
			}),
			() => {
				pid = Number(readFileSync(join(harness!.tempDir, "child.pid"), "utf8").trim());
				return fauxAssistantMessage("Done");
			},
		]);
		controller.spawn("worker", "Build", async () => harness!.session);
		await vi.waitFor(() => expect(controller!.snapshot().agents[0]?.status).toBe("idle"));
		expect(() => process.kill(pid!, 0)).toThrow();
		expect(harness.session.ownedShellProcessCount).toBe(0);
	});

	it("reports termination verification failures instead of claiming completion", async () => {
		harness = await createHarness();
		controller = new SubagentController({ maxConcurrent: 1 });
		harness.setResponses([fauxAssistantMessage("Done")]);
		const cleanup = vi
			.spyOn(harness.session, "terminateOwnedShellProcesses")
			.mockRejectedValueOnce(new Error("Shell process group did not terminate"));
		controller.spawn("worker", "Build", async () => harness!.session);
		await vi.waitFor(() => expect(controller!.snapshot().agents[0]?.status).toBe("failed"));
		expect((await controller.queryAgents({ timeoutMs: 0 })).agents[0]?.error).toContain("did not terminate");
		cleanup.mockRestore();
	});

	it("abort cancels session-owned bash and waits for termination", async () => {
		harness = await createHarness();
		const started = deferred<void>();
		const execution = harness.session.executeBash("echo ready; sleep 60", () => started.resolve());
		await started.promise;
		let settled = false;
		void execution.then(() => {
			settled = true;
		});
		try {
			await harness.session.abort();
			expect(settled).toBe(true);
			expect((await execution).cancelled).toBe(true);
		} finally {
			harness.session.abortBash();
			await execution;
		}
	});
});
