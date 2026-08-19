import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	encodeTraceRecord,
	materializeJsonlInvocation,
	serializeMaterializedInvocation,
	type TraceRecord,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryTracePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "diffex-materializer-"));
	temporaryDirectories.push(directory);
	return join(directory, "trace.jsonl");
}

function traceRecords(options: { footer?: boolean; degraded?: boolean } = {}): TraceRecord[] {
	const records: TraceRecord[] = [
		{
			type: "trace_header",
			sequence: 1,
			timestamp: "2026-08-18T10:00:00.000Z",
			schemaVersion: 1,
			traceId: "trace-materialized",
			producer: {
				diffexVersion: "0.2.0",
				sourceRevision: "abcdef",
				runtime: { kind: "node", version: "22.19.0" },
				telemetrySchemaVersions: { agent: 1 },
				metadata: {},
			},
		},
		{
			type: "span_start",
			sequence: 2,
			timestamp: "2026-08-18T10:00:00.100Z",
			spanId: 1,
			parentSpanId: null,
			name: "diffex.agent.run",
			attributes: { "diffex.invocation.id": "invocation-1" },
		},
		{
			type: "span_event",
			sequence: 3,
			timestamp: "2026-08-18T10:00:00.200Z",
			spanId: 1,
			name: "checkpoint",
			attributes: { "diffex.operation.id": "operation-1" },
		},
		{
			type: "span_end",
			sequence: 4,
			timestamp: "2026-08-18T10:00:00.300Z",
			spanId: 1,
			attributes: { "diffex.agent.outcome": "completed" },
			status: { status: "ok" },
		},
	];
	if (options.footer !== false) {
		records.push({
			type: "trace_footer",
			sequence: 5,
			timestamp: "2026-08-18T10:00:00.400Z",
			terminationStatus: "completed",
			health: {
				droppedRecords: options.degraded ? 2 : 0,
				writerErrors: options.degraded ? 1 : 0,
				writerDisabled: options.degraded ?? false,
				closed: true,
			},
		});
	}
	return records;
}

async function writeTrace(path: string, records: readonly TraceRecord[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, records.map(encodeTraceRecord).join(""), "utf8");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("invocation materializer", () => {
	it("joins span records into deterministic trace evidence", async () => {
		const path = await temporaryTracePath();
		await writeTrace(path, traceRecords());

		const first = await materializeJsonlInvocation(path);
		const second = await materializeJsonlInvocation(path);

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			version: 1,
			traceId: "trace-materialized",
			integrity: "complete",
			terminationStatus: "completed",
		});
		expect(first.evidence.map((item) => item.kind)).toEqual(["trace_record", "span", "trace_record"]);
		const span = first.evidence.find((item) => item.kind === "span");
		expect(span).toMatchObject({
			evidenceId: "trace-materialized:span:1",
			order: {
				traceSequence: 2,
				parentSpanId: null,
				causalIdentifiers: [
					{ name: "diffex.invocation.id", value: "invocation-1" },
					{ name: "diffex.operation.id", value: "operation-1" },
				],
			},
			traceSources: [
				expect.objectContaining({ sequence: 2 }),
				expect.objectContaining({ sequence: 3 }),
				expect.objectContaining({ sequence: 4 }),
			],
			payload: {
				name: "diffex.agent.run",
				settled: true,
				status: { status: "ok" },
				events: [expect.objectContaining({ name: "checkpoint" })],
			},
		});
		expect(serializeMaterializedInvocation(first)).toBe(serializeMaterializedInvocation(second));
	});

	it("retains crashed and writer-degraded evidence with diagnostics", async () => {
		const crashedPath = await temporaryTracePath();
		await writeTrace(crashedPath, traceRecords({ footer: false }));
		const crashed = await materializeJsonlInvocation(crashedPath);
		expect(crashed.terminationStatus).toBe("crashed");
		expect(crashed.integrity).toBe("partial");
		expect(crashed.diagnostics).toEqual([
			expect.objectContaining({ code: "trace_integrity", sourceCode: "missing_footer" }),
		]);

		const degradedPath = await temporaryTracePath();
		await writeTrace(degradedPath, traceRecords({ degraded: true }));
		const degraded = await materializeJsonlInvocation(degradedPath);
		expect(degraded.integrity).toBe("partial");
		expect(degraded.diagnostics).toEqual([
			expect.objectContaining({ code: "trace_writer_degraded", traceSequence: 5 }),
		]);
	});
});
