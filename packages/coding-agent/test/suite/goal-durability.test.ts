import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readGoalMode } from "../../src/core/pocket-context.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

it("persists a goal toggle before the first assistant response", async () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-goal-durable-"));
	const manager = SessionManager.create(directory, directory);
	const harness = await createHarness({ sessionManager: manager });
	try {
		await harness.session.setGoalModeEnabled(true);
		const path = manager.getSessionFile();
		expect(path).toBeDefined();
		if (!path) throw new Error("Missing session path");
		expect(existsSync(path)).toBe(true);
		expect(readGoalMode(SessionManager.open(path).getBranch())).toBe(true);
		const leaf = manager.getLeafId();
		if (!leaf) throw new Error("Missing goal-mode entry");
		const branchPath = manager.createBranchedSession(leaf);
		expect(branchPath).toBeDefined();
		if (!branchPath) throw new Error("Missing branch path");
		expect(existsSync(branchPath)).toBe(true);
		expect(readGoalMode(SessionManager.open(branchPath).getBranch())).toBe(true);
	} finally {
		await harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
