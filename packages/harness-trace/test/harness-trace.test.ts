import { type FileHandle, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
		sessionId: "session-1",
		sessionPath: "/sessions/session-1.jsonl",
		producerVersion: "0.2.0",
		codeRevision: "abcdef",
		harnessVersion: "sha256:1234",
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
	it("records ordered timestamps, nesting, events, merged attributes, statuses, and session ranges", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-08-18T10:00:00.000Z"));
		const path = await temporaryTracePath();
		const context = await createTrace(path);
		const automaticFailure = new Error("automatic failure");

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
		context.recordSessionRange({ lane: "main", operationId: "operation-1", startSequence: 12, endSequence: 19 });
		await context.close("completed");

		const records = await readRecords(context, path);
		expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
		expect(records.map((record) => record.type)).toEqual([
			"trace_header",
			"span_start",
			"span_event",
			"span_start",
			"span_start",
			"span_end",
			"span_end",
			"span_end",
			"session_range",
			"trace_footer",
		]);
		const header = records[0];
		expect(header).toMatchObject({
			type: "trace_header",
			timestamp: "2026-08-18T10:00:00.000Z",
			traceId: "trace-1",
			session: { id: "session-1", path: "/sessions/session-1.jsonl" },
			producer: { metadata: { invocation: "test", attempt: 2, enabled: true, empty: null } },
		});
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
			type: "session_range",
			timestamp: "2026-08-18T10:00:02.000Z",
			lane: "main",
			operationId: "operation-1",
			startSequence: 12,
			endSequence: 19,
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
			sessionId: "session-copy",
			producerVersion: "0.2.0",
			codeRevision: "revision",
			harnessVersion: "harness",
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
				session: { id: "session" },
				producer: { version: "1", codeRevision: "r", harnessVersion: "h", metadata: {} },
			}),
		],
		[
			"invalid range",
			JSON.stringify({
				type: "session_range",
				sequence: 2,
				timestamp: "2026-08-18T10:00:00.000Z",
				lane: "main",
				operationId: "operation",
				startSequence: 3,
				endSequence: 2,
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
