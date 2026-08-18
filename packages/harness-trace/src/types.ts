import type { SpanAttributes, SpanStatus, TelemetryContext } from "@earendil-works/diffex-telemetry";

export const TRACE_SCHEMA_VERSION = 1 as const;

export type TraceMetadataValue = string | number | boolean | null;

export interface TraceMetadata {
	readonly [name: string]: TraceMetadataValue;
}

export interface TraceSessionReference {
	readonly id: string;
	readonly path?: string;
}

export interface TraceProducer {
	readonly version: string;
	readonly codeRevision: string;
	readonly harnessVersion: string;
	readonly metadata: TraceMetadata;
}

export interface TraceHealth {
	readonly droppedRecords: number;
	readonly writerErrors: number;
	readonly writerDisabled: boolean;
	readonly closed: boolean;
}

export type TraceTerminationStatus = "completed" | "failed" | "aborted";

export interface CreateJsonlTraceContextOptions {
	readonly destinationPath: string;
	readonly traceId: string;
	readonly sessionId: string;
	readonly sessionPath?: string;
	readonly producerVersion: string;
	readonly codeRevision: string;
	readonly harnessVersion: string;
	readonly metadata?: Readonly<Record<string, TraceMetadataValue | undefined>>;
}

export interface JsonlTraceContext extends TelemetryContext, AsyncDisposable {
	readonly destinationPath: string;
	recordSessionRange(range: SessionSequenceRange): void;
	getHealth(): TraceHealth;
	flush(): Promise<void>;
	close(terminationStatus?: TraceTerminationStatus): Promise<void>;
}

interface SequencedTraceRecord {
	readonly sequence: number;
	readonly timestamp: string;
}

export interface TraceHeaderRecord extends SequencedTraceRecord {
	readonly type: "trace_header";
	readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
	readonly traceId: string;
	readonly session: TraceSessionReference;
	readonly producer: TraceProducer;
}

export interface TraceSpanStartRecord extends SequencedTraceRecord {
	readonly type: "span_start";
	readonly spanId: number;
	readonly parentSpanId: number | null;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface TraceSpanEventRecord extends SequencedTraceRecord {
	readonly type: "span_event";
	readonly spanId: number;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface TraceSpanEndRecord extends SequencedTraceRecord {
	readonly type: "span_end";
	readonly spanId: number;
	readonly attributes: Readonly<SpanAttributes>;
	readonly status: SpanStatus;
}

/** Inclusive durable session sequence bounds for one operation on one lane. */
export interface SessionSequenceRange {
	readonly lane: string;
	readonly operationId: string;
	readonly startSequence: number;
	readonly endSequence: number;
}

export interface TraceSessionRangeRecord extends SequencedTraceRecord, SessionSequenceRange {
	readonly type: "session_range";
}

export interface TraceFooterRecord extends SequencedTraceRecord {
	readonly type: "trace_footer";
	readonly terminationStatus: TraceTerminationStatus;
	readonly health: TraceHealth;
}

export type TraceRecord =
	| TraceHeaderRecord
	| TraceSpanStartRecord
	| TraceSpanEventRecord
	| TraceSpanEndRecord
	| TraceSessionRangeRecord
	| TraceFooterRecord;
