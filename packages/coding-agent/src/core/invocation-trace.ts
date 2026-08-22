import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	AGENT_RUNTIME_TELEMETRY_SCHEMA,
	AI_TELEMETRY_SCHEMA,
	NOOP_TELEMETRY_CONTEXT,
	type SpanOptions,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/diffex-agent-core";
import { uuidv7 } from "@earendil-works/diffex-ai";
import lockfile from "proper-lockfile";
import { classifyEvolutionEvidence } from "#evolution";
import {
	createJsonlTraceContext,
	type JsonlTraceContext,
	materializeJsonlInvocation,
	type SessionAttachmentReason,
	type TraceTerminationStatus,
} from "#harness-trace";
import { VERSION } from "../config.ts";
import type { AgentSessionLifecycleObserver, InvocationSessionAttachmentReason } from "./agent-session-lifecycle.ts";
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION } from "./session-manager.ts";
import { CODING_AGENT_TELEMETRY_SCHEMA } from "./telemetry.ts";

const TRACE_DIRECTORY_NAME = "traces";
const OPERATION_SPAN_NAME = "diffex.coding_agent.operation";
const OPERATION_ID_ATTRIBUTE = "diffex.operation.id";
const OPERATION_KIND_ATTRIBUTE = "diffex.operation.kind";
export const INVOCATION_TRACE_LOCK_STALE_MS = 30_000;
const INVOCATION_TRACE_LOCK_UPDATE_MS = 10_000;

export interface InvocationTraceCreationResult {
	trace: InvocationTrace;
	diagnostic?: AgentSessionRuntimeDiagnostic;
}

export interface CreateInvocationTraceOptions {
	agentDir: string;
	sessionManager: SessionManager;
	diffexVersion?: string;
	sourceRevision?: string;
	onDiagnostic?: (diagnostic: AgentSessionRuntimeDiagnostic) => void;
}

interface InvocationTraceRecorderHandle {
	recorder: JsonlTraceContext;
	releaseTraceLock: () => Promise<void>;
}

type InvocationTraceRecorderFactory = () => Promise<InvocationTraceRecorderHandle>;

function invocationTracePath(agentDir: string, traceId: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(agentDir, TRACE_DIRECTORY_NAME, `${timestamp}_${traceId}.jsonl`);
}

function sourceRevision(version: string, configuredRevision: string | undefined): string {
	return configuredRevision?.trim() || process.env.DIFFEX_SOURCE_REVISION?.trim() || `release:${version}`;
}

function runtimeIdentity(): { kind: string; version: string } {
	const bunVersion = process.versions.bun;
	return bunVersion ? { kind: "bun", version: bunVersion } : { kind: "node", version: process.versions.node };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function finalTerminationStatus(
	requested: TraceTerminationStatus,
	signalTermination: TraceTerminationStatus | undefined,
): TraceTerminationStatus {
	if (requested === "failed") return "failed";
	return signalTermination ?? requested;
}

/** Process-owned adapter that publishes immutable trace intervals after operations settle. */
export class InvocationTrace implements AgentSessionLifecycleObserver, TelemetryContext {
	readonly telemetryContext: TelemetryContext = this;
	readonly #createRecorder: InvocationTraceRecorderFactory | undefined;
	readonly #onDiagnostic: ((diagnostic: AgentSessionRuntimeDiagnostic) => void) | undefined;
	readonly #sessions = new Map<SessionManager, InvocationSessionAttachmentReason>();
	readonly #sessionBindings = new Map<SessionManager, string>();
	readonly #pendingOperations = new Set<string>();
	readonly #untracedOperations = new Set<string>();
	readonly #signalCleanupHandlers: Array<() => void> = [];
	#recorder: JsonlTraceContext | undefined;
	#releaseTraceLock: (() => Promise<void>) | undefined;
	#recorderCreation: Promise<JsonlTraceContext | undefined> | undefined;
	#lastDestinationPath: string | undefined;
	#activeHarnessVersion: string | undefined;
	#recorderHarnessVersion: string | undefined;
	#intervalTerminationStatus: TraceTerminationStatus = "completed";
	#signalTermination: TraceTerminationStatus | undefined;
	#settlementQueue: Promise<void> = Promise.resolve();
	#closed = false;
	#recorderUnavailableReported = false;

	constructor(
		initial?: InvocationTraceRecorderHandle,
		createRecorder?: InvocationTraceRecorderFactory,
		onDiagnostic?: (diagnostic: AgentSessionRuntimeDiagnostic) => void,
	) {
		this.#recorder = initial?.recorder;
		this.#releaseTraceLock = initial?.releaseTraceLock;
		this.#lastDestinationPath = initial?.recorder.destinationPath;
		this.#createRecorder = createRecorder;
		this.#onDiagnostic = onDiagnostic;
		if (initial || createRecorder) this.#registerSignalObservers();
	}

	get destinationPath(): string | undefined {
		return this.#recorder?.destinationPath ?? this.#lastDestinationPath;
	}

	#registerSignalObservers(): void {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");
		for (const signal of signals) {
			const handler = () => {
				this.#signalTermination = "aborted";
				void this.#ensureRecorder();
			};
			process.on(signal, handler);
			this.#signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	}

	async #initializeRecorder(recorder: JsonlTraceContext): Promise<void> {
		this.#sessionBindings.clear();
		this.#recorderHarnessVersion = undefined;
		for (const [sessionManager, reason] of this.#sessions) {
			if (!sessionManager.isPersisted()) continue;
			const path = sessionManager.getSessionFile();
			if (!path) continue;
			const bindingId = uuidv7();
			this.#sessionBindings.set(sessionManager, bindingId);
			recorder.attachSession({
				bindingId,
				sessionId: sessionManager.getSessionId(),
				path,
				sessionFormat: "coding-agent",
				formatVersion: CURRENT_SESSION_VERSION,
				reason: reason satisfies SessionAttachmentReason,
			});
		}
		if (this.#activeHarnessVersion) {
			recorder.activateHarness({ harnessVersion: this.#activeHarnessVersion, reason: "initial" });
			this.#recorderHarnessVersion = this.#activeHarnessVersion;
		}
		await recorder.flush();
	}

	async #ensureRecorder(): Promise<JsonlTraceContext | undefined> {
		if (this.#closed) return undefined;
		if (this.#recorder) return this.#recorder;
		if (!this.#createRecorder) return undefined;
		if (!this.#recorderCreation) {
			this.#recorderCreation = this.#createRecorder()
				.then(async (handle) => {
					if (this.#closed) {
						try {
							await handle.recorder.close(finalTerminationStatus("completed", this.#signalTermination));
						} finally {
							await handle.releaseTraceLock();
						}
						return undefined;
					}
					this.#recorder = handle.recorder;
					this.#releaseTraceLock = handle.releaseTraceLock;
					this.#lastDestinationPath = handle.recorder.destinationPath;
					await this.#initializeRecorder(handle.recorder);
					return handle.recorder;
				})
				.catch((error: unknown) => {
					if (!this.#recorderUnavailableReported) {
						this.#recorderUnavailableReported = true;
						this.#onDiagnostic?.({
							type: "warning",
							message: `Invocation tracing is unavailable: ${errorMessage(error)}`,
						});
					}
					return undefined;
				})
				.finally(() => {
					this.#recorderCreation = undefined;
				});
		}
		return this.#recorderCreation;
	}

	#observeSpan(span: TelemetrySpan): TelemetrySpan {
		return {
			startSpan: (options, callback) => span.startSpan(options, (child) => callback(this.#observeSpan(child))),
			addEvent: (name, attributes) => span.addEvent(name, attributes),
			setAttributes: (attributes) => span.setAttributes(attributes),
			setStatus: (status) => {
				if (status.status === "error") this.#intervalTerminationStatus = "failed";
				span.setStatus(status);
			},
		};
	}

	async startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		const operationId =
			options.name === OPERATION_SPAN_NAME && typeof options.attributes?.[OPERATION_ID_ATTRIBUTE] === "string"
				? options.attributes[OPERATION_ID_ATTRIBUTE]
				: undefined;
		const skipsIdleAbort =
			operationId !== undefined &&
			options.attributes?.[OPERATION_KIND_ATTRIBUTE] === "abort" &&
			this.#recorder === undefined &&
			this.#recorderCreation === undefined;
		if (skipsIdleAbort) {
			this.#untracedOperations.add(operationId);
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		}
		if (operationId) this.#pendingOperations.add(operationId);
		const recorder = await this.#ensureRecorder();
		try {
			return await (recorder ?? NOOP_TELEMETRY_CONTEXT).startSpan(options, (span) =>
				callback(this.#observeSpan(span)),
			);
		} catch (error) {
			if (operationId) this.#intervalTerminationStatus = "failed";
			throw error;
		}
	}

	async attachSession(sessionManager: SessionManager, reason: InvocationSessionAttachmentReason): Promise<void> {
		if (!sessionManager.isPersisted()) return;
		if (!this.#sessions.has(sessionManager)) this.#sessions.set(sessionManager, reason);
		const recorder = this.#recorder ?? (await this.#recorderCreation);
		if (!recorder || this.#sessionBindings.has(sessionManager)) return;
		const path = sessionManager.getSessionFile();
		if (!path) return;
		const bindingId = uuidv7();
		this.#sessionBindings.set(sessionManager, bindingId);
		recorder.attachSession({
			bindingId,
			sessionId: sessionManager.getSessionId(),
			path,
			sessionFormat: "coding-agent",
			formatVersion: CURRENT_SESSION_VERSION,
			reason: reason satisfies SessionAttachmentReason,
		});
		await recorder.flush();
	}

	operationSettled(options: {
		operationId: string;
		taskLineageId?: string;
		sessionManager: SessionManager;
		firstEntryOrdinal: number;
	}): Promise<void> {
		const settlement = this.#settlementQueue.then(async () => {
			if (this.#untracedOperations.delete(options.operationId)) return;
			const recorder = await this.#ensureRecorder();
			const bindingId = this.#sessionBindings.get(options.sessionManager);
			if (recorder && bindingId) {
				const cursor = options.sessionManager.getEntryCursorRange(options.firstEntryOrdinal);
				if (cursor) {
					recorder.recordSessionSegment({
						bindingId,
						lane: "main",
						operationId: options.operationId,
						...(options.taskLineageId === undefined ? {} : { taskLineageId: options.taskLineageId }),
						cursor: { kind: "coding-agent-v3", ...cursor },
					});
				}
				await recorder.flush();
			}
			this.#pendingOperations.delete(options.operationId);
			if (this.#pendingOperations.size === 0) await this.#closeCurrentRecorder(this.#intervalTerminationStatus);
		});
		this.#settlementQueue = settlement.catch(() => {});
		return settlement;
	}

	async harnessActivated(version: string): Promise<void> {
		this.#activeHarnessVersion = version;
		const recorder = this.#recorder ?? (await this.#recorderCreation);
		if (!recorder || version === this.#recorderHarnessVersion) return;
		recorder.activateHarness({
			harnessVersion: version,
			reason: this.#recorderHarnessVersion === undefined ? "initial" : "switch",
		});
		this.#recorderHarnessVersion = version;
		await recorder.flush();
	}

	async recordDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): Promise<void> {
		if (diagnostics.length === 0) return;
		const recorder = await this.#ensureRecorder();
		if (!recorder) return;
		for (const diagnostic of diagnostics) {
			await recorder.startSpan(
				{
					name: "diffex.coding_agent.diagnostic",
					attributes: {
						"diffex.diagnostic.severity": diagnostic.type,
						"diffex.diagnostic.message": diagnostic.message,
					},
				},
				(span) => {
					if (diagnostic.type === "error") span.setStatus({ status: "error" });
				},
			);
		}
		await recorder.flush();
	}

	async #closeCurrentRecorder(terminationStatus: TraceTerminationStatus): Promise<void> {
		const recorder = this.#recorder;
		const releaseTraceLock = this.#releaseTraceLock;
		this.#recorder = undefined;
		this.#releaseTraceLock = undefined;
		this.#sessionBindings.clear();
		this.#recorderHarnessVersion = undefined;
		this.#intervalTerminationStatus = "completed";
		if (!recorder) return;
		const finalStatus = finalTerminationStatus(terminationStatus, this.#signalTermination);
		try {
			await recorder.close(finalStatus);
		} finally {
			await releaseTraceLock?.();
		}
		if (finalStatus !== "completed") return;
		try {
			const invocation = await materializeJsonlInvocation(recorder.destinationPath);
			if (invocation.integrity === "complete" && !classifyEvolutionEvidence(invocation).eligible) {
				await unlink(recorder.destinationPath);
				if (this.#lastDestinationPath === recorder.destinationPath) this.#lastDestinationPath = undefined;
			}
		} catch {
			// Preserve traces that cannot be classified safely.
		}
	}

	async close(terminationStatus: TraceTerminationStatus = "completed"): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const cleanup of this.#signalCleanupHandlers.splice(0)) cleanup();
		await this.#settlementQueue;
		await this.#recorderCreation;
		await this.#closeCurrentRecorder(terminationStatus);
	}
}

export async function createInvocationTrace(
	options: CreateInvocationTraceOptions,
): Promise<InvocationTraceCreationResult> {
	if (!options.sessionManager.isPersisted()) return { trace: new InvocationTrace() };

	const version = options.diffexVersion ?? VERSION;
	const runtime = runtimeIdentity();
	const createRecorder = async (): Promise<InvocationTraceRecorderHandle> => {
		const traceId = uuidv7();
		const destinationPath = invocationTracePath(options.agentDir, traceId);
		let releaseTraceLock: (() => Promise<void>) | undefined;
		try {
			await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
			releaseTraceLock = await lockfile.lock(destinationPath, {
				realpath: false,
				stale: INVOCATION_TRACE_LOCK_STALE_MS,
				update: INVOCATION_TRACE_LOCK_UPDATE_MS,
			});
			const recorder = await createJsonlTraceContext({
				destinationPath,
				traceId,
				diffexVersion: version,
				sourceRevision: sourceRevision(version, options.sourceRevision),
				runtimeKind: runtime.kind,
				runtimeVersion: runtime.version,
				telemetrySchemaVersions: {
					agent: AGENT_RUNTIME_TELEMETRY_SCHEMA.version,
					ai: AI_TELEMETRY_SCHEMA.version,
					"coding-agent": CODING_AGENT_TELEMETRY_SCHEMA.version,
				},
			});
			return { recorder, releaseTraceLock };
		} catch (error) {
			await releaseTraceLock?.().catch(() => {});
			throw error;
		}
	};

	return { trace: new InvocationTrace(undefined, createRecorder, options.onDiagnostic) };
}
