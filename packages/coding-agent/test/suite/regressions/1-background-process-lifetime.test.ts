import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ShellOwnershipRecord } from "../../../src/utils/owned-shell-processes.ts";
import { createBackgroundService, queryBackgroundService } from "../../background-service.ts";
import { createHarness } from "../harness.ts";
import { createSubagentTestHarness, deferred, waitForStatus } from "../subagent-harness.ts";

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("process lifetime issue 1", () => {
	it("preserves direct session bash services across repeated disposal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-direct-service-"));
		const service = createBackgroundService(directory, { noisy: true });
		const harness = await createHarness({
			backgroundProcessPolicy: { lifetime: "environment", ownershipDirectory: join(directory, "ownership") },
		});
		try {
			expect((await harness.session.executeBash(service.command)).exitCode).toBe(0);
			expect(harness.session.ownedShellProcessCount).toBe(0);
			await harness.session.abort();
			await harness.session.dispose();
			await harness.session.dispose();
			await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
		} finally {
			service.cleanup();
			await harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["success", "failure", "deadline"])("inherits environment ownership through child %s", async (outcome) => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-child-service-"));
		const ownershipDirectory = join(directory, "ownership");
		const service = createBackgroundService(directory);
		const fixture = await createSubagentTestHarness(1, {
			sessionManager: SessionManager.inMemory(directory),
			backgroundProcessPolicy: { lifetime: "environment", ownershipDirectory },
		});
		const waiting = deferred<void>();
		let statusAtFailure: string | undefined;
		try {
			fixture.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: service.command }), { stopReason: "toolUse" }),
				async (_context, options) => {
					await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
					if (outcome === "deadline") {
						const cancelled = deferred<void>();
						options?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
						waiting.resolve();
						await cancelled.promise;
						return fauxAssistantMessage("deadline", { stopReason: "aborted" });
					}
					return fauxAssistantMessage(outcome, {
						stopReason: outcome === "failure" ? "error" : "stop",
						errorMessage: outcome === "failure" ? "Controlled failure" : undefined,
					});
				},
			]);
			if (outcome === "deadline") vi.useFakeTimers();
			fixture.controller.spawn("worker", "Launch the service", fixture.createSession);
			if (outcome === "deadline") {
				await waiting.promise;
				await vi.advanceTimersByTimeAsync(15 * 60_000);
				vi.useRealTimers();
			}
			const expected = outcome === "success" ? "idle" : outcome === "failure" ? "failed" : "interrupted";
			await waitForStatus(fixture.controller, "worker", expected);
			statusAtFailure = fixture.controller.snapshot().agents[0]?.status;
			const records: ShellOwnershipRecord[] = readdirSync(ownershipDirectory)
				.filter((file) => file.endsWith(".json"))
				.map((file) => JSON.parse(readFileSync(join(ownershipDirectory, file), "utf8")));
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ owner: "environment", state: "background" });
			await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
			await fixture.controller.shutdown();
			await fixture.harness.session.dispose();
			await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
			expect(statusAtFailure).toBe(expected);
		} finally {
			vi.useRealTimers();
			await fixture.cleanup();
			service.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("preserves a service across runtime replacement and invalidates the old session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-replace-service-"));
		const policy = { lifetime: "environment", ownershipDirectory: join(directory, "ownership") } as const;
		const service = createBackgroundService(directory);
		const harness = await createHarness();
		const services = await createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
			},
		});
		const runtime = await createAgentSessionRuntime(
			async ({ sessionManager, sessionStartEvent }) => ({
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
					backgroundProcessPolicy: policy,
				})),
				services,
				diagnostics: [],
			}),
			{ cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory) },
		);
		try {
			expect((await runtime.session.executeBash(service.command)).exitCode).toBe(0);
			const oldSession = runtime.session;
			await runtime.newSession();
			expect(runtime.session).not.toBe(oldSession);
			expect(runtime.session.backgroundProcessPolicy).toEqual(policy);
			await expect(oldSession.executeBash("echo stale")).rejects.toThrow("disposed");
			await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
			await runtime.dispose();
			await runtime.dispose();
			await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
		} finally {
			service.cleanup();
			await runtime.dispose();
			await harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
