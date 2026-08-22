import type { SpanAttributes, SpanStatus, TelemetryContext } from "@earendil-works/diffex-telemetry";

export const TRACE_SCHEMA_VERSION = 1 as const;

export type TraceMetadataValue = string | number | boolean | null;

export interface TraceMetadata {
	readonly [name: string]: TraceMetadataValue;
}

export interface TraceTelemetrySchemaVersions {
	readonly [name: string]: number;
}

export interface TraceRuntimeIdentity {
	readonly kind: string;
	readonly version: string;
}

export interface TraceProducer {
	readonly diffexVersion: string;
	readonly sourceRevision: string;
	readonly runtime: TraceRuntimeIdentity;
	readonly telemetrySchemaVersions: TraceTelemetrySchemaVersions;
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
	readonly diffexVersion: string;
	readonly sourceRevision: string;
	readonly runtimeKind: string;
	readonly runtimeVersion: string;
	readonly telemetrySchemaVersions: Readonly<Record<string, number>>;
	readonly metadata?: Readonly<Record<string, TraceMetadataValue | undefined>>;
}

export type SessionAttachmentReason = "startup" | "resume" | "new" | "import" | "fork" | "switch";

export interface SessionAttachment {
	readonly bindingId: string;
	readonly sessionId: string;
	readonly path: string;
	readonly sessionFormat: string;
	readonly formatVersion: number;
	readonly reason: SessionAttachmentReason;
}

export type HarnessActivationReason = "initial" | "switch";

export interface HarnessActivation {
	readonly harnessVersion: string;
	readonly reason: HarnessActivationReason;
}

export type SessionEntryDigestKind = "prefix" | "content";

export interface SessionEntryDigest {
	readonly kind: SessionEntryDigestKind;
	readonly algorithm: "sha256";
	readonly value: string;
}

export interface CodingAgentV3EntryCursor {
	readonly entryOrdinal: number;
	readonly entryId: string;
	readonly digest: SessionEntryDigest;
}

export interface CodingAgentV3SessionSegmentCursor {
	readonly kind: "coding-agent-v3";
	readonly start: CodingAgentV3EntryCursor;
	readonly end: CodingAgentV3EntryCursor;
}

export interface AgentHarnessSessionSegmentCursor {
	readonly kind: "agent-harness";
	readonly startSequence: number;
	readonly endSequence: number;
}

export type SessionSegmentCursor = CodingAgentV3SessionSegmentCursor | AgentHarnessSessionSegmentCursor;

export interface SessionSegment {
	readonly bindingId: string;
	readonly lane: string;
	readonly operationId: string;
	readonly taskLineageId?: string;
	readonly cursor: SessionSegmentCursor;
}

export interface JsonlTraceContext extends TelemetryContext, AsyncDisposable {
	readonly destinationPath: string;
	attachSession(attachment: SessionAttachment): void;
	activateHarness(activation: HarnessActivation): void;
	recordSessionSegment(segment: SessionSegment): void;
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
	readonly producer: TraceProducer;
}

export interface TraceSessionAttachRecord extends SequencedTraceRecord, SessionAttachment {
	readonly type: "session_attach";
}

export interface TraceHarnessActivateRecord extends SequencedTraceRecord, HarnessActivation {
	readonly type: "harness_activate";
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

export interface TraceSessionSegmentRecord extends SequencedTraceRecord, SessionSegment {
	readonly type: "session_segment";
}

export interface TraceFooterRecord extends SequencedTraceRecord {
	readonly type: "trace_footer";
	readonly terminationStatus: TraceTerminationStatus;
	readonly health: TraceHealth;
}

export type TraceDiagnosticCode =
	| "invalid_record"
	| "incompatible_schema_version"
	| "sequence_gap"
	| "sequence_out_of_order"
	| "duplicate_header"
	| "misplaced_header"
	| "missing_header"
	| "duplicate_footer"
	| "misplaced_footer"
	| "missing_footer"
	| "record_after_footer"
	| "invalid_span_parentage"
	| "duplicate_span_settlement"
	| "duplicate_session_binding"
	| "unknown_session_binding"
	| "session_cursor_mismatch"
	| "partial_final_line";

export interface TraceDiagnostic {
	readonly code: TraceDiagnosticCode;
	readonly message: string;
	readonly lineNumber: number | null;
	readonly sequence?: number;
}

export interface TraceReadResult {
	readonly records: readonly TraceRecord[];
	readonly diagnostics: readonly TraceDiagnostic[];
	readonly closed: boolean;
}

export type TraceRecord =
	| TraceHeaderRecord
	| TraceSessionAttachRecord
	| TraceHarnessActivateRecord
	| TraceSpanStartRecord
	| TraceSpanEventRecord
	| TraceSpanEndRecord
	| TraceSessionSegmentRecord
	| TraceFooterRecord;
