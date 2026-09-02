import { describe, expect, it } from "vitest";
import {
	EvolutionBackgroundWorker,
	type EvolutionJob,
	type EvolutionJobStore,
	type EvolutionWorkSource,
	PollingEvolutionWorkSource,
} from "../src/index.ts";

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

const scope = { repositoryId: "repository", scopeId: "workspace-a" };

describe("evolution background worker", () => {
	it("does not resume interrupted work without an explicit request", async () => {
		let listedScope: typeof scope | undefined;
		const jobs: EvolutionJobStore = {
			async create() {},
			async save() {},
			async load() {
				return null;
			},
			async list(requestedScope) {
				listedScope = requestedScope;
				return [
					{
						jobId: "job-interrupted",
						outcome: "interrupted",
						resolution: null,
						stage: "reflecting",
						retryNotBefore: null,
						trigger: "manual",
						createdAt: "2026-08-19T12:00:00.000Z",
					} as EvolutionJob,
				];
			},
		};
		const source = new PollingEvolutionWorkSource(
			jobs,
			{
				now: () => "2026-08-20T12:00:00.000Z",
			},
			scope,
		);

		expect(await source.nextRunnableJob("2026-08-20T12:00:00.000Z")).toBeNull();
		expect(listedScope).toEqual(scope);
	});

	it("admits durable work only after the interactive priority gate", async () => {
		const order: string[] = [];
		const worker = new EvolutionBackgroundWorker({
			clock: { now: () => "2026-08-19T12:00:00.000Z" },
			source: {
				async nextRunnableJob() {
					order.push("dequeue");
					return "job-1";
				},
				async waitForWork() {},
			},
			runner: {
				async runJob() {
					order.push("run");
					return {} as never;
				},
			},
			priority: {
				async waitUntilBackgroundAllowed() {
					order.push("priority");
				},
			},
		});

		expect(await worker.runOnce(new AbortController().signal)).toBe("ran");
		expect(order).toEqual(["dequeue", "priority", "run"]);
	});

	it("cancels an independently running idle worker during shutdown", async () => {
		let waiting = false;
		const source: EvolutionWorkSource = {
			async nextRunnableJob() {
				return null;
			},
			async waitForWork(signal) {
				waiting = true;
				await waitForAbort(signal);
			},
		};
		const worker = new EvolutionBackgroundWorker({
			clock: { now: () => "2026-08-19T12:00:00.000Z" },
			source,
			runner: {
				async runJob() {
					throw new Error("No job should run");
				},
			},
			priority: { async waitUntilBackgroundAllowed() {} },
		});

		worker.start();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(waiting).toBe(true);
		await expect(worker.stop()).resolves.toBeUndefined();
	});
});
