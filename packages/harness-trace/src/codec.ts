import type { AttributeValue, SpanAttributes, SpanStatus } from "@earendil-works/diffex-telemetry";
import {
	TRACE_SCHEMA_VERSION,
	type TraceFooterRecord,
	type TraceHeaderRecord,
	type TraceHealth,
	type TraceMetadata,
	type TraceProducer,
	type TraceRecord,
	type TraceSessionRangeRecord,
	type TraceSessionReference,
	type TraceSpanEndRecord,
	type TraceSpanEventRecord,
	type TraceSpanStartRecord,
} from "./types.ts";

function invalidRecord(message: string): never {
	throw new Error(`Invalid trace record: ${message}`);
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalidRecord(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	const expected = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) invalidRecord(`${name} contains unknown field ${key}`);
	}
	for (const key of keys) {
		if (!(key in value)) invalidRecord(`${name} is missing field ${key}`);
	}
}

function optionalKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	name: string,
): void {
	const expected = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!expected.has(key)) invalidRecord(`${name} contains unknown field ${key}`);
	}
	for (const key of required) {
		if (!(key in value)) invalidRecord(`${name} is missing field ${key}`);
	}
}

function stringValue(value: unknown, name: string): string {
	if (typeof value !== "string") invalidRecord(`${name} must be a string`);
	return value;
}

function nonEmptyStringValue(value: unknown, name: string): string {
	const text = stringValue(value, name);
	if (text.length === 0) invalidRecord(`${name} must be non-empty`);
	return text;
}

function sequenceValue(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		invalidRecord(`${name} must be a positive safe integer`);
	}
	return value;
}

function countValue(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		invalidRecord(`${name} must be a non-negative safe integer`);
	}
	return value;
}

function timestampValue(value: unknown): string {
	if (typeof value !== "string") invalidRecord("timestamp must be a string");
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
		invalidRecord("timestamp must be a canonical ISO 8601 instant");
	}
	return value;
}

function attributeValue(value: unknown, name: string): AttributeValue {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!Array.isArray(value)) invalidRecord(`${name} is not a telemetry primitive`);
	if (value.every((item) => typeof item === "string")) return value;
	if (value.every((item) => typeof item === "boolean")) return value;
	if (value.every((item) => typeof item === "number" && Number.isFinite(item))) return value;
	invalidRecord(`${name} is not a homogeneous telemetry primitive array`);
}

function attributesValue(value: unknown, name: string): SpanAttributes {
	const attributes = recordValue(value, name);
	const parsed: SpanAttributes = {};
	for (const [key, attribute] of Object.entries(attributes)) parsed[key] = attributeValue(attribute, `${name}.${key}`);
	return parsed;
}

function statusValue(value: unknown): SpanStatus {
	const status = recordValue(value, "status");
	if (status.status === "ok") {
		exactKeys(status, ["status"], "status");
		return { status: "ok" };
	}
	if (status.status !== "error") invalidRecord("status.status must be ok or error");
	optionalKeys(status, ["status"], ["error"], "status");
	if (status.error === undefined) return { status: "error" };
	const error = recordValue(status.error, "status.error");
	exactKeys(error, ["name", "message"], "status.error");
	return {
		status: "error",
		error: {
			name: stringValue(error.name, "status.error.name"),
			message: stringValue(error.message, "status.error.message"),
		},
	};
}

function healthValue(value: unknown): TraceHealth {
	const health = recordValue(value, "health");
	exactKeys(health, ["droppedRecords", "writerErrors", "writerDisabled", "closed"], "health");
	if (typeof health.writerDisabled !== "boolean" || typeof health.closed !== "boolean") {
		invalidRecord("health flags must be boolean");
	}
	return {
		droppedRecords: countValue(health.droppedRecords, "health.droppedRecords"),
		writerErrors: countValue(health.writerErrors, "health.writerErrors"),
		writerDisabled: health.writerDisabled,
		closed: health.closed,
	};
}

function metadataValue(value: unknown): TraceMetadata {
	const metadata = recordValue(value, "producer.metadata");
	const parsed: Record<string, string | number | boolean | null> = {};
	for (const [key, item] of Object.entries(metadata)) {
		if (item === null || typeof item === "string" || typeof item === "boolean") parsed[key] = item;
		else if (typeof item === "number" && Number.isFinite(item)) parsed[key] = item;
		else invalidRecord(`producer.metadata.${key} must be a JSON primitive`);
	}
	return parsed;
}

function sessionValue(value: unknown): TraceSessionReference {
	const session = recordValue(value, "session");
	optionalKeys(session, ["id"], ["path"], "session");
	return {
		id: nonEmptyStringValue(session.id, "session.id"),
		...(session.path === undefined ? {} : { path: nonEmptyStringValue(session.path, "session.path") }),
	};
}

function producerValue(value: unknown): TraceProducer {
	const producer = recordValue(value, "producer");
	exactKeys(producer, ["version", "codeRevision", "harnessVersion", "metadata"], "producer");
	return {
		version: nonEmptyStringValue(producer.version, "producer.version"),
		codeRevision: nonEmptyStringValue(producer.codeRevision, "producer.codeRevision"),
		harnessVersion: nonEmptyStringValue(producer.harnessVersion, "producer.harnessVersion"),
		metadata: metadataValue(producer.metadata),
	};
}

function commonRecord(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	exactKeys(value, ["type", "sequence", "timestamp", ...keys], name);
	sequenceValue(value.sequence, "sequence");
	timestampValue(value.timestamp);
}

function parseHeader(value: Record<string, unknown>): TraceHeaderRecord {
	commonRecord(value, ["schemaVersion", "traceId", "session", "producer"], "trace_header");
	if (value.sequence !== 1) invalidRecord("trace_header sequence must be 1");
	if (value.schemaVersion !== TRACE_SCHEMA_VERSION) invalidRecord("unsupported schema version");
	return {
		type: "trace_header",
		sequence: 1,
		timestamp: timestampValue(value.timestamp),
		schemaVersion: TRACE_SCHEMA_VERSION,
		traceId: nonEmptyStringValue(value.traceId, "traceId"),
		session: sessionValue(value.session),
		producer: producerValue(value.producer),
	};
}

function parseSpanStart(value: Record<string, unknown>): TraceSpanStartRecord {
	commonRecord(value, ["spanId", "parentSpanId", "name", "attributes"], "span_start");
	const parentSpanId = value.parentSpanId === null ? null : sequenceValue(value.parentSpanId, "parentSpanId");
	return {
		type: "span_start",
		sequence: sequenceValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		spanId: sequenceValue(value.spanId, "spanId"),
		parentSpanId,
		name: stringValue(value.name, "name"),
		attributes: attributesValue(value.attributes, "attributes"),
	};
}

function parseSpanEvent(value: Record<string, unknown>): TraceSpanEventRecord {
	commonRecord(value, ["spanId", "name", "attributes"], "span_event");
	return {
		type: "span_event",
		sequence: sequenceValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		spanId: sequenceValue(value.spanId, "spanId"),
		name: stringValue(value.name, "name"),
		attributes: attributesValue(value.attributes, "attributes"),
	};
}

function parseSpanEnd(value: Record<string, unknown>): TraceSpanEndRecord {
	commonRecord(value, ["spanId", "attributes", "status"], "span_end");
	return {
		type: "span_end",
		sequence: sequenceValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		spanId: sequenceValue(value.spanId, "spanId"),
		attributes: attributesValue(value.attributes, "attributes"),
		status: statusValue(value.status),
	};
}

function parseSessionRange(value: Record<string, unknown>): TraceSessionRangeRecord {
	commonRecord(value, ["lane", "operationId", "startSequence", "endSequence"], "session_range");
	const startSequence = sequenceValue(value.startSequence, "startSequence");
	const endSequence = sequenceValue(value.endSequence, "endSequence");
	if (endSequence < startSequence) invalidRecord("session range ends before it starts");
	return {
		type: "session_range",
		sequence: sequenceValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		lane: nonEmptyStringValue(value.lane, "lane"),
		operationId: nonEmptyStringValue(value.operationId, "operationId"),
		startSequence,
		endSequence,
	};
}

function parseFooter(value: Record<string, unknown>): TraceFooterRecord {
	commonRecord(value, ["terminationStatus", "health"], "trace_footer");
	if (
		value.terminationStatus !== "completed" &&
		value.terminationStatus !== "failed" &&
		value.terminationStatus !== "aborted"
	) {
		invalidRecord("terminationStatus is invalid");
	}
	return {
		type: "trace_footer",
		sequence: sequenceValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		terminationStatus: value.terminationStatus,
		health: healthValue(value.health),
	};
}

/** Encodes exactly one validated trace record with LF framing. */
export function encodeTraceRecord(record: TraceRecord): string {
	const encoded = JSON.stringify(record);
	parseTraceRecord(encoded);
	return `${encoded}\n`;
}

/** Parses and validates exactly one trace record, with or without one trailing LF. */
export function parseTraceRecord(line: string): TraceRecord {
	const text = line.endsWith("\n") ? line.slice(0, -1) : line;
	if (text.length === 0 || text.includes("\n") || text.includes("\r"))
		invalidRecord("expected one LF-framed JSON value");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error("Invalid trace record: malformed JSON", { cause: error });
	}
	const value = recordValue(parsed, "record");
	switch (value.type) {
		case "trace_header":
			return parseHeader(value);
		case "span_start":
			return parseSpanStart(value);
		case "span_event":
			return parseSpanEvent(value);
		case "span_end":
			return parseSpanEnd(value);
		case "session_range":
			return parseSessionRange(value);
		case "trace_footer":
			return parseFooter(value);
		default:
			return invalidRecord("unknown record type");
	}
}
