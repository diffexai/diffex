import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext, uuidv7 } from "@earendil-works/diffex-agent-core";
import type { AssistantMessage } from "@earendil-works/diffex-ai";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { startCodingAgentSpan } from "../telemetry.ts";
import { createAgentActionTool, createAgentsTool, createSpawnAgentTool } from "../tools/subagents.ts";
import type { ChildSnapshotV1 } from "./persistence.ts";
import { reportSubagentRuntimeWarning } from "./runtime-diagnostics.ts";
import type {
	CapturedSubagentSession,
	CaptureSubagentSession,
	CreateSubagentSession,
	SubagentActionResult,
	SubagentBatchResult,
	SubagentBatchWaitOptions,
	SubagentControllerSnapshot,
	SubagentDeliveryBatch,
	SubagentLifecycleEvent,
	SubagentLifecycleListener,
	SubagentPermit,
	SubagentQueryOptions,
	SubagentQueryResult,
	SubagentQueryResultView,
	SubagentResultView,
	SubagentSnapshot,
	SubagentSpawnOrigin,
	SubagentStatus,
	SubagentSummary,
	SubagentTerminalStatus,
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

type DeliveryState = "pending" | "frozen" | "consumed";

interface CoordinatedRun {
	readonly id: number;
	readonly cycleId: number;
	readonly attempt: "initial" | "retry";
	delivery: DeliveryState;
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

interface SubagentRecord {
	id: string;
	name: string;
	task: string;
	status: SubagentStatus;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	finalText?: string;
	error?: string;
	session?: AgentSession;
	run?: Promise<void>;
	createSession?: CreateSubagentSession;
	runController?: AbortController;
	runCancellation?: Promise<void>;
	interruptionRequested?: boolean;
	actionTail?: Promise<void>;
	cleanupFailures?: unknown[];
	coordinatedRun?: CoordinatedRun;
	lastRetryCycleId?: number;
	telemetryContext?: TelemetryContext;
	sessionManager?: CapturedSubagentSession["sessionManager"];
	persistenceConfig?: CapturedSubagentSession["config"];
	persistenceError?: string;
	runtimeWarning?: string;
	persistedChildSessionId?: string;
	persistedChildLeafId?: string | null;
	persistable?: boolean;
	prepareWake?: PrepareSubagentWake;
	leafUnsubscribe?: () => void;
}

export interface PreparedSubagentWake extends CapturedSubagentSession {
	readonly warning?: string;
}

export type PrepareSubagentWake = () => Promise<PreparedSubagentWake>;

function isTerminalStatus(status: SubagentStatus): status is SubagentTerminalStatus {
	return status === "idle" || status === "failed" || status === "interrupted";
}

function captureSpawnOrigin(parent: AgentSession, toolCallId: string): SubagentSpawnOrigin {
	if (!parent.isStreaming) {
		return Object.freeze({
			type: "direct_tool_call",
			toolCallId,
			contextEntryId: null,
		});
	}

	const matchingEntries = parent.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(content) => content.type === "toolCall" && content.id === toolCallId && content.name === "spawn_agent",
				),
		);
	if (matchingEntries.length !== 1) {
		throw new Error(
			`Invariant violation: active spawn_agent call ${toolCallId} matched ${matchingEntries.length} persisted assistant entries`,
		);
	}

	const assistantEntry = matchingEntries[0];
	return Object.freeze({
		type: "agent_tool_call",
		toolCallId,
		assistantEntryId: assistantEntry.id,
		contextEntryId: assistantEntry.parentId,
	});
}

const MAX_TIMER_MS = 2_147_483_647;

export class SubagentController {
	readonly #maxConcurrent: number;
	readonly #captureSession: CaptureSubagentSession | undefined;
	readonly #persistRoster: ((agents: readonly ChildSnapshotV1[], admission: boolean) => void) | undefined;
	readonly #restoreRoster: ((controller: SubagentController, parent: AgentSession) => void) | undefined;
	readonly #telemetryContext: TelemetryContext;
	readonly #records = new Map<string, SubagentRecord>();
	readonly #listeners = new Set<SubagentLifecycleListener>();
	readonly #waiters = new Set<RevisionWaiter>();
	readonly #permitQueue: PermitRequest[] = [];
	#activePermits = 0;
	#revision = 0;
	#coordinationCycle = 0;
	#runSequence = 0;
	#batchSequence = 0;
	#closed = false;
	#resetting = false;
	#parent: AgentSession | undefined;
	#getIncompatibleParentHooks: (() => readonly string[]) | undefined;
	#deliverEscalation: ((name: string, message: string) => Promise<void>) | undefined;
	#resetPromise: Promise<void> | undefined;
	#resetCleanupPromise: Promise<unknown[]> | undefined;
	#shutdownPromise: Promise<void> | undefined;

	constructor(options: {
		maxConcurrent: number;
		captureSession?: CaptureSubagentSession;
		telemetryContext?: TelemetryContext;
		persistRoster?: (agents: readonly ChildSnapshotV1[], admission: boolean) => void;
		restoreRoster?: (controller: SubagentController, parent: AgentSession) => void;
	}) {
		if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
			throw new RangeError("maxConcurrent must be a positive integer");
		}
		this.#maxConcurrent = options.maxConcurrent;
		this.#captureSession = options.captureSession;
		this.#telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
		this.#persistRoster = options.persistRoster;
		this.#restoreRoster = options.restoreRoster;
	}

	createToolDefinitions(): ToolDefinition[] {
		const definitions = [
			createSpawnAgentTool(
				(name, task, toolCallId) => {
					const parent = this.#getBoundParent();
					this.#assertReservable(name);
					const origin = captureSpawnOrigin(parent, toolCallId);
					const captured = this.#captureSession?.(parent, name, origin);
					if (!captured) {
						throw new Error("Subagent session capture is unavailable");
					}
					this.spawn(name, task, captured.createSession, origin, parent.agent.telemetryContext, captured);
				},
				() => this.#assertParentPolicyCompatible(),
			),
			createAgentActionTool((request) => {
				const parent = this.#getBoundParent();
				return request.action === "message"
					? this.message(request.target, request.message, request.wake, parent.isStreaming)
					: this.interrupt(request.target);
			}),
			createAgentsTool(async (options) => {
				const result = await this.queryAgents(options);
				this.#consumeTerminalQueryResults(result);
				return result;
			}),
		];
		return definitions.map((definition) => definition as unknown as ToolDefinition);
	}

	bindParent(
		session: AgentSession,
		getIncompatibleParentHooks: () => readonly string[],
		deliverEscalation?: (name: string, message: string) => Promise<void>,
	): void {
		this.#assertOpen();
		if (this.#parent) {
			throw new Error("Subagent controller parent is already bound");
		}
		this.#parent = session;
		this.#getIncompatibleParentHooks = getIncompatibleParentHooks;
		this.#deliverEscalation = deliverEscalation;
	}

	beginCoordinationCycle(): void {
		this.#assertOpen();
		this.#coordinationCycle += 1;
	}

	reserve(name: string, task: string): void {
		this.#assertReservable(name);

		const timestamp = Date.now();
		const record: SubagentRecord = {
			id: uuidv7(),
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
	}

	restore(snapshot: ChildSnapshotV1, prepareWake: PrepareSubagentWake, isolationError?: string): void {
		this.#assertReservable(snapshot.name);
		const interrupted = snapshot.status === "queued" || snapshot.status === "running";
		const isolated = isolationError !== undefined;
		const timestamp = interrupted || isolated ? Date.now() : snapshot.updatedAt;
		this.#records.set(snapshot.name, {
			id: uuidv7(),
			name: snapshot.name,
			task: snapshot.task,
			status: isolated ? "failed" : interrupted ? "interrupted" : snapshot.status,
			createdAt: snapshot.createdAt,
			updatedAt: timestamp,
			...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
			...(interrupted || isolated
				? { completedAt: timestamp }
				: snapshot.completedAt === undefined
					? {}
					: { completedAt: snapshot.completedAt }),
			...(snapshot.result === undefined ? {} : { finalText: snapshot.result }),
			...((isolationError ?? snapshot.error) === undefined ? {} : { error: isolationError ?? snapshot.error }),
			persistenceConfig: snapshot.config,
			persistedChildSessionId: snapshot.childSessionId,
			persistedChildLeafId: snapshot.childLeafId,
			persistable: true,
			prepareWake,
		});
	}

	restoreIsolated(name: string, error: string, prepareWake: PrepareSubagentWake): void {
		this.#assertReservable(name);
		const timestamp = Date.now();
		this.#records.set(name, {
			id: uuidv7(),
			name,
			task: "Persisted subagent restoration failed",
			status: "failed",
			createdAt: timestamp,
			updatedAt: timestamp,
			completedAt: timestamp,
			error,
			persistable: false,
			prepareWake,
		});
	}

	spawn(
		name: string,
		task: string,
		createSession: CreateSubagentSession,
		origin?: SubagentSpawnOrigin,
		telemetryContext: TelemetryContext = this.#telemetryContext,
		captured?: CapturedSubagentSession,
	): void {
		this.#assertParentPolicyCompatible();
		this.#assertReservable(name);
		if (this.#persistRoster && !captured) {
			throw new Error("Persistent subagent admission requires captured session state");
		}

		const timestamp = Date.now();
		const record: SubagentRecord = {
			id: uuidv7(),
			name,
			task,
			status: "queued",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		record.createSession = createSession;
		record.telemetryContext = telemetryContext;
		record.sessionManager = captured?.sessionManager;
		record.persistenceConfig = captured?.config;
		if (origin?.type === "agent_tool_call") {
			record.coordinatedRun = this.#createCoordinatedRun("initial");
		}
		this.#records.set(name, record);
		try {
			this.#persistRoster?.(this.#createPersistenceSnapshot(), true);
		} catch (error) {
			this.#records.delete(name);
			throw error;
		}
		this.#publish((revision) => ({
			type: "subagent_reserved",
			revision,
			name,
			status: "queued",
			timestamp,
		}));
		void startCodingAgentSpan(
			telemetryContext,
			"diffex.coding_agent.subagent",
			{
				"diffex.subagent.id": record.id,
				"diffex.subagent.name": record.name,
				"diffex.subagent.action": "spawn",
			},
			(span) => {
				span.setAttributes({ "diffex.subagent.outcome": "queued" });
			},
		);
		this.#scheduleRun(record, task);
	}

	message(name: string, message: string, wake = false, coordinated = false): Promise<SubagentActionResult> {
		if (message.trim().length === 0) {
			return Promise.reject(new Error("Subagent message must be non-empty"));
		}
		return this.#serializeAction(name, () =>
			this.#traceAction(name, "message", () => this.#message(name, message, wake, coordinated)),
		);
	}

	interrupt(name: string): Promise<SubagentActionResult> {
		return this.#serializeAction(name, () => this.#traceAction(name, "interrupt", () => this.#interrupt(name)));
	}

	attachSession(name: string, session: AgentSession): void {
		const record = this.#getRecordForUpdate(name);
		if (!record) return;
		if (record.session) {
			throw new Error(`Subagent session already attached: ${name}`);
		}
		record.session = session;
		record.sessionManager = session.sessionManager;
		record.leafUnsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end" && event.type !== "entry_appended") return;
			queueMicrotask(() => this.#persistLeafChange(name));
		});
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

	getSummaries(): readonly SubagentSummary[] {
		const summaries = [...this.#records.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((record) =>
				Object.freeze({
					name: record.name,
					status: record.status,
					task: record.task,
				}),
			);
		return Object.freeze(summaries);
	}

	freezeUnconsumedBatch(): SubagentDeliveryBatch | undefined {
		if (this.#closed || this.#resetting) return undefined;
		const attempts = [...this.#records.values()]
			.flatMap((record) => {
				const run = record.coordinatedRun;
				if (!run || run.delivery !== "pending") return [];
				run.delivery = "frozen";
				return [{ name: record.name, runId: run.id }];
			})
			.sort((left, right) => left.name.localeCompare(right.name));
		if (attempts.length === 0) return undefined;
		return Object.freeze({
			id: ++this.#batchSequence,
			attempts: Object.freeze(attempts.map((attempt) => Object.freeze(attempt))),
		});
	}

	async waitForBatch(batch: SubagentDeliveryBatch, options: SubagentBatchWaitOptions = {}): Promise<void> {
		const batchTelemetryContext = batch.attempts
			.map((attempt) => this.#records.get(attempt.name)?.telemetryContext)
			.find((context) => context !== undefined);
		return startCodingAgentSpan(
			batchTelemetryContext ?? this.#telemetryContext,
			"diffex.coding_agent.subagent",
			{
				"diffex.subagent.id": `batch:${batch.id}`,
				"diffex.subagent.name": "batch",
				"diffex.subagent.action": "wait",
			},
			async (span) => {
				try {
					await this.#waitForBatch(batch, options);
					span.setAttributes({ "diffex.subagent.outcome": "completed" });
				} catch (error) {
					const interrupted = options.signal?.aborted === true;
					span.setAttributes({ "diffex.subagent.outcome": interrupted ? "interrupted" : "failed" });
					span.setStatus({ status: "error" });
					throw error;
				}
			},
		);
	}

	async #waitForBatch(batch: SubagentDeliveryBatch, options: SubagentBatchWaitOptions): Promise<void> {
		const notified = new Set<string>();
		let snapshot = this.snapshot();
		while (true) {
			if (options.signal?.aborted) throw options.signal.reason;
			for (const attempt of batch.attempts) {
				const run = this.#records.get(attempt.name)?.coordinatedRun;
				if (!run || run.id !== attempt.runId || run.delivery === "consumed") {
					// Explicit query consumption can release a frozen attempt before AgentSession
					// resumes this wait, and a same-child retry can then replace its run identity.
					notified.add(attempt.name);
				}
			}
			const terminal = batch.attempts
				.flatMap((attempt) => {
					if (notified.has(attempt.name)) return [];
					const result = this.#getBatchResult(attempt.name, attempt.runId);
					if (!result) return [];
					const completedAt = this.#records.get(attempt.name)?.completedAt ?? Number.MAX_SAFE_INTEGER;
					return [{ result, completedAt }];
				})
				.sort(
					(left, right) =>
						left.completedAt - right.completedAt || left.result.name.localeCompare(right.result.name),
				);
			for (const { result } of terminal) {
				notified.add(result.name);
				options.onTerminal?.(result);
			}
			if (notified.size === batch.attempts.length) return;

			const wait = await this.waitForChange(snapshot.revision, {
				timeoutMs: MAX_TIMER_MS,
				signal: options.signal,
			});
			if (wait.reason === "disposed" || wait.reason === "reset") {
				throw wait.reason === "disposed" ? this.#closedError() : this.#resetError();
			}
			snapshot = wait.reason === "changed" ? wait.snapshot : this.snapshot();
		}
	}

	consumeBatch(batch: SubagentDeliveryBatch): readonly SubagentBatchResult[] {
		this.#assertOpen();
		const results = batch.attempts.flatMap((attempt) => {
			const record = this.#records.get(attempt.name);
			const run = record?.coordinatedRun;
			if (!record || !run || run.id !== attempt.runId || run.delivery === "consumed") return [];
			if (run.delivery !== "frozen") {
				throw new Error(`Subagent result is not frozen for delivery: ${attempt.name}`);
			}
			const result = this.#getBatchResult(attempt.name, attempt.runId);
			if (!result) {
				throw new Error(`Subagent result is not terminal: ${attempt.name}`);
			}
			run.delivery = "consumed";
			return [result];
		});
		return Object.freeze(results);
	}

	async interruptBatch(batch: SubagentDeliveryBatch): Promise<void> {
		const targets = batch.attempts.flatMap((attempt) => {
			const record = this.#records.get(attempt.name);
			if (!record?.coordinatedRun || record.coordinatedRun.id !== attempt.runId) return [];
			return isTerminalStatus(record.status) ? [] : [record.name];
		});
		const results = await Promise.allSettled(targets.map((target) => this.interrupt(target)));
		const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to interrupt coordinated subagents");
		}
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
			if (wait.reason === "disposed" || wait.reason === "reset") {
				throw wait.reason === "disposed" ? this.#closedError() : this.#resetError();
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
		if (this.#resetting) {
			return Promise.reject(this.#resetError());
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
			} else if (this.#resetting) {
				this.#settleWaiter(waiter, "resolve", { reason: "reset" });
			} else if (this.#revision > afterRevision) {
				this.#settleWaiter(waiter, "resolve", { reason: "changed", snapshot: this.#createSnapshot() });
			}
		});
	}

	shutdown(): Promise<void> {
		if (this.#shutdownPromise) return this.#shutdownPromise;

		let resolveShutdown!: () => void;
		let rejectShutdown!: (reason: unknown) => void;
		const shutdownPromise = new Promise<void>((resolve, reject) => {
			resolveShutdown = resolve;
			rejectShutdown = reject;
		});
		this.#shutdownPromise = shutdownPromise;

		try {
			this.#persistRosterBestEffort(undefined, true);
			this.#closed = true;
			const closedError = this.#closedError();
			this.#rejectPermitQueue(closedError);
			const resetCleanup = this.#resetCleanupPromise;
			const records = this.#detachRecords(closedError);
			this.#parent = undefined;
			this.#getIncompatibleParentHooks = undefined;
			this.#deliverEscalation = undefined;
			const shutdownCleanup = this.#cleanupRecords(records);
			this.#publish(
				(revision) => ({
					type: "subagent_controller_disposed",
					revision,
					timestamp: Date.now(),
				}),
				"disposed",
			);
			this.#listeners.clear();
			void this.#finishShutdown(shutdownCleanup, resetCleanup).then(resolveShutdown, rejectShutdown);
		} catch (error) {
			rejectShutdown(error);
		}
		return shutdownPromise;
	}

	reset(): Promise<void> {
		if (this.#closed) return Promise.reject(this.#closedError());
		if (this.#resetPromise) return this.#resetPromise;

		let resolveReset!: () => void;
		let rejectReset!: (reason: unknown) => void;
		const resetPromise = new Promise<void>((resolve, reject) => {
			resolveReset = resolve;
			rejectReset = reject;
		});
		this.#resetPromise = resetPromise;

		void this.#resetContext().then(resolveReset, rejectReset);
		return resetPromise;
	}

	reconcileBranch(mutateLeaf: () => void): Promise<void> {
		if (this.#closed) return Promise.reject(this.#closedError());
		if (this.#resetting) return Promise.reject(this.#resetError());
		return this.#runContextBoundary(async () => {
			await this.#quiesceActiveRecords();
			if (this.#closed) throw this.#closedError();
			mutateLeaf();
			await this.#replaceRecordsFromSelectedBranch();
		});
	}

	async #resetContext(): Promise<void> {
		try {
			await this.#runContextBoundary(async () => {
				await this.#quiesceActiveRecords();
				if (this.#closed) throw this.#closedError();
				this.#persistRoster?.([], true);
				await this.#clearRecords();
				if (this.#closed) throw this.#closedError();
			});
		} finally {
			this.#resetPromise = undefined;
		}
	}

	async #runContextBoundary(operation: () => Promise<void>): Promise<void> {
		this.#resetting = true;
		this.#rejectPermitQueue(this.#resetError());
		try {
			await operation();
		} finally {
			if (!this.#closed) {
				this.#resetting = false;
				this.#drainPermitQueue();
			}
		}
	}

	async #quiesceActiveRecords(): Promise<void> {
		const activeRecords = [...this.#records.values()].filter(
			(record) => record.status === "queued" || record.status === "running",
		);
		const results = await Promise.allSettled(activeRecords.map((record) => this.#quiesceRecord(record)));
		const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length > 0) throw new AggregateError(failures, "Failed to quiesce subagent controller");
	}

	async #quiesceRecord(record: SubagentRecord): Promise<void> {
		record.session?.clearQueue();
		record.interruptionRequested = true;
		await this.#requestRunCancellation(record, new Error(`Subagent interrupted: ${record.name}`));
		await record.run;
		if (record.status === "queued" || record.status === "running") this.markInterrupted(record.name);
	}

	async #clearRecords(): Promise<void> {
		const records = this.#detachRecords(this.#resetError());
		const cleanup = this.#cleanupRecords(records);
		this.#resetCleanupPromise = cleanup;
		this.#publish(
			(revision) => ({
				type: "subagent_controller_reset",
				revision,
				timestamp: Date.now(),
			}),
			"reset",
		);
		const failures = await cleanup;
		if (this.#resetCleanupPromise === cleanup) this.#resetCleanupPromise = undefined;
		this.#reportCleanupFailures(failures);
	}

	async #replaceRecordsFromSelectedBranch(): Promise<void> {
		await this.#clearRecords();
		if (this.#closed) return;
		this.#resetting = false;
		try {
			this.#restoreRoster?.(this, this.#getBoundParent());
		} catch (error) {
			reportSubagentRuntimeWarning(
				this.#getBoundParent().sessionManager,
				`Subagent roster reconciliation failed: ${normalizeError(error)}`,
			);
		} finally {
			if (!this.#closed) this.#resetting = true;
		}
	}

	#reportCleanupFailures(failures: readonly unknown[]): void {
		if (failures.length === 0 || !this.#parent) return;
		reportSubagentRuntimeWarning(
			this.#parent.sessionManager,
			`Subagent context cleanup failed after reset: ${failures.map(normalizeError).join("; ")}`,
		);
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
		this.#persistRosterBestEffort(name);
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

	#getBoundParent(): AgentSession {
		this.#assertOpen();
		if (!this.#parent) {
			throw new Error("Subagent controller parent is not bound");
		}
		return this.#parent;
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
		const agents = snapshot.agents.flatMap((agent): SubagentQueryResultView[] => {
			if (!targets.has(agent.name)) return [];
			const record = this.#records.get(agent.name);
			if (!record) return [];
			return [
				Object.freeze({
					name: agent.name,
					status: agent.status,
					...(record.coordinatedRun === undefined ? {} : { runId: record.coordinatedRun.id }),
					...(record.finalText === undefined ? {} : { result: record.finalText }),
					...((record.error ?? record.persistenceError ?? record.runtimeWarning) === undefined
						? {}
						: { error: record.error ?? record.persistenceError ?? record.runtimeWarning }),
				}),
			];
		});
		return Object.freeze({ timedOut, agents: Object.freeze(agents) });
	}

	#consumeTerminalQueryResults(result: SubagentQueryResult): void {
		for (const agent of result.agents) {
			if (!isTerminalStatus(agent.status)) continue;
			const run = this.#records.get(agent.name)?.coordinatedRun;
			if (run && run.id === agent.runId) run.delivery = "consumed";
		}
	}

	#createCoordinatedRun(attempt: "initial" | "retry"): CoordinatedRun {
		return {
			id: ++this.#runSequence,
			cycleId: this.#coordinationCycle,
			attempt,
			delivery: "pending",
		};
	}

	#getBatchResult(name: string, runId: number): SubagentBatchResult | undefined {
		const record = this.#records.get(name);
		const run = record?.coordinatedRun;
		if (!record || !run || run.id !== runId || !isTerminalStatus(record.status)) return undefined;
		const retryAvailable = record.status === "failed" && record.lastRetryCycleId !== run.cycleId;
		return Object.freeze({
			name,
			status: record.status,
			attempt: run.attempt,
			retryAvailable,
			...(record.finalText === undefined ? {} : { result: record.finalText }),
			...((record.error ?? record.persistenceError ?? record.runtimeWarning) === undefined
				? {}
				: { error: record.error ?? record.persistenceError ?? record.runtimeWarning }),
		});
	}

	#createPersistenceSnapshot(interruptActive = false): ChildSnapshotV1[] {
		const interruptionTimestamp = interruptActive ? Date.now() : undefined;
		return [...this.#records.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.flatMap((record) => {
				if (record.persistable === false) return [];
				const config = record.persistenceConfig;
				const sessionManager = record.sessionManager;
				const childSessionId = sessionManager ? sessionManager.getSessionId() : record.persistedChildSessionId;
				const childLeafId = sessionManager ? sessionManager.getLeafId() : record.persistedChildLeafId;
				if (!config || !childSessionId || childLeafId === undefined) {
					throw new Error(`Persistent subagent state is unavailable: ${record.name}`);
				}
				const interrupted = interruptActive && (record.status === "queued" || record.status === "running");
				const snapshotTimestamp = interruptionTimestamp ?? record.updatedAt;
				const error = record.error ?? record.persistenceError;
				return [
					{
						name: record.name,
						task: record.task,
						status: interrupted ? "interrupted" : record.status,
						createdAt: record.createdAt,
						updatedAt: interrupted ? snapshotTimestamp : record.updatedAt,
						...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
						...(interrupted
							? { completedAt: snapshotTimestamp }
							: record.completedAt === undefined
								? {}
								: { completedAt: record.completedAt }),
						...(record.finalText === undefined ? {} : { result: record.finalText }),
						...(error === undefined ? {} : { error }),
						childSessionId,
						childLeafId,
						config,
					},
				];
			});
	}

	#persistRosterBestEffort(changedName?: string, interruptActive = false): void {
		if (!this.#persistRoster || this.#records.size === 0) return;
		try {
			const snapshot = this.#createPersistenceSnapshot(interruptActive);
			if (snapshot.length === 0) return;
			this.#persistRoster(snapshot, false);
		} catch (error) {
			const message = `Subagent roster persistence failed: ${normalizeError(error)}`;
			if (changedName) {
				const record = this.#records.get(changedName);
				if (record) record.persistenceError = message;
				return;
			}
			for (const record of this.#records.values()) {
				if (record.status === "queued" || record.status === "running") {
					record.persistenceError = message;
				}
			}
		}
	}

	#persistLeafChange(name: string): void {
		if (this.#closed || this.#resetting || !this.#records.has(name)) return;
		this.#persistRosterBestEffort(name);
	}

	#queryConditionMet(agents: readonly SubagentResultView[], until: "any" | "all"): boolean {
		return until === "any"
			? agents.some((agent) => isTerminalStatus(agent.status))
			: agents.every((agent) => isTerminalStatus(agent.status));
	}

	#publish(createEvent: (revision: number) => SubagentLifecycleEvent, settleReason?: "disposed" | "reset"): void {
		this.#revision += 1;
		const event = Object.freeze(createEvent(this.#revision));
		if (settleReason) {
			for (const waiter of [...this.#waiters]) {
				this.#settleWaiter(waiter, "resolve", { reason: settleReason });
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
		if (this.#closed || this.#resetting) {
			request.reject(this.#closed ? this.#closedError() : this.#resetError());
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
		while (!this.#closed && !this.#resetting && this.#activePermits < this.#maxConcurrent) {
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

	#traceAction(
		name: string,
		action: "message" | "interrupt",
		callback: () => Promise<SubagentActionResult>,
	): Promise<SubagentActionResult> {
		const record = this.#getRecordForAction(name);
		return startCodingAgentSpan(
			record.telemetryContext ?? this.#telemetryContext,
			"diffex.coding_agent.subagent",
			{
				"diffex.subagent.id": record.id,
				"diffex.subagent.name": record.name,
				"diffex.subagent.action": action,
			},
			async (span) => {
				try {
					const result = await callback();
					span.setAttributes({
						"diffex.subagent.outcome":
							result.status === "failed"
								? "failed"
								: result.status === "interrupted"
									? "interrupted"
									: result.status === "queued"
										? "queued"
										: "completed",
					});
					return result;
				} catch (error) {
					span.setAttributes({ "diffex.subagent.outcome": "failed" });
					span.setStatus({ status: "error" });
					throw error;
				}
			},
		);
	}

	async #message(name: string, message: string, wake: boolean, coordinated: boolean): Promise<SubagentActionResult> {
		const record = this.#getRecordForAction(name);
		while (record.status === "queued" && record.session) {
			const snapshot = this.snapshot();
			if (record.status !== "queued") break;
			const wait = await this.waitForChange(snapshot.revision, { timeoutMs: MAX_TIMER_MS });
			if (wait.reason === "disposed" || wait.reason === "reset") {
				throw wait.reason === "disposed" ? this.#closedError() : this.#resetError();
			}
		}
		while (record.status === "running" && record.session?.isIdle) {
			await record.run;
			this.#assertOpen();
		}
		if (wake && isTerminalStatus(record.status) && record.coordinatedRun?.delivery === "frozen") {
			throw new Error(`Cannot wake subagent while its coordinated result is pending delivery: ${name}`);
		}

		if (record.status === "queued") {
			throw new Error(`Cannot message queued subagent: ${name}`);
		}
		if (!record.session && record.prepareWake) {
			if (!wake) throw new Error(`Cannot message restored subagent without wake: ${name}`);
			const prepared = await record.prepareWake();
			record.createSession = prepared.createSession;
			record.sessionManager = prepared.sessionManager;
			record.persistenceConfig = prepared.config;
			record.persistedChildSessionId = prepared.sessionManager.getSessionId();
			record.persistedChildLeafId = prepared.sessionManager.getLeafId();
			record.persistable = true;
			record.runtimeWarning = prepared.warning;
			record.prepareWake = undefined;
		}
		if (record.status === "failed" || record.status === "interrupted") {
			if (!wake) {
				throw new Error(`Cannot message ${record.status} subagent without wake: ${name}`);
			}
			if (coordinated && record.status === "failed" && record.coordinatedRun) {
				if (record.lastRetryCycleId === this.#coordinationCycle) {
					throw new Error(`Subagent retry limit reached for this parent prompt cycle: ${name}`);
				}
				record.lastRetryCycleId = this.#coordinationCycle;
				record.coordinatedRun = this.#createCoordinatedRun("retry");
			} else {
				record.coordinatedRun = undefined;
			}
			this.#scheduleRun(record, message);
			return { target: name, action: "message", status: "queued", delivery: "prompt" };
		}
		if (record.status === "idle" && wake) {
			record.coordinatedRun = undefined;
			this.#scheduleRun(record, message);
			return { target: name, action: "message", status: "queued", delivery: "prompt" };
		}

		const session = record.session;
		if (!session) {
			throw new Error(`Subagent session is unavailable: ${name}`);
		}
		if (record.status === "idle") {
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
		try {
			await this.#requestRunCancellation(record, new Error(`Subagent interrupted: ${name}`));
		} catch {
			// The captured run still determines the settled controller state.
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
		record.runCancellation = undefined;
		const run = this.#runPrompt(record, prompt, runController);
		record.run = run;
		void run.catch(() => {});
	}

	async #runPrompt(record: SubagentRecord, prompt: string, runController: AbortController): Promise<void> {
		const action = record.coordinatedRun?.attempt === "retry" ? "retry" : "run";
		await startCodingAgentSpan(
			record.telemetryContext ?? this.#telemetryContext,
			"diffex.coding_agent.subagent",
			{
				"diffex.subagent.id": record.id,
				"diffex.subagent.name": record.name,
				"diffex.subagent.action": action,
			},
			async (span) => {
				await this.#runPromptInner(record, prompt, runController);
				const outcome =
					record.status === "failed"
						? "failed"
						: record.status === "interrupted"
							? "interrupted"
							: record.status === "queued"
								? "queued"
								: "completed";
				span.setAttributes({ "diffex.subagent.outcome": outcome });
				if (outcome === "failed" || outcome === "interrupted") {
					span.setStatus({ status: "error" });
				}
			},
		);
	}

	async #runPromptInner(record: SubagentRecord, prompt: string, runController: AbortController): Promise<void> {
		let permit: SubagentPermit | undefined;
		let session = record.session;
		let createdSession: AgentSession | undefined;
		const assistantMessages: AssistantMessage[] = [];
		let unsubscribe: (() => void) | undefined;
		try {
			permit = await this.acquirePermit(runController.signal);
			if (!session) {
				const createSession = record.createSession;
				if (!createSession) {
					throw new Error(`Subagent session factory is unavailable: ${record.name}`);
				}
				session = await createSession(runController.signal, (message) =>
					this.#routeEscalation(record, createdSession, message),
				);
				createdSession = session;
				if (this.#closed || this.#resetting || runController.signal.aborted) {
					try {
						await session.dispose();
					} catch (error) {
						record.cleanupFailures ??= [];
						record.cleanupFailures.push(error);
					}
					if (!this.#closed && !this.#resetting && record.interruptionRequested) {
						this.markInterrupted(record.name);
					}
					return;
				}
				this.attachSession(record.name, session);
			}

			runController.signal.throwIfAborted();
			const activeSession = session;
			let running = false;
			unsubscribe = activeSession.subscribe((event) => {
				if (event.type === "agent_start" && !running) {
					running = true;
					if (runController.signal.aborted) {
						void activeSession.abort().catch(() => {});
					} else {
						this.markRunning(record.name);
					}
				}
				if (event.type === "message_end" && event.message.role === "assistant") {
					assistantMessages.push(event.message);
				}
			});
			await activeSession.prompt(prompt, { signal: runController.signal });
			if (this.#closed) return;

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
				const finalText = getAssistantText(assistantMessages.at(-1));
				if (record.interruptionRequested) {
					this.markInterrupted(record.name, finalText);
				} else {
					this.markFailed(record.name, normalizeError(error), finalText);
				}
			}
		} finally {
			unsubscribe?.();
			permit?.release();
			if (record.runController === runController) {
				record.runController = undefined;
			}
		}
	}

	async #routeEscalation(record: SubagentRecord, session: AgentSession | undefined, message: string): Promise<void> {
		this.#assertOpen();
		if (!this.#parent || !this.#deliverEscalation) {
			throw new Error("Subagent parent escalation delivery is unavailable");
		}
		if (this.#records.get(record.name) !== record || !session || record.session !== session) {
			throw new Error("Subagent escalation capability is stale");
		}
		if (record.status !== "running") {
			throw new Error(`Subagent cannot escalate while ${record.status}: ${record.name}`);
		}
		await this.#deliverEscalation(record.name, message);
	}

	#rejectPermitQueue(error: Error): void {
		for (const request of this.#permitQueue.splice(0)) {
			if (request.signal && request.onAbort) {
				request.signal.removeEventListener("abort", request.onAbort);
			}
			request.reject(error);
		}
	}

	#detachRecords(reason: Error): SubagentRecord[] {
		const records = [...this.#records.values()];
		for (const record of records) {
			void this.#requestRunCancellation(record, reason);
		}
		this.#records.clear();
		return records;
	}

	#requestRunCancellation(record: SubagentRecord, reason: Error): Promise<void> {
		if (record.runCancellation) return record.runCancellation;

		let cancellation: Promise<void>;
		// AgentSession marks streaming before awaiting agent_start hooks, while this record can still be queued.
		if (record.runController && !record.session?.isStreaming) {
			record.runController.abort(reason);
			cancellation = Promise.resolve();
		} else if (record.session) {
			try {
				cancellation = record.session.abort();
			} catch (error) {
				cancellation = Promise.reject(error);
			}
		} else {
			record.runController?.abort(reason);
			cancellation = Promise.resolve();
		}

		record.runCancellation = cancellation;
		void cancellation.catch(() => {
			if (record.runCancellation === cancellation) {
				record.runCancellation = undefined;
			}
		});
		return cancellation;
	}

	async #cleanupRecords(records: SubagentRecord[]): Promise<unknown[]> {
		const failures: unknown[] = [];
		for (const record of records) record.leafUnsubscribe?.();
		for (const record of records) {
			const session = record.session;
			if (session) {
				try {
					session.clearQueue();
				} catch (error) {
					failures.push(error);
				}
			}
		}
		const abortResults = await Promise.allSettled(records.map((record) => record.runCancellation));
		for (const result of abortResults) {
			if (result.status === "rejected") failures.push(result.reason);
		}

		await Promise.allSettled([
			...records.flatMap((record) => (record.actionTail ? [record.actionTail] : [])),
			...records.flatMap((record) => (record.run ? [record.run] : [])),
		]);
		for (const record of records) {
			failures.push(...(record.cleanupFailures ?? []));
		}

		const disposeResults = await Promise.allSettled(
			records.flatMap((record) => {
				const session = record.session;
				if (!session) return [];
				try {
					return [session.dispose()];
				} catch (error) {
					return [Promise.reject(error)];
				}
			}),
		);
		for (const result of disposeResults) {
			if (result.status === "rejected") failures.push(result.reason);
		}
		return failures;
	}

	async #finishShutdown(shutdownCleanup: Promise<unknown[]>, resetCleanup?: Promise<unknown[]>): Promise<void> {
		const [resetFailures, shutdownFailures] = await Promise.all([
			resetCleanup ?? Promise.resolve([]),
			shutdownCleanup,
		]);
		const failures = [...resetFailures, ...shutdownFailures];
		if (failures.length > 0) {
			throw new AggregateError(failures, "Failed to shut down subagent controller");
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw this.#closedError();
		if (this.#resetting) throw this.#resetError();
	}

	#assertParentPolicyCompatible(): void {
		const incompatibleHooks = this.#getIncompatibleParentHooks?.() ?? [];
		if (incompatibleHooks.length === 0) return;
		throw new Error(
			`Cannot spawn a subagent while parent extensions register incompatible hooks: ${incompatibleHooks.join(", ")}. Remove those hooks or disable subagents for this session.`,
		);
	}

	#assertReservable(name: string): void {
		this.#assertOpen();
		if (!SUBAGENT_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid subagent name: ${name}`);
		}
		if (this.#records.has(name)) {
			throw new Error(`Subagent already reserved: ${name}`);
		}
	}

	#resetError(): Error {
		return new Error("Subagent controller is resetting");
	}

	#closedError(): Error {
		return new Error("Subagent controller is shut down");
	}
}
