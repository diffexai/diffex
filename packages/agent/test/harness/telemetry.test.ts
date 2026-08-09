import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createTypedSpanStarter,
	NOOP_TELEMETRY_CONTEXT,
	type TelemetryContext,
} from "@earendil-works/diffex-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"diffex.harness.run",
			"diffex.harness.compaction",
			"diffex.harness.navigation",
			"diffex.harness.checkpoint",
			"diffex.harness.turn",
			"diffex.harness.step",
			"diffex.harness.tool",
			"diffex.harness.hook",
			"diffex.harness.sleep",
			"diffex.harness.event_handler",
			"diffex.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"diffex.harness.step",
			{
				"diffex.lane.name": "main",
				"diffex.operation.id": "operation",
				"diffex.step.kind": "assistant",
				"diffex.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "diffex.step.outcome": "succeeded" });
				await startChildSpan(
					"diffex.ai.request",
					{
						"diffex.ai.operation": "stream",
						"diffex.ai.provider": "provider",
						"diffex.ai.model": "model",
						"diffex.ai.api": "api",
						"diffex.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "diffex.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"diffex.ai.request">;
		type End = AiSpanEndAttributes<"diffex.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"diffex.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"diffex.ai.provider": string;
			"diffex.ai.model": string;
			"diffex.ai.api": string;
			"diffex.ai.streaming": boolean;
			"diffex.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["diffex.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			telemetryContext,
			"diffex.ai.request",
			{
				"diffex.ai.operation": "stream",
				"diffex.ai.provider": "provider",
				"diffex.ai.model": "model",
				"diffex.ai.api": "api",
				"diffex.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "diffex.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error diffex.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"diffex.ai.operation": "stream",
				"diffex.ai.provider": "provider",
				"diffex.ai.model": "model",
				"diffex.ai.api": "api",
				"diffex.ai.streaming": true,
				"diffex.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(telemetryContext, "diffex.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(telemetryContext, "diffex.ai.request", { "diffex.ai.operation": "stream" }, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"diffex.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"diffex.harness.run">;
		expectTypeOf<RunStart["diffex.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["diffex.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"diffex.harness.run",
			{
				"diffex.session.id": "session",
				"diffex.lane.name": "main",
				"diffex.operation.id": "operation",
				"diffex.operation.kind": "run",
				"diffex.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "diffex.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"diffex.session.id": "session",
				"diffex.lane.name": "main",
				"diffex.operation.id": "operation",
				"diffex.operation.kind": "run",
				"diffex.operation.recovery": false,
				"diffex.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "diffex.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"diffex.harness.checkpoint",
				{
					"diffex.lane.name": "main",
					"diffex.operation.id": "operation",
					"diffex.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "diffex.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"diffex.harness.run",
				{
					"diffex.session.id": "session",
					"diffex.lane.name": "main",
					"diffex.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"diffex.operation.kind": "navigation",
					"diffex.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "diffex.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
