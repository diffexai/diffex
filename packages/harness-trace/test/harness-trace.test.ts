import { type FileHandle, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordedTelemetrySpan, SpanAttributes } from "@earendil-works/diffex-telemetry";
import {
	createTelemetryAdapterConformance,
	type TelemetryAdapterFixture,
} from "@earendil-works/diffex-telemetry/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createJsonlTraceContext,
	encodeTraceRecord,
	type JsonlTraceContext,
	parseTraceRecord,
	readJsonlTraceFile,
	type TraceFooterRecord,
	type TraceHeaderRecord,
	type TraceRecord,
	type TraceSpanEndRecord,
	type TraceSpanEventRecord,
	type TraceSpanStartRecord,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryTracePath(name = "trace.jsonl"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "diffex-harness-trace-"));
	temporaryDirectories.push(directory);
	return join(directory, "nested", name);
}

async function createTrace(path: string): Promise<JsonlTraceContext> {
	return createJsonlTraceContext({
		destinationPath: path,
		traceId: "trace-1",
		diffexVersion: "0.2.0",
		sourceRevision: "abcdef",
		runtimeKind: "node",
		runtimeVersion: "22.19.0",
		telemetrySchemaVersions: { ai: 1, harness: 1 },
		metadata: { invocation: "test", attempt: 2, enabled: true, empty: null },
	});
}

async function readRecords(context: JsonlTraceContext, path: string): Promise<TraceRecord[]> {
	await context.flush();
	const contents = await readFile(path, "utf8");
	return contents
		.split("\n")
		.filter((line) => line.length > 0)
		.map(parseTraceRecord);
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function traceHeader(): TraceHeaderRecord {
	return {
		type: "trace_header",
		sequence: 1,
		timestamp: "2026-08-18T10:00:00.000Z",
		schemaVersion: 1,
		traceId: "trace-reader",
		producer: {
			diffexVersion: "0.2.0",
			sourceRevision: "abcdef",
			runtime: { kind: "node", version: "22.19.0" },
			telemetrySchemaVersions: { ai: 1 },
			metadata: {},
		},
	};
}

function traceFooter(sequence: number): TraceFooterRecord {
	return {
		type: "trace_footer",
		sequence,
		timestamp: "2026-08-18T10:00:01.000Z",
		terminationStatus: "completed",
		health: { droppedRecords: 0, writerErrors: 0, writerDisabled: false, closed: true },
	};
}

async function writeTraceLines(path: string, lines: readonly string[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, lines.join(""), "utf8");
}

function normalizedSpans(records: readonly TraceRecord[]): readonly RecordedTelemetrySpan[] {
	const starts = records.filter((record): record is TraceSpanStartRecord => record.type === "span_start");
	const events = records.filter((record): record is TraceSpanEventRecord => record.type === "span_event");
	const ends = records.filter((record): record is TraceSpanEndRecord => record.type === "span_end");
	return starts.map((start) => {
		const end = ends.find((candidate) => candidate.spanId === start.spanId);
		return {
			id: start.spanId,
			parentId: start.parentSpanId,
			name: start.name,
			attributes: end?.attributes ?? start.attributes,
			events: events
				.filter((event) => event.spanId === start.spanId)
				.map((event) => ({ name: event.name, attributes: event.attributes })),
			status: end?.status ?? { status: "ok" },
			settled: end !== undefined,
			...(end === undefined ? {} : { endSequence: end.sequence }),
		};
	});
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const conformance = createTelemetryAdapterConformance(async () => {
	const path = await temporaryTracePath();
	const context = await createTrace(path);
	return {
		context,
		async getSpans() {
			return normalizedSpans(await readRecords(context, path));
		},
		[Symbol.asyncDispose]: () => context.close(),
	} satisfies TelemetryAdapterFixture;
});

describe("JSONL telemetry adapter conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("JSONL trace records", () => {
	it("records ordered telemetry across session and harness transitions", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-08-18T10:00:00.000Z"));
		const path = await temporaryTracePath();
		const context = await createTrace(path);
		const automaticFailure = new Error("automatic failure");
		context.attachSession({
			bindingId: "binding-1",
			sessionId: "session-1",
			path: "/sessions/session-1.jsonl",
			sessionFormat: "coding-agent",
			formatVersion: 3,
			reason: "startup",
		});
		context.activateHarness({ harnessVersion: "sha256:1234", reason: "initial" });

		const parentResult = context.startSpan(
			{ name: "parent", attributes: { retained: "start", overwritten: "start", omitted: undefined } },
			async (parent) => {
				vi.setSystemTime(new Date("2026-08-18T10:00:01.000Z"));
				parent.addEvent("checkpoint", { tags: ["one", "two"], omitted: undefined });
				parent.setAttributes({ overwritten: "end", count: 3 });
				const first = parent.startSpan({ name: "first" }, async () => {
					await Promise.resolve();
					throw automaticFailure;
				});
				const second = parent.startSpan({ name: "second" }, (span) => {
					span.setStatus({ status: "error", error: { name: "Expected", message: "declined" } });
					return "second-result";
				});
				expect(await second).toBe("second-result");
				await expect(first).rejects.toBe(automaticFailure);
				return "parent-result";
			},
		);
		expect(await parentResult).toBe("parent-result");
		vi.setSystemTime(new Date("2026-08-18T10:00:02.000Z"));
		context.recordSessionSegment({
			bindingId: "binding-1",
			lane: "main",
			operationId: "operation-1",
			cursor: {
				kind: "coding-agent-v3",
				start: {
					entryOrdinal: 12,
					entryId: "entry-12",
					digest: { kind: "prefix", algorithm: "sha256", value: "1".repeat(64) },
				},
				end: {
					entryOrdinal: 19,
					entryId: "entry-19",
					digest: { kind: "content", algorithm: "sha256", value: "2".repeat(64) },
				},
			},
		});
		context.attachSession({
			bindingId: "binding-2",
			sessionId: "session-2",
			path: "/sessions/session-2.db",
			sessionFormat: "agent-harness",
			formatVersion: 1,
			reason: "switch",
		});
		context.activateHarness({ harnessVersion: "sha256:5678", reason: "switch" });
		context.recordSessionSegment({
			bindingId: "binding-2",
			lane: "main",
			operationId: "operation-2",
			cursor: { kind: "agent-harness", startSequence: 20, endSequence: 27 },
		});
		await context.close("completed");

		const records = await readRecords(context, path);
		expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
		expect(records.map((record) => record.type)).toEqual([
			"trace_header",
			"session_attach",
			"harness_activate",
			"span_start",
			"span_event",
			"span_start",
			"span_start",
			"span_end",
			"span_end",
			"span_end",
			"session_segment",
			"session_attach",
			"harness_activate",
			"session_segment",
			"trace_footer",
		]);
		const header = records[0];
		expect(header).toMatchObject({
			type: "trace_header",
			timestamp: "2026-08-18T10:00:00.000Z",
			traceId: "trace-1",
			producer: {
				diffexVersion: "0.2.0",
				sourceRevision: "abcdef",
				runtime: { kind: "node", version: "22.19.0" },
				telemetrySchemaVersions: { ai: 1, harness: 1 },
				metadata: { invocation: "test", attempt: 2, enabled: true, empty: null },
			},
		});
		expect(records.filter((record) => record.type === "session_attach")).toEqual([
			expect.objectContaining({ bindingId: "binding-1", sessionId: "session-1", reason: "startup" }),
			expect.objectContaining({ bindingId: "binding-2", sessionId: "session-2", reason: "switch" }),
		]);
		expect(records.filter((record) => record.type === "harness_activate")).toEqual([
			expect.objectContaining({ harnessVersion: "sha256:1234", reason: "initial" }),
			expect.objectContaining({ harnessVersion: "sha256:5678", reason: "switch" }),
		]);
		const [parentStart, firstStart, secondStart] = records.filter(
			(record): record is TraceSpanStartRecord => record.type === "span_start",
		);
		expect(parentStart?.parentSpanId).toBeNull();
		expect(firstStart?.parentSpanId).toBe(parentStart?.spanId);
		expect(secondStart?.parentSpanId).toBe(parentStart?.spanId);
		const event = records.find((record): record is TraceSpanEventRecord => record.type === "span_event");
		expect(event).toMatchObject({
			timestamp: "2026-08-18T10:00:01.000Z",
			spanId: parentStart?.spanId,
			name: "checkpoint",
			attributes: { tags: ["one", "two"] },
		});
		const ends = records.filter((record): record is TraceSpanEndRecord => record.type === "span_end");
		expect(ends.find((record) => record.spanId === parentStart?.spanId)).toMatchObject({
			attributes: { retained: "start", overwritten: "end", count: 3 },
			status: { status: "ok" },
		});
		expect(ends.find((record) => record.spanId === firstStart?.spanId)?.status).toEqual({
			status: "error",
			error: { name: "Error", message: "automatic failure" },
		});
		expect(ends.find((record) => record.spanId === secondStart?.spanId)?.status).toEqual({
			status: "error",
			error: { name: "Expected", message: "declined" },
		});
		expect(records.at(-2)).toMatchObject({
			type: "session_segment",
			timestamp: "2026-08-18T10:00:02.000Z",
			bindingId: "binding-2",
			lane: "main",
			operationId: "operation-2",
			cursor: { kind: "agent-harness", startSequence: 20, endSequence: 27 },
		});
		expect(records.at(-1)).toMatchObject({
			type: "trace_footer",
			terminationStatus: "completed",
			health: { droppedRecords: 0, writerErrors: 0, writerDisabled: false, closed: true },
		});
	});

	it("copies attributes and metadata without retaining mutable inputs", async () => {
		const path = await temporaryTracePath();
		const metadata: Record<string, string | undefined> = { source: "original", omitted: undefined };
		const context = await createJsonlTraceContext({
			destinationPath: path,
			traceId: "trace-copy",
			diffexVersion: "0.2.0",
			sourceRevision: "revision",
			runtimeKind: "node",
			runtimeVersion: "22.19.0",
			telemetrySchemaVersions: { ai: 1 },
			metadata,
		});
		metadata.source = "mutated";
		const tags = ["original"];
		const attributes: SpanAttributes = { tags };
		await context.startSpan({ name: "copy", attributes }, (span) => {
			tags[0] = "mutated";
			(attributes.tags as string[])[0] = "mutated again";
			span.addEvent("copy-event", { tags });
			tags[0] = "late mutation";
		});
		await context.close();

		const records = await readRecords(context, path);
		expect(records[0]).toMatchObject({ producer: { metadata: { source: "original" } } });
		expect(records.find((record) => record.type === "span_start")).toMatchObject({
			attributes: { tags: ["original"] },
		});
		expect(records.find((record) => record.type === "span_event")).toMatchObject({
			attributes: { tags: ["mutated again"] },
		});
	});

	it("writes only one footer when close is repeated", async () => {
		const path = await temporaryTracePath();
		const context = await createTrace(path);
		const firstClose = context.close("aborted");
		expect(context.close("completed")).toBe(firstClose);
		await firstClose;
		await context.close("failed");

		const records = await readRecords(context, path);
		expect(records.filter((record) => record.type === "trace_footer")).toEqual([
			expect.objectContaining({ terminationStatus: "aborted" }),
		]);
	});

	it("opens destinations exclusively and creates parent directories", async () => {
		const path = await temporaryTracePath();
		const first = await createTrace(path);
		await expect(createTrace(path)).rejects.toMatchObject({ code: "EEXIST" });
		await first.close();
	});

	it("leaves a missing footer as an incomplete invocation marker", async () => {
		const path = await temporaryTracePath();
		const context = await createTrace(path);
		await context.startSpan({ name: "unfinished-invocation" }, () => "done");

		const incompleteRecords = await readRecords(context, path);
		expect(incompleteRecords.at(-1)?.type).toBe("span_end");
		expect(incompleteRecords.some((record) => record.type === "trace_footer")).toBe(false);
		await context.close();
	});

	it("suppresses serialization failures without disabling later writes", async () => {
		const path = await temporaryTracePath();
		const context = await createTrace(path);
		const result = await context.startSpan({ name: "serialization" }, (span) => {
			span.addEvent(1n as unknown as string);
			span.addEvent("retained", { value: true });
			return 42;
		});
		expect(result).toBe(42);
		await context.flush();
		expect(context.getHealth()).toMatchObject({ droppedRecords: 1, writerErrors: 1, writerDisabled: false });
		await context.close();

		const records = await readRecords(context, path);
		expect(records.filter((record) => record.type === "span_event")).toEqual([
			expect.objectContaining({ name: "retained", attributes: { value: true } }),
		]);
	});

	it("suppresses fatal writes, disables the writer, and preserves callback behavior", async () => {
		const path = await temporaryTracePath();
		const context = await createTrace(path);
		const probePath = await temporaryTracePath("probe");
		await mkdir(dirname(probePath), { recursive: true });
		const probe = await open(probePath, "wx");
		const fileHandlePrototype = Object.getPrototypeOf(probe) as { writeFile: FileHandleWrite };
		await probe.close();
		const writeFailure = vi
			.spyOn(fileHandlePrototype, "writeFile")
			.mockRejectedValue(new Error("simulated write failure"));

		const expected = { preserved: true };
		const result = context.startSpan({ name: "write-failure" }, (span) => {
			span.addEvent("queued-after-start");
			return expected;
		});
		expect(await result).toBe(expected);
		await context.flush();
		expect(context.getHealth()).toMatchObject({ droppedRecords: 3, writerErrors: 1, writerDisabled: true });
		writeFailure.mockRestore();
		await context.close("failed");

		const records = await readRecords(context, path);
		expect(records.map((record) => record.type)).toEqual(["trace_header"]);
		const readResult = await readJsonlTraceFile(path);
		expect(readResult.records).toEqual(records);
		expect(readResult.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing_footer");
	});
});

type FileHandleWrite = FileHandle["writeFile"];

describe("single-record codec", () => {
	it("round trips one LF-framed record", () => {
		const record: TraceRecord = {
			type: "span_event",
			sequence: 2,
			timestamp: "2026-08-18T10:00:00.000Z",
			spanId: 1,
			name: "event",
			attributes: { value: true },
		};
		expect(parseTraceRecord(encodeTraceRecord(record))).toEqual(record);
	});

	it.each([
		["malformed JSON", "{"],
		["multiple records", "{}\n{}\n"],
		["unknown record", '{"type":"unknown"}'],
		[
			"unsupported schema",
			JSON.stringify({
				type: "trace_header",
				sequence: 1,
				timestamp: "2026-08-18T10:00:00.000Z",
				schemaVersion: 2,
				traceId: "trace",
				producer: {
					diffexVersion: "1",
					sourceRevision: "r",
					runtime: { kind: "node", version: "22" },
					telemetrySchemaVersions: {},
					metadata: {},
				},
			}),
		],
		[
			"invalid segment",
			JSON.stringify({
				type: "session_segment",
				sequence: 2,
				timestamp: "2026-08-18T10:00:00.000Z",
				bindingId: "binding",
				lane: "main",
				operationId: "operation",
				cursor: { kind: "agent-harness", startSequence: 3, endSequence: 2 },
			}),
		],
		[
			"unknown field",
			JSON.stringify({
				type: "span_event",
				sequence: 2,
				timestamp: "2026-08-18T10:00:00.000Z",
				spanId: 1,
				name: "event",
				attributes: {},
				payload: "not allowed",
			}),
		],
	])("rejects %s", (_name, line) => {
		expect(() => parseTraceRecord(line)).toThrow(/invalid trace record/i);
	});
});

describe("whole-file reader", () => {
	it.each([
		["coding-agent-v3.jsonl", "coding-agent-v3"],
		["agent-harness.jsonl", "agent-harness"],
	])("validates the %s cursor fixture", async (name, cursorKind) => {
		const result = await readJsonlTraceFile(fixturePath(name));
		expect(result.diagnostics).toEqual([]);
		expect(result.closed).toBe(true);
		expect(result.records.find((record) => record.type === "session_segment")).toMatchObject({
			cursor: { kind: cursorKind },
		});
	});

	it("detects sequence gaps while preserving parsed records", async () => {
		const path = await temporaryTracePath();
		await writeTraceLines(path, [
			encodeTraceRecord(traceHeader()),
			encodeTraceRecord({
				type: "harness_activate",
				sequence: 3,
				timestamp: "2026-08-18T10:00:00.500Z",
				harnessVersion: "sha256:1234",
				reason: "initial",
			}),
			encodeTraceRecord(traceFooter(4)),
		]);

		const result = await readJsonlTraceFile(path);
		expect(result.records).toHaveLength(3);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "sequence_gap", sequence: 3 })]);
	});

	it.each([
		[
			"duplicate_header",
			[encodeTraceRecord(traceHeader()), encodeTraceRecord(traceHeader()), encodeTraceRecord(traceFooter(3))],
		],
		[
			"misplaced_header",
			[
				encodeTraceRecord({
					type: "harness_activate",
					sequence: 1,
					timestamp: "2026-08-18T10:00:00.000Z",
					harnessVersion: "sha256:1234",
					reason: "initial",
				}),
				encodeTraceRecord(traceHeader()),
				encodeTraceRecord(traceFooter(3)),
			],
		],
		[
			"duplicate_footer",
			[encodeTraceRecord(traceHeader()), encodeTraceRecord(traceFooter(2)), encodeTraceRecord(traceFooter(3))],
		],
		["misplaced_footer", [encodeTraceRecord(traceFooter(1)), encodeTraceRecord(traceHeader())]],
	] as const)("detects %s", async (diagnosticCode, lines) => {
		const path = await temporaryTracePath();
		await writeTraceLines(path, lines);
		const result = await readJsonlTraceFile(path);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(diagnosticCode);
	});

	it("detects invalid parentage and duplicate span settlement", async () => {
		const path = await temporaryTracePath();
		await writeTraceLines(path, [
			encodeTraceRecord(traceHeader()),
			encodeTraceRecord({
				type: "span_start",
				sequence: 2,
				timestamp: "2026-08-18T10:00:00.100Z",
				spanId: 1,
				parentSpanId: 99,
				name: "orphan",
				attributes: {},
			}),
			encodeTraceRecord({
				type: "span_end",
				sequence: 3,
				timestamp: "2026-08-18T10:00:00.200Z",
				spanId: 1,
				attributes: {},
				status: { status: "ok" },
			}),
			encodeTraceRecord({
				type: "span_end",
				sequence: 4,
				timestamp: "2026-08-18T10:00:00.300Z",
				spanId: 1,
				attributes: {},
				status: { status: "ok" },
			}),
			encodeTraceRecord(traceFooter(5)),
		]);

		const result = await readJsonlTraceFile(path);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"invalid_span_parentage",
			"duplicate_span_settlement",
		]);
	});

	it("detects records after closure", async () => {
		const path = await temporaryTracePath();
		await writeTraceLines(path, [
			encodeTraceRecord(traceHeader()),
			encodeTraceRecord(traceFooter(2)),
			encodeTraceRecord({
				type: "harness_activate",
				sequence: 3,
				timestamp: "2026-08-18T10:00:02.000Z",
				harnessVersion: "sha256:late",
				reason: "switch",
			}),
		]);

		const result = await readJsonlTraceFile(path);
		expect(result.records).toHaveLength(3);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "record_after_footer", sequence: 3 })]);
	});

	it("detects a partial final line and missing footer", async () => {
		const path = await temporaryTracePath();
		await writeTraceLines(path, [encodeTraceRecord(traceHeader()), '{"type":"trace_footer"']);

		const result = await readJsonlTraceFile(path);
		expect(result.records).toEqual([traceHeader()]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["partial_final_line", "missing_footer"]);
		expect(result.closed).toBe(false);
	});

	it("rejects a forward schema without interpreting later records", async () => {
		const path = await temporaryTracePath();
		await writeTraceLines(path, [
			`${JSON.stringify({ ...traceHeader(), schemaVersion: 2 })}\n`,
			encodeTraceRecord(traceFooter(2)),
		]);

		const result = await readJsonlTraceFile(path);
		expect(result.records).toEqual([]);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "incompatible_schema_version", lineNumber: 1 }),
		]);
		expect(result.closed).toBe(false);
	});
});
