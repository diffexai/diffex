import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendCurrentPlanRecord,
	CURRENT_PLAN_CUSTOM_ENTRY_TYPE,
	resolveCurrentPlanState,
} from "../src/core/current-plan-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createUpdatePlanTool } from "../src/core/tools/update-plan.ts";
import { assistantMsg, userMsg } from "./message-fixtures.ts";

describe("current plan state", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("appends and resolves exact defensive copies", () => {
		const sessionManager = SessionManager.inMemory();
		const operation = {
			plan: [
				{ id: "preserve-exact-whitespace", step: "  Preserve exact whitespace  ", status: "in_progress" as const },
				{ id: "finish", step: "Finish", status: "pending" as const },
			],
			explanation: "  exact explanation  ",
		};

		appendCurrentPlanRecord(sessionManager, operation);
		operation.plan[0].step = "mutated input";
		operation.explanation = "mutated input";

		const entry = sessionManager.getBranch()[0];
		expect(entry).toMatchObject({
			type: "custom",
			customType: CURRENT_PLAN_CUSTOM_ENTRY_TYPE,
			data: {
				plan: [
					{ id: "preserve-exact-whitespace", step: "  Preserve exact whitespace  ", status: "in_progress" },
					{ id: "finish", step: "Finish", status: "pending" },
				],
				explanation: "  exact explanation  ",
			},
		});

		const resolved = resolveCurrentPlanState(sessionManager);
		expect(resolved).toEqual({
			status: "active",
			operation: {
				plan: [
					{ id: "preserve-exact-whitespace", step: "  Preserve exact whitespace  ", status: "in_progress" },
					{ id: "finish", step: "Finish", status: "pending" },
				],
				explanation: "  exact explanation  ",
			},
		});
		if (resolved.status !== "active") return;
		resolved.operation.plan[0].step = "mutated resolution";
		const resolvedAgain = resolveCurrentPlanState(sessionManager);
		expect(resolvedAgain.status).toBe("active");
		if (resolvedAgain.status === "active") {
			expect(resolvedAgain.operation.plan[0].step).toBe("  Preserve exact whitespace  ");
		}
	});

	it("uses only the newest record on the selected branch", () => {
		const sessionManager = SessionManager.inMemory();
		const rootId = appendCurrentPlanRecord(sessionManager, {
			plan: [{ id: "root-plan", step: "Root plan", status: "in_progress" }],
			explanation: "root",
		});
		const firstBranchId = appendCurrentPlanRecord(sessionManager, {
			plan: [{ id: "first-branch", step: "First branch", status: "in_progress" }],
		});

		sessionManager.branch(rootId);
		appendCurrentPlanRecord(sessionManager, { clear: true, explanation: "second branch" });
		expect(resolveCurrentPlanState(sessionManager)).toEqual({
			status: "inactive",
			operation: { clear: true, explanation: "second branch" },
		});

		sessionManager.branch(firstBranchId);
		expect(resolveCurrentPlanState(sessionManager)).toEqual({
			status: "active",
			operation: { plan: [{ id: "first-branch", step: "First branch", status: "in_progress" }] },
		});
	});

	it("round-trips the exact newest state through reopen", () => {
		const tempDir = join(tmpdir(), `current-plan-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempDirs.push(tempDir);
		mkdirSync(tempDir, { recursive: true });
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage(userMsg("start"));
		sessionManager.appendMessage(assistantMsg("working"));
		appendCurrentPlanRecord(sessionManager, {
			plan: [
				{ id: "done", step: "Done", status: "completed" },
				{ id: "current", step: "Current", status: "in_progress", success_criteria: ["Survives reopen"] },
			],
			explanation: "  reopened exactly  ",
		});

		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopened = SessionManager.open(sessionFile!, tempDir);
		expect(resolveCurrentPlanState(reopened)).toEqual(resolveCurrentPlanState(sessionManager));
		const reopenedState = resolveCurrentPlanState(reopened);
		expect(reopenedState.status).toBe("active");
		if (reopenedState.status === "active") {
			expect(reopenedState.operation.plan[1]).toEqual({
				id: "current",
				step: "Current",
				status: "in_progress",
				success_criteria: ["Survives reopen"],
			});
		}
	});

	it("classifies completed, cleared, absent, and corrupt newest states", () => {
		const sessionManager = SessionManager.inMemory();
		expect(resolveCurrentPlanState(sessionManager)).toEqual({ status: "absent" });

		appendCurrentPlanRecord(sessionManager, {
			plan: [{ id: "finished", step: "Finished", status: "completed" }],
			explanation: "complete",
		});
		expect(resolveCurrentPlanState(sessionManager)).toEqual({
			status: "inactive",
			operation: {
				plan: [{ id: "finished", step: "Finished", status: "completed" }],
				explanation: "complete",
			},
		});

		appendCurrentPlanRecord(sessionManager, { clear: true });
		expect(resolveCurrentPlanState(sessionManager)).toEqual({
			status: "inactive",
			operation: { clear: true },
		});

		appendCurrentPlanRecord(sessionManager, {
			plan: [{ id: "older-active-plan", step: "Older active plan", status: "in_progress" }],
		});
		sessionManager.appendCustomEntry(CURRENT_PLAN_CUSTOM_ENTRY_TYPE, {
			plan: [{ id: "malformed-newest", step: "Malformed newest", status: "pending" }],
		});
		expect(resolveCurrentPlanState(sessionManager)).toEqual({ status: "corrupt" });
	});

	it("keeps the standalone tool stateless", async () => {
		const sessionManager = SessionManager.inMemory();
		const tool = createUpdatePlanTool();
		await tool.execute("standalone", {
			plan: [{ id: "standalone", step: "Standalone", status: "in_progress" }],
		});
		expect(sessionManager.getBranch()).toEqual([]);
	});
});
