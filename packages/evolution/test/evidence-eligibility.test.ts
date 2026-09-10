import type { MaterializedEvidence, MaterializedInvocation } from "@diffexai/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import { classifyEvolutionEvidence, selectEvolutionEvidence } from "../src/evidence-eligibility.ts";

function invocation(evidence: readonly MaterializedEvidence[]): MaterializedInvocation {
	return {
		version: 1,
		tracePath: "/traces/example.jsonl",
		traceId: "example",
		producer: null,
		integrity: "complete",
		terminationStatus: "completed",
		health: null,
		ordering: {
			criteria: ["trace_sequence", "session_cursor", "timestamp", "span_parentage", "causal_id"],
			ambiguity: [],
		},
		evidence,
		diagnostics: [],
	};
}

function traceRecord(type: "harness_activate" | "trace_footer"): MaterializedEvidence {
	const payload =
		type === "harness_activate"
			? {
					type,
					sequence: 1,
					timestamp: "2026-08-22T12:00:00.000Z",
					harnessVersion: "version-1",
					reason: "initial" as const,
				}
			: {
					type,
					sequence: 2,
					timestamp: "2026-08-22T12:00:01.000Z",
					terminationStatus: "completed" as const,
					health: { droppedRecords: 0, writerErrors: 0, writerDisabled: false, closed: true },
				};
	return {
		kind: "trace_record",
		evidenceId: `example:${type}`,
		order: {
			traceSequence: payload.sequence,
			timestamp: payload.timestamp,
			causalIdentifiers: [],
			ambiguity: [],
		},
		traceSources: [],
		payload,
	};
}

function operationSpan(kind: string, status: "error" | "ok" = "ok"): MaterializedEvidence {
	return {
		kind: "span",
		evidenceId: `example:operation:${kind}`,
		order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
		traceSources: [],
		payload: {
			spanId: 1,
			parentSpanId: null,
			name: "diffex.coding_agent.operation",
			startedAt: "2026-08-22T12:00:00.000Z",
			endedAt: "2026-08-22T12:00:01.000Z",
			startAttributes: { "diffex.operation.kind": kind },
			endAttributes: {},
			events: [],
			status: status === "ok" ? { status } : { status, error: { name: "Error", message: "failed turn" } },
			settled: true,
		},
	};
}

function extensionHookSpan(): MaterializedEvidence {
	return {
		kind: "span",
		evidenceId: "example:extension-hook:session-start",
		order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
		traceSources: [],
		payload: {
			spanId: 1,
			parentSpanId: null,
			name: "diffex.coding_agent.extension_hook",
			startedAt: "2026-08-22T12:00:00.000Z",
			endedAt: "2026-08-22T12:00:01.000Z",
			startAttributes: {
				"diffex.extension.hook": "session_start",
				"diffex.extension.path": "/extensions/widget.ts",
			},
			endAttributes: { "diffex.extension.outcome": "completed" },
			events: [],
			status: { status: "ok" },
			settled: true,
		},
	};
}

function errorDiagnostic(): MaterializedEvidence {
	return {
		kind: "span",
		evidenceId: "example:diagnostic",
		order: { traceSequence: 2, timestamp: null, causalIdentifiers: [], ambiguity: [] },
		traceSources: [],
		payload: {
			spanId: 2,
			parentSpanId: null,
			name: "diffex.coding_agent.diagnostic",
			startedAt: "2026-08-22T12:00:00.000Z",
			endedAt: "2026-08-22T12:00:01.000Z",
			startAttributes: { "diffex.diagnostic.severity": "error" },
			endAttributes: {},
			events: [],
			status: { status: "error", error: { name: "Error", message: "provider disconnected" } },
			settled: true,
		},
	};
}

it("excludes lifecycle-only runtime traces", () => {
	expect(
		classifyEvolutionEvidence(invocation([traceRecord("harness_activate"), traceRecord("trace_footer")])),
	).toEqual({
		eligible: false,
		reason: "non-substantive-runtime-trace",
	});
});

it("does not count an idle shutdown operation as learning evidence", () => {
	expect(classifyEvolutionEvidence(invocation([operationSpan("abort"), traceRecord("trace_footer")]))).toEqual({
		eligible: false,
		reason: "non-substantive-runtime-trace",
	});
});

it("does not count an empty successful prompt operation as learning evidence", () => {
	expect(classifyEvolutionEvidence(invocation([operationSpan("prompt")]))).toEqual({
		eligible: false,
		reason: "non-substantive-runtime-trace",
	});
});

it("does not count a successful lifecycle extension hook as learning evidence", () => {
	const candidate = invocation([extensionHookSpan(), operationSpan("abort"), traceRecord("trace_footer")]);

	expect(classifyEvolutionEvidence(candidate)).toEqual({
		eligible: false,
		reason: "non-substantive-runtime-trace",
	});
	expect(selectEvolutionEvidence(candidate).evidence).toEqual([]);
});

it("retains a failed prompt operation as meaningful failure evidence", () => {
	expect(classifyEvolutionEvidence(invocation([operationSpan("prompt", "error")]))).toEqual({ eligible: true });
});

it("keeps standalone runtime diagnostics outside evolution", () => {
	expect(classifyEvolutionEvidence(invocation([errorDiagnostic()]))).toEqual({
		eligible: false,
		reason: "non-substantive-runtime-trace",
	});
});

describe("substantive runtime traces", () => {
	it.each(["user", "assistant", "toolResult"] as const)("includes %s payloads", (role) => {
		const evidence: MaterializedEvidence = {
			kind: "session_item",
			evidenceId: `example:${role}`,
			itemType: "message",
			order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
			traceSources: [],
			payload: { message: { role, content: "substantive payload" } },
		};
		expect(classifyEvolutionEvidence(invocation([evidence]))).toEqual({ eligible: true });
	});

	it("retains task evidence while removing trailing shutdown metadata", () => {
		const userMessage: MaterializedEvidence = {
			kind: "session_item",
			evidenceId: "example:user",
			itemType: "message",
			order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
			traceSources: [],
			payload: { message: { role: "user", content: "Fix the failing test" } },
		};
		const selected = selectEvolutionEvidence(
			invocation([userMessage, operationSpan("abort"), traceRecord("trace_footer")]),
		);

		expect(classifyEvolutionEvidence(selected)).toEqual({ eligible: true });
		expect(selected.evidence).toEqual([userMessage]);
	});

	it("retains supporting spans only when substantive payload anchors the trace", () => {
		const userMessage: MaterializedEvidence = {
			kind: "session_item",
			evidenceId: "example:user-with-extension",
			itemType: "message",
			order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
			traceSources: [],
			payload: { message: { role: "user", content: "Fix the extension behavior" } },
		};
		const supportingSpan = extensionHookSpan();

		expect(selectEvolutionEvidence(invocation([supportingSpan, userMessage])).evidence).toEqual([
			supportingSpan,
			userMessage,
		]);
	});

	it("retains error diagnostics that accompany substantive work", () => {
		const task = operationSpan("prompt", "error");
		const diagnostic = errorDiagnostic();

		expect(selectEvolutionEvidence(invocation([task, diagnostic])).evidence).toEqual([task, diagnostic]);
	});
});
