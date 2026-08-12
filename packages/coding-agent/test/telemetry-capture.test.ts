import { describe, expect, it } from "vitest";
import { startProfileRouteSpan } from "../src/core/runtime-telemetry.ts";
import { BoundedTelemetryCapture, readEvolutionTraceSnapshot } from "../src/core/telemetry-capture.ts";

describe("bounded runtime telemetry capture", () => {
	it("summarizes only newly settled content-free structural spans", async () => {
		const capture = new BoundedTelemetryCapture({ maxSpans: 16 });
		await capture.context.startSpan(
			{
				name: "pi.harness.tool",
				attributes: {
					"pi.tool.name": "read",
					"pi.tool.is_error": true,
					"pi.tool.call_id": "call-1",
				},
			},
			(span) => span.setStatus({ status: "error" }),
		);
		await capture.context.startSpan(
			{
				name: "pi.harness.profile_route",
				attributes: {
					"pi.routing.outcome": "reused",
					"pi.routing.target_profile_id": "research",
					"pi.routing.harness_id": "harness-1",
				},
			},
			() => {},
		);

		const first = readEvolutionTraceSnapshot(capture);
		expect(first.tools).toEqual([{ name: "read", callCount: 1, failureCount: 1 }]);
		expect(first.routes).toEqual([{ outcome: "reused", targetProfileId: "research", harnessId: "harness-1" }]);
		expect(JSON.stringify(first)).not.toContain("call-1");
		expect(readEvolutionTraceSnapshot(capture, first.cursor).tools).toEqual([]);
	});

	it("reports when bounded retention makes a snapshot incomplete", async () => {
		const capture = new BoundedTelemetryCapture({ maxSpans: 1 });
		await capture.context.startSpan({ name: "pi.harness.run" }, () => {});
		await capture.context.startSpan({ name: "pi.harness.run" }, () => {});

		const snapshot = readEvolutionTraceSnapshot(capture);
		expect(snapshot.runCount).toBe(1);
		expect(snapshot.incomplete).toBe(true);
		expect(snapshot.droppedSpanCount).toBe(1);
	});

	it("captures typed route structure without router content", async () => {
		const capture = new BoundedTelemetryCapture();
		await startProfileRouteSpan(
			capture.context,
			{
				sessionId: "session-1",
				routingMode: "auto",
				trigger: "future_turn",
				currentProfileId: "research",
				currentHarnessId: "research-harness",
				sessionEstablished: true,
			},
			({ complete }) => {
				complete({
					outcome: "declined",
					targetProfileId: "finance",
					harnessId: "finance-harness",
					confidence: 0.97,
				});
			},
		);

		const [route] = capture.readSettled().spans;
		expect(route?.attributes).toMatchObject({
			"pi.routing.trigger": "future_turn",
			"pi.routing.current_harness_id": "research-harness",
			"pi.routing.outcome": "declined",
			"pi.routing.target_profile_id": "finance",
			"pi.routing.harness_id": "finance-harness",
		});
		expect(Object.keys(route?.attributes ?? {})).not.toContain("pi.routing.reason");
		expect(route?.status.status).toBe("ok");
		expect(readEvolutionTraceSnapshot(capture).routes).toEqual([
			{
				trigger: "future_turn",
				currentHarnessId: "research-harness",
				outcome: "declined",
				targetProfileId: "finance",
				harnessId: "finance-harness",
			},
		]);
	});

	it("summarizes a future route that stays on the active harness", async () => {
		const capture = new BoundedTelemetryCapture();
		await startProfileRouteSpan(
			capture.context,
			{
				sessionId: "session-1",
				routingMode: "auto",
				trigger: "future_turn",
				currentProfileId: "research",
				currentHarnessId: "research-harness",
				sessionEstablished: true,
			},
			({ complete }) => {
				complete({
					outcome: "stayed",
					targetProfileId: "research",
					harnessId: "research-harness",
				});
			},
		);

		expect(readEvolutionTraceSnapshot(capture).routes).toEqual([
			{
				trigger: "future_turn",
				currentHarnessId: "research-harness",
				outcome: "stayed",
				targetProfileId: "research",
				harnessId: "research-harness",
			},
		]);
	});
});
