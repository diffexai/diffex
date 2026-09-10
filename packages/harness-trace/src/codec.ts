import type { AttributeValue, SpanAttributes, SpanStatus } from "@diffexai/diffex-telemetry";
import {
	type AgentHarnessSessionSegmentCursor,
	type CodingAgentV3EntryCursor,
	type HarnessActivationReason,
	type SessionAttachmentReason,
	type SessionEntryDigest,
	type SessionSegmentCursor,
	TRACE_SCHEMA_VERSION,
	type TraceFooterRecord,
	type TraceHarnessActivateRecord,
	type TraceHeaderRecord,
	type TraceHealth,
	type TraceMetadata,
	type TraceProducer,
	type TraceRecord,
	type TraceRuntimeIdentity,
	type TraceSessionAttachRecord,
	type TraceSessionSegmentRecord,
	type TraceSpanEndRecord,
	type TraceSpanEventRecord,
	type TraceSpanStartRecord,
	type TraceTelemetrySchemaVersions,
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

function positiveIntegerValue(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		invalidRecord(`${name} must be a positive safe integer`);
	}
	return value;
}

function nonNegativeIntegerValue(value: unknown, name: string): number {
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
		droppedRecords: nonNegativeIntegerValue(health.droppedRecords, "health.droppedRecords"),
		writerErrors: nonNegativeIntegerValue(health.writerErrors, "health.writerErrors"),
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

function telemetrySchemaVersionsValue(value: unknown): TraceTelemetrySchemaVersions {
	const versions = recordValue(value, "producer.telemetrySchemaVersions");
	const parsed: Record<string, number> = {};
	for (const [name, version] of Object.entries(versions)) {
		if (name.length === 0) invalidRecord("telemetry schema names must be non-empty");
		parsed[name] = positiveIntegerValue(version, `producer.telemetrySchemaVersions.${name}`);
	}
	return parsed;
}

function runtimeValue(value: unknown): TraceRuntimeIdentity {
	const runtime = recordValue(value, "producer.runtime");
	exactKeys(runtime, ["kind", "version"], "producer.runtime");
	return {
		kind: nonEmptyStringValue(runtime.kind, "producer.runtime.kind"),
		version: nonEmptyStringValue(runtime.version, "producer.runtime.version"),
	};
}

function producerValue(value: unknown): TraceProducer {
	const producer = recordValue(value, "producer");
	exactKeys(
		producer,
		["diffexVersion", "sourceRevision", "runtime", "telemetrySchemaVersions", "metadata"],
		"producer",
	);
	return {
		diffexVersion: nonEmptyStringValue(producer.diffexVersion, "producer.diffexVersion"),
		sourceRevision: nonEmptyStringValue(producer.sourceRevision, "producer.sourceRevision"),
		runtime: runtimeValue(producer.runtime),
		telemetrySchemaVersions: telemetrySchemaVersionsValue(producer.telemetrySchemaVersions),
		metadata: metadataValue(producer.metadata),
	};
}

function commonRecord(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	exactKeys(value, ["type", "sequence", "timestamp", ...keys], name);
	positiveIntegerValue(value.sequence, "sequence");
	timestampValue(value.timestamp);
}

function parseHeader(value: Record<string, unknown>): TraceHeaderRecord {
	commonRecord(value, ["schemaVersion", "traceId", "producer"], "trace_header");
	if (value.sequence !== 1) invalidRecord("trace_header sequence must be 1");
	if (value.schemaVersion !== TRACE_SCHEMA_VERSION) invalidRecord("unsupported schema version");
	return {
		type: "trace_header",
		sequence: 1,
		timestamp: timestampValue(value.timestamp),
		schemaVersion: TRACE_SCHEMA_VERSION,
		traceId: nonEmptyStringValue(value.traceId, "traceId"),
		producer: producerValue(value.producer),
	};
}

const sessionAttachmentReasons = new Set<SessionAttachmentReason>([
	"startup",
	"resume",
	"new",
	"import",
	"fork",
	"switch",
]);

function sessionAttachmentReasonValue(value: unknown): SessionAttachmentReason {
	const reason = nonEmptyStringValue(value, "reason") as SessionAttachmentReason;
	if (!sessionAttachmentReasons.has(reason)) invalidRecord("session attachment reason is invalid");
	return reason;
}

function parseSessionAttach(value: Record<string, unknown>): TraceSessionAttachRecord {
	commonRecord(
		value,
		["bindingId", "sessionId", "path", "sessionFormat", "formatVersion", "reason"],
		"session_attach",
	);
	return {
		type: "session_attach",
		sequence: positiveIntegerValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		bindingId: nonEmptyStringValue(value.bindingId, "bindingId"),
		sessionId: nonEmptyStringValue(value.sessionId, "sessionId"),
		path: nonEmptyStringValue(value.path, "path"),
		sessionFormat: nonEmptyStringValue(value.sessionFormat, "sessionFormat"),
		formatVersion: positiveIntegerValue(value.formatVersion, "formatVersion"),
		reason: sessionAttachmentReasonValue(value.reason),
	};
}

const harnessActivationReasons = new Set<HarnessActivationReason>(["initial", "switch"]);

function harnessActivationReasonValue(value: unknown): HarnessActivationReason {
	const reason = nonEmptyStringValue(value, "reason") as HarnessActivationReason;
	if (!harnessActivationReasons.has(reason)) invalidRecord("harness activation reason is invalid");
	return reason;
}

function parseHarnessActivate(value: Record<string, unknown>): TraceHarnessActivateRecord {
	commonRecord(value, ["harnessVersion", "reason"], "harness_activate");
	return {
		type: "harness_activate",
		sequence: positiveIntegerValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		harnessVersion: nonEmptyStringValue(value.harnessVersion, "harnessVersion"),
		reason: harnessActivationReasonValue(value.reason),
	};
}

function parseSpanStart(value: Record<string, unknown>): TraceSpanStartRecord {
	commonRecord(value, ["spanId", "parentSpanId", "name", "attributes"], "span_start");
	const parentSpanId = value.parentSpanId === null ? null : positiveIntegerValue(value.parentSpanId, "parentSpanId");
	return {
		type: "span_start",
		sequence: positiveIntegerValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		spanId: positiveIntegerValue(value.spanId, "spanId"),
		parentSpanId,
		name: stringValue(value.name, "name"),
		attributes: attributesValue(value.attributes, "attributes"),
	};
}

function parseSpanEvent(value: Record<string, unknown>): TraceSpanEventRecord {
	commonRecord(value, ["spanId", "name", "attributes"], "span_event");
	return {
		type: "span_event",
		sequence: positiveIntegerValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		spanId: positiveIntegerValue(value.spanId, "spanId"),
		name: stringValue(value.name, "name"),
		attributes: attributesValue(value.attributes, "attributes"),
	};
}

function parseSpanEnd(value: Record<string, unknown>): TraceSpanEndRecord {
	commonRecord(value, ["spanId", "attributes", "status"], "span_end");
	return {
		type: "span_end",
		sequence: positiveIntegerValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		spanId: positiveIntegerValue(value.spanId, "spanId"),
		attributes: attributesValue(value.attributes, "attributes"),
		status: statusValue(value.status),
	};
}

function sessionEntryDigestValue(value: unknown, name: string): SessionEntryDigest {
	const digest = recordValue(value, name);
	exactKeys(digest, ["kind", "algorithm", "value"], name);
	if (digest.kind !== "prefix" && digest.kind !== "content") invalidRecord(`${name}.kind is invalid`);
	if (digest.algorithm !== "sha256") invalidRecord(`${name}.algorithm is invalid`);
	const digestValue = nonEmptyStringValue(digest.value, `${name}.value`);
	if (!/^[a-f0-9]{64}$/.test(digestValue)) invalidRecord(`${name}.value must be a lowercase SHA-256 digest`);
	return { kind: digest.kind, algorithm: "sha256", value: digestValue };
}

function codingAgentEntryCursorValue(value: unknown, name: string): CodingAgentV3EntryCursor {
	const cursor = recordValue(value, name);
	exactKeys(cursor, ["entryOrdinal", "entryId", "digest"], name);
	return {
		entryOrdinal: nonNegativeIntegerValue(cursor.entryOrdinal, `${name}.entryOrdinal`),
		entryId: nonEmptyStringValue(cursor.entryId, `${name}.entryId`),
		digest: sessionEntryDigestValue(cursor.digest, `${name}.digest`),
	};
}

function agentHarnessCursorValue(value: Record<string, unknown>): AgentHarnessSessionSegmentCursor {
	exactKeys(value, ["kind", "startSequence", "endSequence"], "cursor");
	const startSequence = positiveIntegerValue(value.startSequence, "cursor.startSequence");
	const endSequence = positiveIntegerValue(value.endSequence, "cursor.endSequence");
	if (endSequence < startSequence) invalidRecord("session segment ends before it starts");
	return { kind: "agent-harness", startSequence, endSequence };
}

function sessionSegmentCursorValue(value: unknown): SessionSegmentCursor {
	const cursor = recordValue(value, "cursor");
	if (cursor.kind === "agent-harness") return agentHarnessCursorValue(cursor);
	if (cursor.kind !== "coding-agent-v3") invalidRecord("cursor.kind is invalid");
	exactKeys(cursor, ["kind", "start", "end"], "cursor");
	const start = codingAgentEntryCursorValue(cursor.start, "cursor.start");
	const end = codingAgentEntryCursorValue(cursor.end, "cursor.end");
	if (end.entryOrdinal < start.entryOrdinal) invalidRecord("session segment ends before it starts");
	return { kind: "coding-agent-v3", start, end };
}

function parseSessionSegment(value: Record<string, unknown>): TraceSessionSegmentRecord {
	optionalKeys(
		value,
		["type", "sequence", "timestamp", "bindingId", "lane", "operationId", "cursor"],
		["taskLineageId"],
		"session_segment",
	);
	return {
		type: "session_segment",
		sequence: positiveIntegerValue(value.sequence, "sequence"),
		timestamp: timestampValue(value.timestamp),
		bindingId: nonEmptyStringValue(value.bindingId, "bindingId"),
		lane: nonEmptyStringValue(value.lane, "lane"),
		operationId: nonEmptyStringValue(value.operationId, "operationId"),
		...(value.taskLineageId === undefined
			? {}
			: { taskLineageId: nonEmptyStringValue(value.taskLineageId, "taskLineageId") }),
		cursor: sessionSegmentCursorValue(value.cursor),
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
		sequence: positiveIntegerValue(value.sequence, "sequence"),
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
	if (text.length === 0 || text.includes("\n") || text.includes("\r")) {
		invalidRecord("expected one LF-framed JSON value");
	}
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
		case "session_attach":
			return parseSessionAttach(value);
		case "harness_activate":
			return parseHarnessActivate(value);
		case "span_start":
			return parseSpanStart(value);
		case "span_event":
			return parseSpanEvent(value);
		case "span_end":
			return parseSpanEnd(value);
		case "session_segment":
			return parseSessionSegment(value);
		case "trace_footer":
			return parseFooter(value);
		default:
			return invalidRecord("unknown record type");
	}
}
