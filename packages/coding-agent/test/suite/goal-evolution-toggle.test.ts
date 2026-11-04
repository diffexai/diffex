import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EvolutionRuntimeCoordinator } from "../../src/core/evolution-runtime.ts";
import { createInvocationTrace } from "../../src/core/invocation-trace.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

it("requires leaving goal mode before enabling evolution in this session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-goal-evolution-toggle-"));
	const manager = SessionManager.inMemory(directory);
	const { trace } = await createInvocationTrace({ agentDir: directory, sessionManager: manager, enabled: false });
	let enabled = false;
	const updates: boolean[] = [];
	const coordinator = new EvolutionRuntimeCoordinator(trace, {
		getEnabled: () => enabled,
		setEnabled: (value) => {
			enabled = value;
			updates.push(value);
		},
	});
	const harness = await createHarness({ sessionManager: manager, lifecycleObserver: coordinator });
	try {
		await harness.session.setGoalModeEnabled(true);
		expect(coordinator.getGoalSuspended()).toBe(true);
		await expect(coordinator.setEnabled(true)).rejects.toThrow("Disable /goal before enabling self-evolution.");
		expect(enabled).toBe(false);
		expect(updates).toEqual([]);
		await coordinator.setEnabled(false);
		await harness.session.setGoalModeEnabled(false);
		await coordinator.setEnabled(true);
		expect(enabled).toBe(true);
		expect(updates).toEqual([true]);
	} finally {
		await harness.cleanup();
		await coordinator.stop();
		await trace.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("retains an external preference change while goal mode is active", async () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-goal-evolution-preference-"));
	const manager = SessionManager.inMemory(directory);
	const { trace } = await createInvocationTrace({ agentDir: directory, sessionManager: manager, enabled: false });
	let enabled = false;
	const coordinator = new EvolutionRuntimeCoordinator(trace, {
		getEnabled: () => enabled,
		setEnabled: (value) => {
			enabled = value;
		},
	});
	const harness = await createHarness({ sessionManager: manager, lifecycleObserver: coordinator });
	try {
		await harness.session.setGoalModeEnabled(true);
		enabled = true;
		await expect(coordinator.setEnabled(true)).rejects.toThrow("Disable /goal before enabling self-evolution.");
		await coordinator.synchronizeEnabled();
		expect(coordinator.getGoalSuspended()).toBe(true);
		await harness.session.setGoalModeEnabled(false);
		expect(coordinator.getEnabled()).toBe(true);
	} finally {
		await harness.cleanup();
		await coordinator.stop();
		await trace.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
