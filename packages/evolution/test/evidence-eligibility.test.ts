import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { describe, expect, it } from "vitest";
import { classifyEvolutionEvidence } from "../src/evidence-eligibility.ts";

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

it("excludes lifecycle-only runtime traces", () => {
	expect(
		classifyEvolutionEvidence(invocation([traceRecord("harness_activate"), traceRecord("trace_footer")])),
	).toEqual({
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
});
