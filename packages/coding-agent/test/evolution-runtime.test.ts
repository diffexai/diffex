import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvolutionControlService } from "#evolution";
import {
	type CodingAgentEvolutionRuntime,
	createCodingAgentEvolutionRuntime,
	EvolutionRuntimeCoordinator,
} from "../src/core/evolution-runtime.ts";
import type { InvocationTrace } from "../src/core/invocation-trace.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("coding-agent evolution runtime", () => {
	const harnesses: Harness[] = [];
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		while (temporaryDirectories.length > 0) {
			const path = temporaryDirectories.pop();
			if (path) rmSync(path, { recursive: true, force: true });
		}
	});

	it("composes a repository-scoped control service without evidence", async () => {
		const agentDir = join(tmpdir(), `diffex-evolution-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		temporaryDirectories.push(agentDir);
		const store = new HarnessStateStore(agentDir);
		const bundle = await store.initialize();
		const harness = await createHarness({ harnessStateStore: store, harnessVersionBundle: bundle });
		harnesses.push(harness);
		const runtime = await createCodingAgentEvolutionRuntime({
			agentDir,
			cwd: harness.tempDir,
			session: harness.session,
			harnessState: store,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
		});
		await runtime.start();

		try {
			const state = await runtime.control.overview();
			expect(state.currentHarnessVersion).toBe(bundle.manifest.version);
			expect(state.settledInvocationCount).toBe(0);
			expect(await runtime.control.startManual()).toEqual({ status: "not-created", reason: "no-new-evidence" });
		} finally {
			await runtime.stop();
		}
	});

	it("flushes the trace before scheduling an automatic eligibility check", async () => {
		const order: string[] = [];
		const trace = {
			operationSettled: vi.fn(async () => {
				order.push("trace");
			}),
			harnessActivated: vi.fn(async () => {}),
		} as unknown as InvocationTrace;
		const control = {
			subscribe: () => () => {},
		} as unknown as EvolutionControlService;
		const runtime: CodingAgentEvolutionRuntime = {
			control,
			start: vi.fn(async () => {}),
			evaluateAutomatic: () => order.push("automatic"),
			stop: vi.fn(async () => {}),
		};
		const coordinator = new EvolutionRuntimeCoordinator(trace);
		await coordinator.replace(runtime);
		expect(runtime.start).toHaveBeenCalledOnce();

		await coordinator.operationSettled({
			operationId: "operation-1",
			sessionManager: {} as never,
			firstEntryOrdinal: 0,
		});

		expect(order).toEqual(["trace", "automatic"]);
		await coordinator.stop();
		expect(runtime.stop).toHaveBeenCalledOnce();
	});
});
