import { chmod, type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type AttributeValue,
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanOptions,
	type SpanStatus,
	type TelemetrySpan,
} from "@earendil-works/diffex-telemetry";
import { encodeTraceRecord } from "./codec.ts";
import {
	type AgentHarnessSessionSegmentCursor,
	type CodingAgentV3SessionSegmentCursor,
	type CreateJsonlTraceContextOptions,
	type HarnessActivation,
	type JsonlTraceContext,
	type SessionAttachment,
	type SessionSegment,
	type SessionSegmentCursor,
	TRACE_SCHEMA_VERSION,
	type TraceHealth,
	type TraceMetadata,
	type TraceRecord,
	type TraceTelemetrySchemaVersions,
	type TraceTerminationStatus,
} from "./types.ts";

interface MutableSpanState {
	readonly id: number;
	readonly parentId: number | null;
	attributes: SpanAttributes;
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
}

function copyAttributeValue(value: AttributeValue): AttributeValue {
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Telemetry numbers must be finite");
	if (!Array.isArray(value)) return value;
	const copy = [...value] as AttributeValue;
	if ((copy as readonly number[]).some((item) => typeof item === "number" && !Number.isFinite(item))) {
		throw new Error("Telemetry numbers must be finite");
	}
	return copy;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = copyAttributeValue(value);
	}
	return copy;
}

function mergeAttributes(current: SpanAttributes, attributes: SpanAttributes): SpanAttributes {
	const merged = copyAttributes(current);
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) merged[name] = copyAttributeValue(value);
	}
	return merged;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) {
			return { status: "error", error: { name: error.name, message: error.message } };
		}
	} catch {
		// Error inspection is passive. Preserve only the failure classification.
	}
	return { status: "error" };
}

function copyMetadata(
	metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>,
): TraceMetadata {
	const copy: Record<string, string | number | boolean | null> = {};
	if (!metadata) return copy;
	for (const [name, value] of Object.entries(metadata)) {
		if (value === undefined) continue;
		if (typeof value === "number" && !Number.isFinite(value))
			throw new Error("Trace metadata numbers must be finite");
		copy[name] = value;
	}
	return copy;
}

function copyTelemetrySchemaVersions(versions: Readonly<Record<string, number>>): TraceTelemetrySchemaVersions {
	return { ...versions };
}

function copySessionSegmentCursor(cursor: SessionSegmentCursor): SessionSegmentCursor {
	if (cursor.kind === "agent-harness") {
		return {
			kind: "agent-harness",
			startSequence: cursor.startSequence,
			endSequence: cursor.endSequence,
		} satisfies AgentHarnessSessionSegmentCursor;
	}
	return {
		kind: "coding-agent-v3",
		start: {
			entryOrdinal: cursor.start.entryOrdinal,
			entryId: cursor.start.entryId,
			digest: { ...cursor.start.digest },
		},
		end: {
			entryOrdinal: cursor.end.entryOrdinal,
			entryId: cursor.end.entryId,
			digest: { ...cursor.end.digest },
		},
	} satisfies CodingAgentV3SessionSegmentCursor;
}

class JsonlTraceRecorder implements JsonlTraceContext {
	readonly destinationPath: string;
	readonly #file: FileHandle;
	#nextSequence = 2;
	#nextSpanId = 1;
	#pendingWrite: Promise<void> = Promise.resolve();
	#droppedRecords = 0;
	#writerErrors = 0;
	#writerDisabled = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(destinationPath: string, file: FileHandle) {
		this.destinationPath = destinationPath;
		this.#file = file;
	}

	#timestamp(): string {
		return new Date().toISOString();
	}

	#sequence(): number {
		return this.#nextSequence++;
	}

	#enqueue(record: TraceRecord): boolean {
		if (this.#writerDisabled) {
			this.#droppedRecords++;
			return false;
		}
		let encoded: string;
		try {
			encoded = encodeTraceRecord(record);
		} catch {
			this.#droppedRecords++;
			this.#writerErrors++;
			return false;
		}
		this.#pendingWrite = this.#pendingWrite.then(async () => {
			if (this.#writerDisabled) {
				this.#droppedRecords++;
				return;
			}
			try {
				await this.#file.writeFile(encoded, { encoding: "utf8" });
			} catch {
				this.#droppedRecords++;
				this.#writerErrors++;
				this.#writerDisabled = true;
			}
		});
		return true;
	}

	#startSpan<T>(
		parent: MutableSpanState | undefined,
		options: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		if (this.#closed || parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);

		let state: MutableSpanState;
		let name: string;
		try {
			name = options.name;
			state = {
				id: this.#nextSpanId++,
				parentId: parent?.id ?? null,
				attributes: copyAttributes(options.attributes),
				status: { status: "ok" },
				explicitStatus: false,
				settled: false,
			};
			const admitted = this.#enqueue({
				type: "span_start",
				sequence: this.#sequence(),
				timestamp: this.#timestamp(),
				spanId: state.id,
				parentSpanId: state.parentId,
				name,
				attributes: copyAttributes(state.attributes),
			});
			if (!admitted) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		} catch {
			return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
		}

		const span: TelemetrySpan = {
			startSpan: <Result>(
				childOptions: SpanOptions,
				childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
			) => this.#startSpan(state, childOptions, childCallback),
			addEvent: (eventName, attributes) => {
				if (state.settled || this.#closed) return;
				try {
					this.#enqueue({
						type: "span_event",
						sequence: this.#sequence(),
						timestamp: this.#timestamp(),
						spanId: state.id,
						name: eventName,
						attributes: copyAttributes(attributes),
					});
				} catch {
					// Recording calls remain passive for malformed or unreadable payloads.
				}
			},
			setAttributes: (attributes) => {
				if (state.settled || this.#closed) return;
				try {
					state.attributes = mergeAttributes(state.attributes, attributes);
				} catch {
					// Attribute updates are atomic and passive.
				}
			},
			setStatus: (status) => {
				if (state.settled || this.#closed) return;
				try {
					state.status = copyStatus(status);
					state.explicitStatus = true;
				} catch {
					// Status updates are atomic and passive.
				}
			},
		};

		const settle = (failed: boolean, error?: unknown): void => {
			if (state.settled) return;
			state.settled = true;
			if (this.#closed) return;
			if (failed && !state.explicitStatus) state.status = automaticErrorStatus(error);
			this.#enqueue({
				type: "span_end",
				sequence: this.#sequence(),
				timestamp: this.#timestamp(),
				spanId: state.id,
				attributes: copyAttributes(state.attributes),
				status: copyStatus(state.status),
			});
		};

		let result: T | Promise<T>;
		try {
			result = callback(span);
		} catch (error) {
			settle(true, error);
			return Promise.reject(error);
		}

		return Promise.resolve(result).then(
			(value) => {
				settle(false);
				return value;
			},
			(error: unknown) => {
				settle(true, error);
				throw error;
			},
		);
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.#startSpan(undefined, options, callback);
	}

	attachSession(attachment: SessionAttachment): void {
		if (this.#closed) return;
		try {
			this.#enqueue({
				type: "session_attach",
				sequence: this.#sequence(),
				timestamp: this.#timestamp(),
				bindingId: attachment.bindingId,
				sessionId: attachment.sessionId,
				path: attachment.path,
				sessionFormat: attachment.sessionFormat,
				formatVersion: attachment.formatVersion,
				reason: attachment.reason,
			});
		} catch {
			// Session attachment recording is passive.
		}
	}

	activateHarness(activation: HarnessActivation): void {
		if (this.#closed) return;
		try {
			this.#enqueue({
				type: "harness_activate",
				sequence: this.#sequence(),
				timestamp: this.#timestamp(),
				harnessVersion: activation.harnessVersion,
				reason: activation.reason,
			});
		} catch {
			// Harness activation recording is passive.
		}
	}

	recordSessionSegment(segment: SessionSegment): void {
		if (this.#closed) return;
		try {
			this.#enqueue({
				type: "session_segment",
				sequence: this.#sequence(),
				timestamp: this.#timestamp(),
				bindingId: segment.bindingId,
				lane: segment.lane,
				operationId: segment.operationId,
				cursor: copySessionSegmentCursor(segment.cursor),
			});
		} catch {
			// Session segment recording is passive.
		}
	}

	getHealth(): TraceHealth {
		return {
			droppedRecords: this.#droppedRecords,
			writerErrors: this.#writerErrors,
			writerDisabled: this.#writerDisabled,
			closed: this.#closed,
		};
	}

	async flush(): Promise<void> {
		await this.#pendingWrite;
	}

	close(terminationStatus: TraceTerminationStatus = "completed"): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#enqueue({
			type: "trace_footer",
			sequence: this.#sequence(),
			timestamp: this.#timestamp(),
			terminationStatus,
			health: this.getHealth(),
		});
		this.#closePromise = this.#finishClose();
		return this.#closePromise;
	}

	async #finishClose(): Promise<void> {
		await this.#pendingWrite;
		try {
			await this.#file.close();
		} catch {
			this.#writerErrors++;
			this.#writerDisabled = true;
		}
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

/** Creates a fresh trace file and writes its header before returning the passive recorder. */
export async function createJsonlTraceContext(options: CreateJsonlTraceContextOptions): Promise<JsonlTraceContext> {
	const header: TraceRecord = {
		type: "trace_header",
		sequence: 1,
		timestamp: new Date().toISOString(),
		schemaVersion: TRACE_SCHEMA_VERSION,
		traceId: options.traceId,
		producer: {
			diffexVersion: options.diffexVersion,
			sourceRevision: options.sourceRevision,
			runtime: { kind: options.runtimeKind, version: options.runtimeVersion },
			telemetrySchemaVersions: copyTelemetrySchemaVersions(options.telemetrySchemaVersions),
			metadata: copyMetadata(options.metadata),
		},
	};
	const encodedHeader = encodeTraceRecord(header);
	const destinationDirectory = dirname(options.destinationPath);
	await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
	await chmod(destinationDirectory, 0o700);
	const file = await open(options.destinationPath, "wx", 0o600);
	try {
		await file.writeFile(encodedHeader, { encoding: "utf8" });
	} catch (error) {
		await file.close().catch(() => {});
		throw error;
	}
	return new JsonlTraceRecorder(options.destinationPath, file);
}
