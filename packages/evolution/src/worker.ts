import type {
	EvolutionClock,
	EvolutionJobRunner,
	EvolutionJobStore,
	EvolutionWorkSource,
	InteractivePriorityGate,
} from "./ports.ts";

const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_FAILURE_BACKOFF_MS = 5_000;

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Evolution background worker stopped");
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export interface PollingEvolutionWorkSourceOptions {
	readonly pollIntervalMs?: number;
}

export class PollingEvolutionWorkSource implements EvolutionWorkSource {
	readonly #jobs: EvolutionJobStore;
	readonly #clock: EvolutionClock;
	readonly #pollIntervalMs: number;

	constructor(jobs: EvolutionJobStore, clock: EvolutionClock, options: PollingEvolutionWorkSourceOptions = {}) {
		this.#jobs = jobs;
		this.#clock = clock;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IDLE_POLL_MS;
		if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs < 1) {
			throw new Error("pollIntervalMs must be positive");
		}
	}

	async nextRunnableJob(now: string, signal?: AbortSignal): Promise<string | null> {
		signal?.throwIfAborted();
		const nowMs = Date.parse(now);
		if (!Number.isFinite(nowMs)) throw new Error("Evolution worker time must be a valid ISO timestamp");
		const jobs = (await this.#jobs.list())
			.filter(
				(job) =>
					job.resolution === null &&
					job.outcome === "active" &&
					job.stage !== "completed" &&
					(job.retryNotBefore === null || Date.parse(job.retryNotBefore) <= nowMs),
			)
			.sort(
				(left, right) =>
					Number(left.trigger === "automatic") - Number(right.trigger === "automatic") ||
					left.createdAt.localeCompare(right.createdAt) ||
					left.jobId.localeCompare(right.jobId),
			);
		signal?.throwIfAborted();
		return jobs[0]?.jobId ?? null;
	}

	waitForWork(signal: AbortSignal): Promise<void> {
		return wait(this.#pollIntervalMs, signal);
	}

	next(signal?: AbortSignal): Promise<string | null> {
		return this.nextRunnableJob(this.#clock.now(), signal);
	}
}

export interface EvolutionBackgroundWorkerDependencies {
	readonly clock: EvolutionClock;
	readonly source: EvolutionWorkSource;
	readonly runner: EvolutionJobRunner;
	readonly priority: InteractivePriorityGate;
}

export interface EvolutionBackgroundWorkerOptions {
	readonly failureBackoffMs?: number;
}

export class EvolutionBackgroundWorker {
	readonly #dependencies: EvolutionBackgroundWorkerDependencies;
	readonly #failureBackoffMs: number;
	#controller: AbortController | null = null;
	#runPromise: Promise<void> | null = null;

	constructor(dependencies: EvolutionBackgroundWorkerDependencies, options: EvolutionBackgroundWorkerOptions = {}) {
		this.#dependencies = dependencies;
		this.#failureBackoffMs = options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
		if (!Number.isFinite(this.#failureBackoffMs) || this.#failureBackoffMs < 0) {
			throw new Error("failureBackoffMs must be non-negative");
		}
	}

	async runOnce(signal: AbortSignal): Promise<"idle" | "ran"> {
		signal.throwIfAborted();
		const jobId = await this.#dependencies.source.nextRunnableJob(this.#dependencies.clock.now(), signal);
		if (jobId === null) return "idle";
		await this.#dependencies.priority.waitUntilBackgroundAllowed(signal);
		signal.throwIfAborted();
		await this.#dependencies.runner.runJob(jobId, signal);
		return "ran";
	}

	start(): void {
		if (this.#runPromise !== null) return;
		const controller = new AbortController();
		this.#controller = controller;
		this.#runPromise = this.#run(controller.signal).finally(() => {
			if (this.#controller === controller) this.#controller = null;
			this.#runPromise = null;
		});
		void this.#runPromise.catch(() => {});
	}

	async #run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const result = await this.runOnce(signal);
				if (result === "idle") await this.#dependencies.source.waitForWork(signal);
			} catch {
				if (signal.aborted) return;
				await wait(this.#failureBackoffMs, signal);
			}
		}
	}

	async stop(reason: unknown = new Error("Evolution background worker stopped")): Promise<void> {
		const runPromise = this.#runPromise;
		if (runPromise === null) return;
		const controller = this.#controller;
		controller?.abort(reason);
		try {
			await runPromise;
		} catch (error) {
			if (!controller?.signal.aborted) throw error;
		}
	}
}
