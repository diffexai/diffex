import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	AGENT_RUNTIME_TELEMETRY_SCHEMA,
	AI_TELEMETRY_SCHEMA,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
} from "@earendil-works/diffex-agent-core";
import { uuidv7 } from "@earendil-works/diffex-ai";
import lockfile from "proper-lockfile";
import {
	createJsonlTraceContext,
	type JsonlTraceContext,
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
}

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

/** Process-owned adapter between coding-agent lifecycle facts and JSONL traces. */
export class InvocationTrace implements AgentSessionLifecycleObserver {
	readonly destinationPath: string | undefined;
	readonly telemetryContext: TelemetryContext;
	private readonly recorder: JsonlTraceContext | undefined;
	private readonly releaseTraceLock: (() => Promise<void>) | undefined;
	private readonly sessionBindings = new WeakMap<SessionManager, string>();
	private activeHarnessVersion: string | undefined;
	private signalTermination: TraceTerminationStatus | undefined;
	private readonly signalCleanupHandlers: Array<() => void> = [];

	constructor(recorder?: JsonlTraceContext, releaseTraceLock?: () => Promise<void>) {
		this.recorder = recorder;
		this.releaseTraceLock = releaseTraceLock;
		this.destinationPath = recorder?.destinationPath;
		this.telemetryContext = recorder ?? NOOP_TELEMETRY_CONTEXT;
		if (recorder) this.registerSignalObservers();
	}

	private registerSignalObservers(): void {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");
		for (const signal of signals) {
			const handler = () => {
				this.signalTermination = "aborted";
			};
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	}

	async attachSession(sessionManager: SessionManager, reason: InvocationSessionAttachmentReason): Promise<void> {
		if (!this.recorder || !sessionManager.isPersisted() || this.sessionBindings.has(sessionManager)) return;
		const path = sessionManager.getSessionFile();
		if (!path) return;
		const bindingId = uuidv7();
		this.sessionBindings.set(sessionManager, bindingId);
		this.recorder.attachSession({
			bindingId,
			sessionId: sessionManager.getSessionId(),
			path,
			sessionFormat: "coding-agent",
			formatVersion: CURRENT_SESSION_VERSION,
			reason: reason satisfies SessionAttachmentReason,
		});
		await this.recorder.flush();
	}

	async operationSettled(options: {
		operationId: string;
		sessionManager: SessionManager;
		firstEntryOrdinal: number;
	}): Promise<void> {
		if (!this.recorder) return;
		const bindingId = this.sessionBindings.get(options.sessionManager);
		if (bindingId) {
			const cursor = options.sessionManager.getEntryCursorRange(options.firstEntryOrdinal);
			if (cursor) {
				this.recorder.recordSessionSegment({
					bindingId,
					lane: "main",
					operationId: options.operationId,
					cursor: { kind: "coding-agent-v3", ...cursor },
				});
			}
		}
		await this.recorder.flush();
	}

	async harnessActivated(version: string): Promise<void> {
		if (!this.recorder || version === this.activeHarnessVersion) return;
		this.recorder.activateHarness({
			harnessVersion: version,
			reason: this.activeHarnessVersion === undefined ? "initial" : "switch",
		});
		this.activeHarnessVersion = version;
		await this.recorder.flush();
	}

	async recordDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): Promise<void> {
		if (!this.recorder) return;
		for (const diagnostic of diagnostics) {
			await this.recorder.startSpan(
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
		await this.recorder.flush();
	}

	async close(terminationStatus: TraceTerminationStatus = "completed"): Promise<void> {
		for (const cleanup of this.signalCleanupHandlers.splice(0)) cleanup();
		try {
			await this.recorder?.close(finalTerminationStatus(terminationStatus, this.signalTermination));
		} finally {
			await this.releaseTraceLock?.();
		}
	}
}

export async function createInvocationTrace(
	options: CreateInvocationTraceOptions,
): Promise<InvocationTraceCreationResult> {
	if (!options.sessionManager.isPersisted()) return { trace: new InvocationTrace() };

	const traceId = uuidv7();
	const version = options.diffexVersion ?? VERSION;
	const runtime = runtimeIdentity();
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
		return { trace: new InvocationTrace(recorder, releaseTraceLock) };
	} catch (error) {
		await releaseTraceLock?.().catch(() => {});
		return {
			trace: new InvocationTrace(),
			diagnostic: {
				type: "warning",
				message: `Invocation tracing is unavailable: ${errorMessage(error)}`,
			},
		};
	}
}
