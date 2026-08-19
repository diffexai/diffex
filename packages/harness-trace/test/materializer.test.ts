import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	encodeTraceRecord,
	materializeJsonlInvocation,
	type SessionSegmentCursor,
	serializeMaterializedInvocation,
	type TraceRecord,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

async function temporaryTracePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "diffex-materializer-"));
	temporaryDirectories.push(directory);
	return join(directory, "trace.jsonl");
}

function fixturePath(name: string): string {
	return fileURLToPath(new URL(`./fixtures/materialization/${name}`, import.meta.url));
}

async function temporaryPath(name: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "diffex-materializer-session-"));
	temporaryDirectories.push(directory);
	return join(directory, name);
}

interface SessionTraceOptions {
	readonly traceId: string;
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly sessionFormat: string;
	readonly formatVersion: number;
	readonly reason: "resume" | "switch";
	readonly cursor: SessionSegmentCursor;
	readonly terminationStatus?: "completed" | "failed" | "aborted";
}

function sessionTrace(options: SessionTraceOptions): TraceRecord[] {
	return [
		{
			type: "trace_header",
			sequence: 1,
			timestamp: "2026-08-18T10:00:00.000Z",
			schemaVersion: 1,
			traceId: options.traceId,
			producer: {
				diffexVersion: "0.2.0",
				sourceRevision: "abcdef",
				runtime: { kind: "node", version: "22.19.0" },
				telemetrySchemaVersions: { agent: 1, "coding-agent": 2, harness: 1 },
				metadata: {},
			},
		},
		{
			type: "session_attach",
			sequence: 2,
			timestamp: "2026-08-18T10:00:00.100Z",
			bindingId: `${options.traceId}-binding`,
			sessionId: options.sessionId,
			path: options.sessionPath,
			sessionFormat: options.sessionFormat,
			formatVersion: options.formatVersion,
			reason: options.reason,
		},
		{
			type: "session_segment",
			sequence: 3,
			timestamp: "2026-08-18T10:00:05.000Z",
			bindingId: `${options.traceId}-binding`,
			lane: "main",
			operationId: `${options.traceId}-operation`,
			cursor: options.cursor,
		},
		{
			type: "trace_footer",
			sequence: 4,
			timestamp: "2026-08-18T10:00:06.000Z",
			terminationStatus: options.terminationStatus ?? "completed",
			health: { droppedRecords: 0, writerErrors: 0, writerDisabled: false, closed: true },
		},
	];
}

async function codingAgentCursor(path: string, start: number, end: number): Promise<SessionSegmentCursor> {
	const lines = (await readFile(path, "utf8"))
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
	const entryCursor = (entryOrdinal: number) => {
		const entry = lines[entryOrdinal];
		if (!entry || typeof entry.id !== "string") throw new Error(`Missing fixture entry ${entryOrdinal}`);
		return {
			entryOrdinal,
			entryId: entry.id,
			digest: {
				kind: "content" as const,
				algorithm: "sha256" as const,
				value: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
			},
		};
	};
	return { kind: "coding-agent-v3", start: entryCursor(start), end: entryCursor(end) };
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

	it("resolves coding-agent transcript evidence through immutable cursors", async () => {
		const sessionPath = fixturePath("coding-agent-v3-session.jsonl");
		const tracePath = await temporaryTracePath();
		await writeTrace(
			tracePath,
			sessionTrace({
				traceId: "coding-trace",
				sessionId: "coding-session",
				sessionPath: "/moved/coding-session.jsonl",
				sessionFormat: "coding-agent",
				formatVersion: 3,
				reason: "resume",
				cursor: await codingAgentCursor(sessionPath, 0, 3),
			}),
		);

		const invocation = await materializeJsonlInvocation(tracePath, {
			resolveSessionPath: () => sessionPath,
		});

		expect(invocation.integrity).toBe("complete");
		expect(invocation.ordering.ambiguity).toHaveLength(1);
		const sessionItems = invocation.evidence.filter((item) => item.kind === "session_item");
		expect(sessionItems.map((item) => item.itemType)).toEqual(["message", "message", "message", "compaction"]);
		expect(sessionItems[1]).toMatchObject({
			evidenceId: "coding-trace:session:coding-trace-binding:entry:entry-1:ordinal:1",
			order: {
				traceSequence: 3,
				sessionPosition: 1,
				causalIdentifiers: [
					{ name: "id", value: "entry-1" },
					{ name: "message.content.id", value: "tool-1" },
					{ name: "parentId", value: "entry-0" },
				],
			},
			sessionSource: {
				path: "/moved/coding-session.jsonl",
				resolvedPath: sessionPath,
				entryId: "entry-1",
				entryOrdinal: 1,
				segmentTraceSequences: [3],
			},
		});
		expect(sessionItems[3]?.payload).toMatchObject({
			type: "compaction",
			summary: "Inspected the source",
			usage: { input: 100, output: 20 },
		});
	});

	it("normalizes durable AgentHarness session sequences", async () => {
		const sessionPath = fixturePath("agent-harness-v4-session.jsonl");
		const tracePath = await temporaryTracePath();
		await writeTrace(
			tracePath,
			sessionTrace({
				traceId: "harness-trace",
				sessionId: "harness-session",
				sessionPath,
				sessionFormat: "agent-harness",
				formatVersion: 4,
				reason: "switch",
				cursor: { kind: "agent-harness", startSequence: 40, endSequence: 44 },
				terminationStatus: "aborted",
			}),
		);

		const invocation = await materializeJsonlInvocation(tracePath);

		expect(invocation.integrity).toBe("complete");
		expect(invocation.terminationStatus).toBe("aborted");
		const sessionItems = invocation.evidence.filter((item) => item.kind === "session_item");
		expect(sessionItems.map((item) => item.itemType)).toEqual([
			"entry.message",
			"record.step_attempt",
			"record.usage",
			"entry.compaction",
			"record.operation_finished",
		]);
		expect(sessionItems[1]).toMatchObject({
			evidenceId: "harness-trace:session:harness-trace-binding:sequence:41",
			order: {
				sessionPosition: 41,
				causalIdentifiers: [
					{ name: "id", value: "record-41" },
					{ name: "resultEntryId", value: "entry-42" },
					{ name: "runId", value: "run-1" },
				],
			},
			sessionSource: { sessionSequence: 41 },
		});
	});

	it.each(["failed", "aborted"] as const)("preserves %s invocation outcomes", async (terminationStatus) => {
		const sessionPath = fixturePath("agent-harness-v4-session.jsonl");
		const tracePath = await temporaryTracePath();
		await writeTrace(
			tracePath,
			sessionTrace({
				traceId: `${terminationStatus}-trace`,
				sessionId: "harness-session",
				sessionPath,
				sessionFormat: "agent-harness",
				formatVersion: 4,
				reason: "resume",
				cursor: { kind: "agent-harness", startSequence: 40, endSequence: 44 },
				terminationStatus,
			}),
		);

		expect((await materializeJsonlInvocation(tracePath)).terminationStatus).toBe(terminationStatus);
	});

	it("reports missing, changed, truncated, and incompatible session data", async () => {
		const fixture = fixturePath("coding-agent-v3-session.jsonl");
		const cursor = await codingAgentCursor(fixture, 0, 3);
		const changedPath = await temporaryPath("changed.jsonl");
		await writeFile(changedPath, (await readFile(fixture, "utf8")).replace("Inspected the source", "Changed"));
		const truncatedPath = await temporaryPath("truncated.jsonl");
		await writeFile(truncatedPath, (await readFile(fixture, "utf8")).split("\n").slice(0, 4).join("\n"));
		const incompatiblePath = fixturePath("agent-harness-v4-session.jsonl");

		const cases = [
			{ name: "missing", path: "/missing/session.jsonl", code: "session_missing" },
			{ name: "changed", path: changedPath, code: "session_changed" },
			{ name: "truncated", path: truncatedPath, code: "session_truncated" },
			{ name: "incompatible", path: incompatiblePath, code: "session_incompatible" },
		] as const;
		for (const testCase of cases) {
			const tracePath = await temporaryTracePath();
			await writeTrace(
				tracePath,
				sessionTrace({
					traceId: `${testCase.name}-session-trace`,
					sessionId: "coding-session",
					sessionPath: testCase.path,
					sessionFormat: "coding-agent",
					formatVersion: 3,
					reason: "resume",
					cursor,
				}),
			);
			const invocation = await materializeJsonlInvocation(tracePath);
			expect(invocation.integrity, testCase.name).not.toBe("complete");
			expect(
				invocation.diagnostics.map((item) => item.code),
				testCase.name,
			).toContain(testCase.code);
		}
	});
});
