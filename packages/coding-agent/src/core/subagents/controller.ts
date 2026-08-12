import type { AssistantMessage } from "@earendil-works/diffex-ai";
import type { AgentSession } from "../agent-session.ts";
import type {
	CreateSubagentSession,
	SubagentActionResult,
	SubagentControllerSnapshot,
	SubagentLifecycleEvent,
	SubagentLifecycleListener,
	SubagentPermit,
	SubagentQueryOptions,
	SubagentQueryResult,
	SubagentRecord,
	SubagentResultView,
	SubagentSnapshot,
	SubagentStatus,
	SubagentWaitOptions,
	SubagentWaitResult,
} from "./types.ts";
import { SUBAGENT_NAME_PATTERN } from "./types.ts";

interface PermitRequest {
	readonly resolve: (permit: SubagentPermit) => void;
	readonly reject: (reason: unknown) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
}

interface RevisionWaiter {
	readonly afterRevision: number;
	readonly resolve: (result: SubagentWaitResult) => void;
	readonly reject: (reason: unknown) => void;
	readonly signal?: AbortSignal;
	timer?: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
	settled: boolean;
}

interface TransitionFields {
	readonly finalText?: string;
	readonly error?: string;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return "Unknown subagent error";
	}
}

function getAssistantText(message: AssistantMessage | undefined): string | undefined {
	if (!message) return undefined;
	const text = message.content
		.filter(
			(content): content is Extract<AssistantMessage["content"][number], { type: "text" }> =>
				content.type === "text",
		)
		.map((content) => content.text)
		.join("\n");
	return text.trim().length > 0 ? text : undefined;
}

function getTurnAssistantMessages(session: AgentSession, turnStart: number): AssistantMessage[] {
	return session.messages
		.slice(turnStart)
		.filter((message): message is AssistantMessage => message.role === "assistant");
}

function isTerminalStatus(status: SubagentStatus): boolean {
	return status === "idle" || status === "failed" || status === "interrupted";
}

const MAX_TIMER_MS = 2_147_483_647;

export class SubagentController {
	readonly #maxConcurrent: number;
	readonly #records = new Map<string, SubagentRecord>();
	readonly #listeners = new Set<SubagentLifecycleListener>();
	readonly #waiters = new Set<RevisionWaiter>();
	readonly #permitQueue: PermitRequest[] = [];
	#activePermits = 0;
	#revision = 0;
	#closed = false;
	#shutdownPromise: Promise<void> | undefined;

	constructor(options: { maxConcurrent: number }) {
		if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
			throw new RangeError("maxConcurrent must be a positive integer");
		}
		this.#maxConcurrent = options.maxConcurrent;
	}

	reserve(name: string, task: string): SubagentRecord {
		this.#assertOpen();
		if (!SUBAGENT_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid subagent name: ${name}`);
		}
		if (this.#records.has(name)) {
			throw new Error(`Subagent already reserved: ${name}`);
		}

		const timestamp = Date.now();
		const record: SubagentRecord = {
			name,
			task,
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.#records.set(name, record);
		this.#publish((revision) => ({
			type: "subagent_reserved",
			revision,
			name,
			status: "queued",
			timestamp,
		}));
		return record;
	}

	spawn(name: string, task: string, createSession: CreateSubagentSession): SubagentRecord {
		const record = this.reserve(name, task);
		record.createSession = createSession;
		this.#scheduleRun(record, task);
		return record;
	}

	message(name: string, message: string, wake = false): Promise<SubagentActionResult> {
		if (message.trim().length === 0) {
			return Promise.reject(new Error("Subagent message must be non-empty"));
		}
		return this.#serializeAction(name, () => this.#message(name, message, wake));
	}

	interrupt(name: string): Promise<SubagentActionResult> {
		return this.#serializeAction(name, () => this.#interrupt(name));
	}

	attachSession(name: string, session: AgentSession): void {
		const record = this.#getRecordForUpdate(name);
		if (!record) return;
		if (record.session) {
			throw new Error(`Subagent session already attached: ${name}`);
		}
		record.session = session;
	}

	trackRun(name: string, run: Promise<void>): void {
		const record = this.#getRecordForUpdate(name);
		if (!record) return;
		record.run = run;
		void run.catch(() => {});
	}

	markRunning(name: string): void {
		this.#transition(name, "running");
	}

	markIdle(name: string, finalText?: string): void {
		this.#transition(name, "idle", { finalText });
	}

	markFailed(name: string, error: string, finalText?: string): void {
		this.#transition(name, "failed", { error, finalText });
	}

	markInterrupted(name: string, finalText?: string): void {
		this.#transition(name, "interrupted", { finalText });
	}

	snapshot(): SubagentControllerSnapshot {
		return this.#createSnapshot();
	}

	async queryAgents(options: SubagentQueryOptions): Promise<SubagentQueryResult> {
		if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0) {
			throw new RangeError("timeoutMs must be a non-negative integer");
		}
		if (options.until !== undefined && options.until !== "any" && options.until !== "all") {
			throw new Error(`Invalid subagent query condition: ${String(options.until)}`);
		}
		if (options.signal?.aborted) {
			throw options.signal.reason;
		}
		this.#assertOpen();

		let snapshot = this.snapshot();
		const targets = this.#selectQueryTargets(snapshot, options.targets);
		let result = this.#createQueryResult(false, snapshot, targets);
		if (
			options.timeoutMs === 0 ||
			targets.size === 0 ||
			(options.until !== undefined && this.#queryConditionMet(result.agents, options.until))
		) {
			return result;
		}

		const deadline = performance.now() + options.timeoutMs;
		while (true) {
			const remainingMs = Math.min(deadline - performance.now(), MAX_TIMER_MS);
			if (remainingMs <= 0) {
				this.#assertOpen();
				return this.#createQueryResult(true, this.snapshot(), targets);
			}

			const wait = await this.waitForChange(snapshot.revision, {
				timeoutMs: remainingMs,
				signal: options.signal,
			});
			if (options.signal?.aborted) {
				throw options.signal.reason;
			}
			if (wait.reason === "disposed") {
				throw this.#closedError();
			}
			this.#assertOpen();
			snapshot = this.snapshot();
			result = this.#createQueryResult(false, snapshot, targets);

			if (wait.reason === "timeout") {
				if (performance.now() < deadline) continue;
				return this.#createQueryResult(true, snapshot, targets);
			}
			if (options.until === undefined || this.#queryConditionMet(result.agents, options.until)) {
				return result;
			}
		}
	}

	subscribe(listener: SubagentLifecycleListener): () => void {
		this.#assertOpen();
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	acquirePermit(signal?: AbortSignal): Promise<SubagentPermit> {
		if (this.#closed) {
			return Promise.reject(this.#closedError());
		}
		if (signal?.aborted) {
			return Promise.reject(signal.reason);
		}

		return new Promise<SubagentPermit>((resolve, reject) => {
			const request: PermitRequest = {
				resolve,
				reject,
				signal,
				onAbort: signal
					? () => {
							const index = this.#permitQueue.indexOf(request);
							if (index === -1) return;
							this.#permitQueue.splice(index, 1);
							reject(signal.reason);
						}
					: undefined,
			};

			if (this.#activePermits < this.#maxConcurrent) {
				this.#grantPermit(request);
				return;
			}

			if (signal && request.onAbort) {
				signal.addEventListener("abort", request.onAbort, { once: true });
			}
			this.#permitQueue.push(request);
			if (signal?.aborted && request.onAbort) {
				request.onAbort();
			}
		});
	}

	waitForChange(afterRevision: number, options: SubagentWaitOptions): Promise<SubagentWaitResult> {
		if (!Number.isInteger(afterRevision) || afterRevision < 0) {
			return Promise.reject(new RangeError("afterRevision must be a non-negative integer"));
		}
		if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
			return Promise.reject(new RangeError("timeoutMs must be a non-negative finite number"));
		}
		if (options.signal?.aborted) {
			return Promise.reject(options.signal.reason);
		}

		return new Promise<SubagentWaitResult>((resolve, reject) => {
			const waiter: RevisionWaiter = {
				afterRevision,
				resolve,
				reject,
				signal: options.signal,
				settled: false,
			};
			waiter.onAbort = options.signal
				? () => this.#settleWaiter(waiter, "reject", options.signal?.reason)
				: undefined;
			if (options.signal && waiter.onAbort) {
				options.signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			waiter.timer = setTimeout(() => {
				this.#settleWaiter(waiter, "resolve", { reason: "timeout" });
			}, options.timeoutMs);
			this.#waiters.add(waiter);

			if (this.#closed) {
				this.#settleWaiter(waiter, "resolve", { reason: "disposed" });
			} else if (this.#revision > afterRevision) {
				this.#settleWaiter(waiter, "resolve", { reason: "changed", snapshot: this.#createSnapshot() });
			}
		});
	}

	shutdown(): Promise<void> {
		if (this.#shutdownPromise) return this.#shutdownPromise;

		this.#closed = true;
		const closedError = this.#closedError();
		for (const request of this.#permitQueue.splice(0)) {
			if (request.signal && request.onAbort) {
				request.signal.removeEventListener("abort", request.onAbort);
			}
			request.reject(closedError);
		}

		const records = [...this.#records.values()];
		for (const record of records) {
			record.runController?.abort(closedError);
		}
		this.#records.clear();
		this.#publish(
			(revision) => ({
				type: "subagent_controller_disposed",
				revision,
				timestamp: Date.now(),
			}),
			true,
		);
		this.#listeners.clear();

		this.#shutdownPromise = this.#finishShutdown(records);
		return this.#shutdownPromise;
	}

	#transition(name: string, status: SubagentStatus, fields: TransitionFields = {}): void {
		const record = this.#getRecordForUpdate(name);
		if (!record) return;
		const previousStatus = record.status;
		if (!this.#isValidTransition(previousStatus, status)) {
			throw new Error(`Invalid subagent status transition: ${previousStatus} -> ${status}`);
		}

		const timestamp = Date.now();
		record.status = status;
		record.updatedAt = timestamp;
		if (status === "queued") {
			record.startedAt = undefined;
			record.completedAt = undefined;
			record.finalText = undefined;
			record.error = undefined;
		} else if (status === "running") {
			record.startedAt = timestamp;
			record.completedAt = undefined;
			record.finalText = undefined;
			record.error = undefined;
		} else {
			record.completedAt = timestamp;
			record.finalText = fields.finalText;
			record.error = status === "failed" ? fields.error : undefined;
		}

		this.#publish((revision) => ({
			type: "subagent_status_changed",
			revision,
			name,
			previousStatus,
			status,
			timestamp,
		}));
	}

	#isValidTransition(previousStatus: SubagentStatus, status: SubagentStatus): boolean {
		if (previousStatus === "queued") {
			return status === "running" || status === "failed" || status === "interrupted";
		}
		if (previousStatus === "running") {
			return status === "idle" || status === "failed" || status === "interrupted";
		}
		return status === "queued";
	}

	#getRecordForAction(name: string): SubagentRecord {
		this.#assertOpen();
		if (!SUBAGENT_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid subagent name: ${name}`);
		}
		const record = this.#records.get(name);
		if (!record) {
			throw new Error(`Unknown subagent: ${name}`);
		}
		return record;
	}

	#getRecordForUpdate(name: string): SubagentRecord | undefined {
		if (this.#closed) return undefined;
		const record = this.#records.get(name);
		if (!record) {
			throw new Error(`Unknown subagent: ${name}`);
		}
		return record;
	}

	#createSnapshot(): SubagentControllerSnapshot {
		const agents = [...this.#records.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((record): SubagentSnapshot => {
				const snapshot: SubagentSnapshot = {
					name: record.name,
					status: record.status,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
					...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
				};
				return Object.freeze(snapshot);
			});
		return Object.freeze({ revision: this.#revision, agents: Object.freeze(agents) });
	}

	#selectQueryTargets(snapshot: SubagentControllerSnapshot, requested: readonly string[] | undefined): Set<string> {
		if (requested === undefined) {
			return new Set(snapshot.agents.map((agent) => agent.name));
		}
		if (!Array.isArray(requested) || requested.length === 0) {
			throw new Error("Subagent query targets must be a non-empty array");
		}

		const targets = new Set<string>();
		for (const target of requested) {
			if (typeof target !== "string" || !SUBAGENT_NAME_PATTERN.test(target)) {
				throw new Error(`Invalid subagent name: ${String(target)}`);
			}
			if (targets.has(target)) {
				throw new Error(`Duplicate subagent target: ${target}`);
			}
			if (!this.#records.has(target)) {
				throw new Error(`Unknown subagent: ${target}`);
			}
			targets.add(target);
		}
		return targets;
	}

	#createQueryResult(
		timedOut: boolean,
		snapshot: SubagentControllerSnapshot,
		targets: ReadonlySet<string>,
	): SubagentQueryResult {
		const agents = snapshot.agents.flatMap((agent): SubagentResultView[] => {
			if (!targets.has(agent.name)) return [];
			const record = this.#records.get(agent.name);
			if (!record) return [];
			return [
				Object.freeze({
					name: agent.name,
					status: agent.status,
					...(record.finalText === undefined ? {} : { result: record.finalText }),
					...(record.error === undefined ? {} : { error: record.error }),
				}),
			];
		});
		return Object.freeze({ timedOut, agents: Object.freeze(agents) });
	}

	#queryConditionMet(agents: readonly SubagentResultView[], until: "any" | "all"): boolean {
		return until === "any"
			? agents.some((agent) => isTerminalStatus(agent.status))
			: agents.every((agent) => isTerminalStatus(agent.status));
	}

	#publish(createEvent: (revision: number) => SubagentLifecycleEvent, disposed = false): void {
		this.#revision += 1;
		const event = Object.freeze(createEvent(this.#revision));
		if (disposed) {
			for (const waiter of [...this.#waiters]) {
				this.#settleWaiter(waiter, "resolve", { reason: "disposed" });
			}
		} else {
			const snapshot = this.#createSnapshot();
			for (const waiter of [...this.#waiters]) {
				if (this.#revision > waiter.afterRevision) {
					this.#settleWaiter(waiter, "resolve", { reason: "changed", snapshot });
				}
			}
		}
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// Lifecycle observers must not interrupt controller state publication.
			}
		}
	}

	#settleWaiter(waiter: RevisionWaiter, kind: "resolve" | "reject", value: SubagentWaitResult | unknown): void {
		if (waiter.settled) return;
		waiter.settled = true;
		this.#waiters.delete(waiter);
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		if (kind === "resolve") {
			waiter.resolve(value as SubagentWaitResult);
		} else {
			waiter.reject(value);
		}
	}

	#grantPermit(request: PermitRequest): void {
		if (request.signal && request.onAbort) {
			request.signal.removeEventListener("abort", request.onAbort);
		}
		if (this.#closed) {
			request.reject(this.#closedError());
			return;
		}
		if (request.signal?.aborted) {
			request.reject(request.signal.reason);
			return;
		}

		this.#activePermits += 1;
		let released = false;
		request.resolve(
			Object.freeze({
				release: () => {
					if (released) return;
					released = true;
					this.#activePermits -= 1;
					this.#drainPermitQueue();
				},
			}),
		);
	}

	#drainPermitQueue(): void {
		while (!this.#closed && this.#activePermits < this.#maxConcurrent) {
			const request = this.#permitQueue.shift();
			if (!request) return;
			this.#grantPermit(request);
		}
	}

	#serializeAction(name: string, action: () => Promise<SubagentActionResult>): Promise<SubagentActionResult> {
		const record = this.#getRecordForAction(name);
		const previous = record.actionTail ?? Promise.resolve();
		const result = previous.then(async () => {
			this.#assertOpen();
			return action();
		});
		record.actionTail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	async #message(name: string, message: string, wake: boolean): Promise<SubagentActionResult> {
		const record = this.#getRecordForAction(name);
		while (record.status === "running" && record.session?.isIdle) {
			await record.run;
			this.#assertOpen();
		}

		if (record.status === "queued") {
			throw new Error(`Cannot message queued subagent: ${name}`);
		}
		if (record.status === "failed" || record.status === "interrupted") {
			if (!wake) {
				throw new Error(`Cannot message ${record.status} subagent without wake: ${name}`);
			}
			this.#scheduleRun(record, message);
			return { target: name, action: "message", status: "queued", delivery: "prompt" };
		}

		const session = record.session;
		if (!session) {
			throw new Error(`Subagent session is unavailable: ${name}`);
		}
		if (record.status === "idle") {
			if (wake) {
				this.#scheduleRun(record, message);
				return { target: name, action: "message", status: "queued", delivery: "prompt" };
			}
			await session.followUp(message);
			return { target: name, action: "message", status: "idle", delivery: "follow_up" };
		}

		if (wake) {
			await session.steer(message);
			return { target: name, action: "message", status: "running", delivery: "steer" };
		}
		await session.followUp(message);
		return { target: name, action: "message", status: "running", delivery: "follow_up" };
	}

	async #interrupt(name: string): Promise<SubagentActionResult> {
		const record = this.#getRecordForAction(name);
		while (record.status === "running" && record.session?.isIdle) {
			await record.run;
			this.#assertOpen();
		}

		record.session?.clearQueue();
		if (record.status === "idle" || record.status === "failed" || record.status === "interrupted") {
			return { target: name, action: "interrupt", status: record.status };
		}

		record.interruptionRequested = true;
		const run = record.run;
		if (record.status === "queued") {
			record.runController?.abort(new Error(`Subagent interrupted: ${name}`));
		} else if (record.session) {
			try {
				await record.session.abort();
			} catch {
				// The captured run still determines the settled controller state.
			}
		}
		await run;
		if (record.status === "queued" || record.status === "running") {
			this.markInterrupted(name);
		}
		return { target: name, action: "interrupt", status: record.status };
	}

	#scheduleRun(record: SubagentRecord, prompt: string): void {
		this.#assertOpen();
		if (record.status !== "queued") {
			this.#transition(record.name, "queued");
		}
		record.interruptionRequested = false;
		const runController = new AbortController();
		record.runController = runController;
		const run = this.#runPrompt(record, prompt, runController);
		record.run = run;
		void run.catch(() => {});
	}

	async #runPrompt(record: SubagentRecord, prompt: string, runController: AbortController): Promise<void> {
		let permit: SubagentPermit | undefined;
		let session = record.session;
		let turnStart: number | undefined;
		try {
			permit = await this.acquirePermit(runController.signal);
			if (!session) {
				const createSession = record.createSession;
				if (!createSession) {
					throw new Error(`Subagent session factory is unavailable: ${record.name}`);
				}
				session = await createSession(runController.signal);
				if (this.#closed || runController.signal.aborted) {
					session.dispose();
					if (!this.#closed && record.interruptionRequested) {
						this.markInterrupted(record.name);
					}
					return;
				}
				this.attachSession(record.name, session);
			}

			runController.signal.throwIfAborted();
			this.markRunning(record.name);
			turnStart = session.messages.length;
			await session.prompt(prompt);
			if (this.#closed) return;

			const assistantMessages = getTurnAssistantMessages(session, turnStart);
			const terminalMessage = assistantMessages.at(-1);
			const finalText = getAssistantText(terminalMessage);
			if (record.interruptionRequested) {
				this.markInterrupted(record.name, finalText);
			} else if (!terminalMessage) {
				this.markFailed(record.name, "Subagent prompt completed without an assistant response", finalText);
			} else if (terminalMessage.stopReason === "aborted") {
				this.markInterrupted(record.name, finalText);
			} else if (terminalMessage.stopReason === "error") {
				this.markFailed(record.name, terminalMessage.errorMessage ?? "Subagent provider request failed", finalText);
			} else {
				this.markIdle(record.name, finalText);
			}
		} catch (error) {
			if (!this.#closed) {
				const assistantMessages =
					session && turnStart !== undefined ? getTurnAssistantMessages(session, turnStart) : [];
				const finalText = getAssistantText(assistantMessages.at(-1));
				if (record.interruptionRequested) {
					this.markInterrupted(record.name, finalText);
				} else {
					this.markFailed(record.name, normalizeError(error), finalText);
				}
			}
		} finally {
			permit?.release();
			if (record.runController === runController) {
				record.runController = undefined;
			}
		}
	}

	async #finishShutdown(records: SubagentRecord[]): Promise<void> {
		const failures: unknown[] = [];
		const activeSessions = records.flatMap((record) =>
			record.status === "running" && record.session ? [record.session] : [],
		);
		const abortResults = await Promise.allSettled(
			activeSessions.map(async (session) => {
				await session.abort();
			}),
		);
		for (const result of abortResults) {
			if (result.status === "rejected") failures.push(result.reason);
		}

		await Promise.allSettled(records.flatMap((record) => (record.actionTail ? [record.actionTail] : [])));
		await Promise.allSettled(records.flatMap((record) => (record.run ? [record.run] : [])));

		for (const record of records) {
			if (!record.session) continue;
			try {
				record.session.dispose();
			} catch (error) {
				failures.push(error);
			}
		}

		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to shut down subagent controller");
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw this.#closedError();
	}

	#closedError(): Error {
		return new Error("Subagent controller is shut down");
	}
}
