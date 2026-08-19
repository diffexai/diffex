import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseTraceRecord } from "./codec.ts";
import {
	TRACE_SCHEMA_VERSION,
	type TraceDiagnostic,
	type TraceDiagnosticCode,
	type TraceReadResult,
	type TraceRecord,
	type TraceSessionAttachRecord,
} from "./types.ts";

interface MutableSpanValidationState {
	settled: boolean;
}

interface RawRecord {
	readonly type?: unknown;
	readonly schemaVersion?: unknown;
}

function rawRecord(line: string): RawRecord | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		return value as RawRecord;
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Invalid trace record";
}

/** Streams, decodes, and validates a complete trace file without loading the file into memory. */
export async function readJsonlTraceFile(path: string): Promise<TraceReadResult> {
	const records: TraceRecord[] = [];
	const diagnostics: TraceDiagnostic[] = [];
	const spans = new Map<number, MutableSpanValidationState>();
	const sessionBindings = new Map<string, TraceSessionAttachRecord>();
	let lineNumber = 0;
	let expectedSequence = 1;
	let headerSeen = false;
	let footerSeen = false;
	let schemaRejected = false;
	let pending = "";
	const decoder = new StringDecoder("utf8");

	const diagnose = (code: TraceDiagnosticCode, message: string, sequence?: number): void => {
		diagnostics.push({ code, message, lineNumber, ...(sequence === undefined ? {} : { sequence }) });
	};

	const validateRecord = (record: TraceRecord): void => {
		if (record.sequence > expectedSequence) {
			diagnose(
				"sequence_gap",
				`Expected trace sequence ${expectedSequence}, received ${record.sequence}`,
				record.sequence,
			);
			expectedSequence = record.sequence + 1;
		} else if (record.sequence < expectedSequence) {
			diagnose(
				"sequence_out_of_order",
				`Expected trace sequence ${expectedSequence}, received ${record.sequence}`,
				record.sequence,
			);
		} else {
			expectedSequence++;
		}

		if (footerSeen) {
			diagnose("record_after_footer", `Record ${record.type} appears after trace closure`, record.sequence);
		}

		switch (record.type) {
			case "trace_header":
				if (headerSeen) diagnose("duplicate_header", "Trace contains more than one header", record.sequence);
				if (lineNumber !== 1) diagnose("misplaced_header", "Trace header is not the first record", record.sequence);
				headerSeen = true;
				break;
			case "session_attach":
				if (sessionBindings.has(record.bindingId)) {
					diagnose(
						"duplicate_session_binding",
						`Session binding ${record.bindingId} is attached more than once`,
						record.sequence,
					);
				} else {
					sessionBindings.set(record.bindingId, record);
				}
				break;
			case "session_segment": {
				const binding = sessionBindings.get(record.bindingId);
				if (!binding) {
					diagnose(
						"unknown_session_binding",
						`Session segment references unknown binding ${record.bindingId}`,
						record.sequence,
					);
					break;
				}
				const cursorMatches =
					(record.cursor.kind === "coding-agent-v3" &&
						binding.sessionFormat === "coding-agent" &&
						binding.formatVersion === 3) ||
					(record.cursor.kind === "agent-harness" && binding.sessionFormat === "agent-harness");
				if (!cursorMatches) {
					diagnose(
						"session_cursor_mismatch",
						`Session cursor ${record.cursor.kind} does not match ${binding.sessionFormat} v${binding.formatVersion}`,
						record.sequence,
					);
				}
				break;
			}
			case "span_start": {
				const parent = record.parentSpanId === null ? undefined : spans.get(record.parentSpanId);
				if (spans.has(record.spanId)) {
					diagnose("invalid_span_parentage", `Span ${record.spanId} starts more than once`, record.sequence);
				} else {
					spans.set(record.spanId, { settled: false });
				}
				if (record.parentSpanId !== null && (!parent || parent.settled)) {
					diagnose(
						"invalid_span_parentage",
						`Span ${record.spanId} references unavailable parent ${record.parentSpanId}`,
						record.sequence,
					);
				}
				break;
			}
			case "span_event": {
				const span = spans.get(record.spanId);
				if (!span || span.settled) {
					diagnose(
						"invalid_span_parentage",
						`Span event references unavailable span ${record.spanId}`,
						record.sequence,
					);
				}
				break;
			}
			case "span_end": {
				const span = spans.get(record.spanId);
				if (!span) {
					diagnose(
						"invalid_span_parentage",
						`Span settlement references unknown span ${record.spanId}`,
						record.sequence,
					);
				} else if (span.settled) {
					diagnose("duplicate_span_settlement", `Span ${record.spanId} settles more than once`, record.sequence);
				} else {
					span.settled = true;
				}
				break;
			}
			case "trace_footer":
				if (!headerSeen) diagnose("misplaced_footer", "Trace footer appears before its header", record.sequence);
				if (footerSeen) diagnose("duplicate_footer", "Trace contains more than one footer", record.sequence);
				footerSeen = true;
				break;
			case "harness_activate":
				break;
		}
	};

	const processLine = (line: string): void => {
		lineNumber++;
		if (schemaRejected) return;
		const raw = rawRecord(line);
		if (
			lineNumber === 1 &&
			raw?.type === "trace_header" &&
			typeof raw.schemaVersion === "number" &&
			Number.isSafeInteger(raw.schemaVersion) &&
			raw.schemaVersion > 0 &&
			raw.schemaVersion !== TRACE_SCHEMA_VERSION
		) {
			diagnose(
				"incompatible_schema_version",
				`Trace schema version ${String(raw.schemaVersion)} is incompatible with supported version ${TRACE_SCHEMA_VERSION}`,
			);
			schemaRejected = true;
			return;
		}
		let record: TraceRecord;
		try {
			record = parseTraceRecord(line);
		} catch (error) {
			if (raw?.type === "trace_header") {
				diagnose(headerSeen ? "duplicate_header" : "misplaced_header", errorMessage(error));
			} else {
				diagnose("invalid_record", errorMessage(error));
			}
			return;
		}
		records.push(record);
		validateRecord(record);
	};

	for await (const chunk of createReadStream(path)) {
		pending += decoder.write(chunk);
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			processLine(pending.slice(0, newline));
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	}
	pending += decoder.end();
	if (pending.length > 0) {
		lineNumber++;
		diagnostics.push({
			code: "partial_final_line",
			message: "Trace ends with a partial final line",
			lineNumber,
		});
	}

	if (!schemaRejected) {
		if (!headerSeen)
			diagnostics.push({ code: "missing_header", message: "Trace header is missing", lineNumber: null });
		if (!footerSeen)
			diagnostics.push({ code: "missing_footer", message: "Trace footer is missing", lineNumber: null });
	}

	return { records, diagnostics, closed: footerSeen };
}
