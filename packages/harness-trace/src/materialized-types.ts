import type { SpanAttributes, SpanStatus } from "@earendil-works/diffex-telemetry";
import type {
	TraceHealth,
	TraceProducer,
	TraceRecord,
	TraceSessionAttachRecord,
	TraceTerminationStatus,
} from "./types.ts";

export const MATERIALIZED_INVOCATION_VERSION = 1 as const;

export type MaterializationIntegrity = "complete" | "partial" | "incompatible";
export type MaterializedTerminationStatus = TraceTerminationStatus | "crashed" | "unknown";

export type MaterializationDiagnosticCode =
	| "trace_integrity"
	| "trace_writer_degraded"
	| "unsettled_span"
	| "session_missing"
	| "session_changed"
	| "session_truncated"
	| "session_incompatible"
	| "session_invalid";

export interface MaterializationDiagnostic {
	readonly code: MaterializationDiagnosticCode;
	readonly message: string;
	readonly recoverable: boolean;
	readonly traceSequence?: number;
	readonly bindingId?: string;
	readonly sourceCode?: string;
}

export interface MaterializedCausalIdentifier {
	readonly name: string;
	readonly value: string;
}

export interface MaterializedEvidenceOrder {
	readonly traceSequence: number;
	readonly timestamp: string | null;
	readonly sessionPosition?: number;
	readonly parentSpanId?: number | null;
	readonly causalIdentifiers: readonly MaterializedCausalIdentifier[];
	readonly ambiguity: readonly string[];
}

export interface MaterializedTraceRecordSource {
	readonly recordId: string;
	readonly sequence: number;
	readonly type: TraceRecord["type"];
}

export interface MaterializedSessionSource {
	readonly bindingId: string;
	readonly sessionId: string;
	readonly path: string;
	readonly resolvedPath?: string;
	readonly sessionFormat: string;
	readonly formatVersion: number;
	readonly segmentTraceSequences: readonly number[];
	readonly entryId?: string;
	readonly entryOrdinal?: number;
	readonly sessionSequence?: number;
}

export type MaterializedSessionPathResolver = (
	attachment: TraceSessionAttachRecord,
) => string | undefined | Promise<string | undefined>;

export interface MaterializeJsonlInvocationOptions {
	readonly resolveSessionPath?: MaterializedSessionPathResolver;
}

export interface MaterializedSpanEvent {
	readonly name: string;
	readonly timestamp: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly sourceTraceRecordId: string;
}

export interface MaterializedSpan {
	readonly spanId: number;
	readonly parentSpanId: number | null;
	readonly name: string;
	readonly startedAt: string;
	readonly endedAt: string | null;
	readonly startAttributes: Readonly<SpanAttributes>;
	readonly endAttributes: Readonly<SpanAttributes> | null;
	readonly events: readonly MaterializedSpanEvent[];
	readonly status: SpanStatus | null;
	readonly settled: boolean;
}

interface MaterializedEvidenceBase {
	readonly evidenceId: string;
	readonly order: MaterializedEvidenceOrder;
	readonly traceSources: readonly MaterializedTraceRecordSource[];
	readonly sessionSource?: MaterializedSessionSource;
}

export interface MaterializedTraceEvidence extends MaterializedEvidenceBase {
	readonly kind: "trace_record";
	readonly payload: TraceRecord;
}

export interface MaterializedSpanEvidence extends MaterializedEvidenceBase {
	readonly kind: "span";
	readonly payload: MaterializedSpan;
}

export interface MaterializedSessionEvidence extends MaterializedEvidenceBase {
	readonly kind: "session_item";
	readonly itemType: string;
	readonly payload: Readonly<Record<string, unknown>>;
}

export type MaterializedEvidence = MaterializedTraceEvidence | MaterializedSpanEvidence | MaterializedSessionEvidence;

export interface MaterializedInvocationOrdering {
	readonly criteria: readonly ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"];
	readonly ambiguity: readonly string[];
}

export interface MaterializedInvocation {
	readonly version: typeof MATERIALIZED_INVOCATION_VERSION;
	readonly tracePath: string;
	readonly traceId: string | null;
	readonly producer: TraceProducer | null;
	readonly integrity: MaterializationIntegrity;
	readonly terminationStatus: MaterializedTerminationStatus;
	readonly health: TraceHealth | null;
	readonly ordering: MaterializedInvocationOrdering;
	readonly evidence: readonly MaterializedEvidence[];
	readonly diagnostics: readonly MaterializationDiagnostic[];
}
