import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/diffex-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { appModeSupportsCollaborationMode, main } from "../src/main.ts";

vi.mock("../src/core/output-guard.ts", () => ({
	restoreStdout: vi.fn(),
	takeOverStdout: vi.fn(),
}));

vi.mock("../src/migrations.ts", () => ({
	runMigrations: vi.fn(() => ({ migratedAuthProviders: [], deprecationWarnings: [] })),
	showDeprecationWarnings: vi.fn(),
}));

vi.mock("../src/package-manager-cli.ts", () => ({
	handleConfigCommand: vi.fn(async () => false),
	handlePackageCommand: vi.fn(async () => false),
}));

describe("plan-mode host support", () => {
	it.each(["print", "json", "rpc"] as const)("rejects %s output mode", (appMode) => {
		expect(appModeSupportsCollaborationMode(appMode, "plan")).toBe(false);
	});

	it("allows interactive mode", () => {
		expect(appModeSupportsCollaborationMode("interactive", "plan")).toBe(true);
	});

	it("rejects --plan with session export before reading the export target", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${String(code)}`);
		});
		try {
			await expect(main(["--plan", "--export", "/missing/session.jsonl"])).rejects.toThrow("exit:1");
			expect(error).toHaveBeenCalledWith(expect.stringContaining("--plan is only supported in interactive mode"));
		} finally {
			exit.mockRestore();
			error.mockRestore();
		}
	});

	it("rejects a resumed accepted plan continuation before runtime or piped-input setup", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "diffex-main-plan-continuation-"));
		const agentDir = join(tempDir, "agent");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage(assistant);
		sessionManager.appendCollaborationModeChange("plan");
		const plan = { id: "accepted-plan", title: "Accepted plan", markdown: "1. Stay interactive." };
		sessionManager.appendPlan(plan);
		sessionManager.appendPlanResolution(plan.id, "implement");
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		expect(SessionManager.open(sessionFile).buildSessionContext().pendingPlanContinuation).toEqual(plan);

		const extensionFactory = vi.fn<ExtensionFactory>();
		const stdinResume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${String(code)}`);
		});
		vi.stubEnv("DIFFEX_CODING_AGENT_DIR", agentDir);

		try {
			await expect(
				main(["--print", "--session", sessionFile], { extensionFactories: [extensionFactory] }),
			).rejects.toThrow("exit:1");
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining("Plan mode is not supported in print, JSON, or RPC mode"),
			);
			expect(extensionFactory).not.toHaveBeenCalled();
			expect(stdinResume).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
			exit.mockRestore();
			error.mockRestore();
			stdinResume.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
