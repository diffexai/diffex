import {
	MATERIALIZED_INVOCATION_VERSION,
	type MaterializationDiagnostic,
	type MaterializationIntegrity,
	type MaterializedCausalIdentifier,
	type MaterializedEvidence,
	type MaterializedEvidenceOrder,
	type MaterializedInvocation,
	type MaterializedSpan,
	type MaterializedSpanEvent,
	type MaterializedTraceRecordSource,
} from "./materialized-types.ts";
import { readJsonlTraceFile } from "./reader.ts";
import type {
	TraceFooterRecord,
	TraceHeaderRecord,
	TraceRecord,
	TraceSpanEndRecord,
	TraceSpanEventRecord,
	TraceSpanStartRecord,
} from "./types.ts";

interface IndexedTraceRecord {
	readonly index: number;
	readonly record: TraceRecord;
	readonly source: MaterializedTraceRecordSource;
}

const ORDERING_CRITERIA = ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"] as const;

function traceRecordId(traceId: string | null, record: TraceRecord, index: number): string {
	return `${traceId ?? "unknown-trace"}:record:${record.sequence}:${index + 1}`;
}

function indexedTraceRecords(records: readonly TraceRecord[], traceId: string | null): readonly IndexedTraceRecord[] {
	return records.map((record, index) => ({
		index,
		record,
		source: {
			recordId: traceRecordId(traceId, record, index),
			sequence: record.sequence,
			type: record.type,
		},
	}));
}

function isIdentifierName(name: string): boolean {
	return name === "id" || name.endsWith("Id") || name.endsWith(".id") || name.endsWith("_id");
}

function collectCausalIdentifiers(value: unknown, prefix = "", result = new Map<string, string>()): void {
	if (Array.isArray(value)) {
		for (const item of value) collectCausalIdentifiers(item, prefix, result);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [name, item] of Object.entries(value)) {
		const qualifiedName = prefix ? `${prefix}.${name}` : name;
		if (typeof item === "string" && isIdentifierName(name)) result.set(`${qualifiedName}\0${item}`, item);
		else collectCausalIdentifiers(item, qualifiedName, result);
	}
}

function causalIdentifiers(...values: readonly unknown[]): readonly MaterializedCausalIdentifier[] {
	const identifiers = new Map<string, string>();
	for (const value of values) collectCausalIdentifiers(value, "", identifiers);
	return [...identifiers.entries()]
		.map(([key, value]) => ({ name: key.slice(0, key.indexOf("\0")), value }))
		.sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
}

function traceOrder(
	record: TraceRecord,
	causalValues: readonly unknown[],
	parentSpanId?: number | null,
): MaterializedEvidenceOrder {
	return {
		traceSequence: record.sequence,
		timestamp: record.timestamp,
		...(parentSpanId === undefined ? {} : { parentSpanId }),
		causalIdentifiers: causalIdentifiers(...causalValues),
		ambiguity: [],
	};
}

function materializeSpan(
	traceId: string | null,
	start: IndexedTraceRecord & { readonly record: TraceSpanStartRecord },
	events: readonly (IndexedTraceRecord & { readonly record: TraceSpanEventRecord })[],
	end: (IndexedTraceRecord & { readonly record: TraceSpanEndRecord }) | undefined,
): MaterializedEvidence {
	const spanEvents: MaterializedSpanEvent[] = events.map((event) => ({
		name: event.record.name,
		timestamp: event.record.timestamp,
		attributes: event.record.attributes,
		sourceTraceRecordId: event.source.recordId,
	}));
	const payload: MaterializedSpan = {
		spanId: start.record.spanId,
		parentSpanId: start.record.parentSpanId,
		name: start.record.name,
		startedAt: start.record.timestamp,
		endedAt: end?.record.timestamp ?? null,
		startAttributes: start.record.attributes,
		endAttributes: end?.record.attributes ?? null,
		events: spanEvents,
		status: end?.record.status ?? null,
		settled: end !== undefined,
	};
	return {
		evidenceId: `${traceId ?? "unknown-trace"}:span:${start.record.spanId}`,
		kind: "span",
		order: traceOrder(
			start.record,
			[start.record.attributes, ...events.map((event) => event.record.attributes), end?.record.attributes],
			start.record.parentSpanId,
		),
		traceSources: [start.source, ...events.map((event) => event.source), ...(end ? [end.source] : [])],
		payload,
	};
}

function materializeTraceEvidence(
	traceId: string | null,
	indexed: readonly IndexedTraceRecord[],
): { evidence: MaterializedEvidence[]; diagnostics: MaterializationDiagnostic[] } {
	const evidence: MaterializedEvidence[] = [];
	const diagnostics: MaterializationDiagnostic[] = [];
	const consumed = new Set<number>();
	const firstStarts = new Map<number, IndexedTraceRecord & { readonly record: TraceSpanStartRecord }>();

	for (const item of indexed) {
		if (item.record.type === "span_start" && !firstStarts.has(item.record.spanId)) {
			firstStarts.set(item.record.spanId, item as IndexedTraceRecord & { readonly record: TraceSpanStartRecord });
		}
	}

	for (const start of firstStarts.values()) {
		const end = indexed.find(
			(item): item is IndexedTraceRecord & { readonly record: TraceSpanEndRecord } =>
				item.record.type === "span_end" &&
				item.record.spanId === start.record.spanId &&
				item.record.sequence >= start.record.sequence,
		);
		const events = indexed.filter(
			(item): item is IndexedTraceRecord & { readonly record: TraceSpanEventRecord } =>
				item.record.type === "span_event" &&
				item.record.spanId === start.record.spanId &&
				item.record.sequence >= start.record.sequence &&
				(end === undefined || item.record.sequence <= end.record.sequence),
		);
		consumed.add(start.index);
		for (const event of events) consumed.add(event.index);
		if (end) consumed.add(end.index);
		evidence.push(materializeSpan(traceId, start, events, end));
		if (!end) {
			diagnostics.push({
				code: "unsettled_span",
				message: `Span ${start.record.spanId} has no settlement record`,
				recoverable: true,
				traceSequence: start.record.sequence,
			});
		}
	}

	for (const item of indexed) {
		if (consumed.has(item.index)) continue;
		evidence.push({
			evidenceId: `${traceId ?? "unknown-trace"}:evidence:${item.record.sequence}:${item.index + 1}`,
			kind: "trace_record",
			order: traceOrder(item.record, [item.record], "spanId" in item.record ? item.record.spanId : undefined),
			traceSources: [item.source],
			payload: item.record,
		});
	}

	evidence.sort(
		(left, right) =>
			left.order.traceSequence - right.order.traceSequence || left.evidenceId.localeCompare(right.evidenceId),
	);
	return { evidence, diagnostics };
}

function traceIntegrityDiagnostics(
	result: Awaited<ReturnType<typeof readJsonlTraceFile>>,
): MaterializationDiagnostic[] {
	return result.diagnostics.map((diagnostic) => ({
		code: "trace_integrity",
		message: diagnostic.message,
		recoverable: diagnostic.code !== "incompatible_schema_version",
		...(diagnostic.sequence === undefined ? {} : { traceSequence: diagnostic.sequence }),
		sourceCode: diagnostic.code,
	}));
}

function materializationIntegrity(diagnostics: readonly MaterializationDiagnostic[]): MaterializationIntegrity {
	if (diagnostics.some((diagnostic) => !diagnostic.recoverable)) return "incompatible";
	return diagnostics.length === 0 ? "complete" : "partial";
}

/** Builds a deterministic evidence document from a validated invocation trace. */
export async function materializeJsonlInvocation(tracePath: string): Promise<MaterializedInvocation> {
	const result = await readJsonlTraceFile(tracePath);
	const header = result.records.find((record): record is TraceHeaderRecord => record.type === "trace_header");
	const footer = result.records.find((record): record is TraceFooterRecord => record.type === "trace_footer");
	const traceId = header?.traceId ?? null;
	const indexed = indexedTraceRecords(result.records, traceId);
	const materialized = materializeTraceEvidence(traceId, indexed);
	const diagnostics = [...traceIntegrityDiagnostics(result), ...materialized.diagnostics];
	if (footer && (footer.health.droppedRecords > 0 || footer.health.writerErrors > 0 || footer.health.writerDisabled)) {
		diagnostics.push({
			code: "trace_writer_degraded",
			message: `Trace writer degraded with ${footer.health.droppedRecords} dropped records and ${footer.health.writerErrors} writer errors`,
			recoverable: true,
			traceSequence: footer.sequence,
		});
	}

	return {
		version: MATERIALIZED_INVOCATION_VERSION,
		tracePath,
		traceId,
		producer: header?.producer ?? null,
		integrity: materializationIntegrity(diagnostics),
		terminationStatus: footer?.terminationStatus ?? (header ? "crashed" : "unknown"),
		health: footer?.health ?? null,
		ordering: { criteria: ORDERING_CRITERIA, ambiguity: [] },
		evidence: materialized.evidence,
		diagnostics,
	};
}

/** Serializes one materialized invocation as stable, human-readable JSON. */
export function serializeMaterializedInvocation(invocation: MaterializedInvocation): string {
	return `${JSON.stringify(invocation, null, 2)}\n`;
}
