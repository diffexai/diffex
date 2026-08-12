import type { AssistantMessage } from "@earendil-works/diffex-ai";
import type {
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	TelemetryContext,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
} from "@earendil-works/diffex-telemetry";

export type {
	AttributeValue,
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryAttributeDefinition,
	TelemetryAttributeMetadata,
	TelemetryAttributeType,
	TelemetryContext,
	TelemetryEventAttributeDefinition,
	TelemetryEventDefinition,
	TelemetryParentDefinition,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
	TelemetrySpanDefinition,
	TelemetryStartAttributeDefinition,
	TypedSpanStarter,
} from "@earendil-works/diffex-telemetry";

export const AI_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		"diffex.ai.request": {
			description: "One logical request to an AI provider",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.ai.operation": {
					type: "string",
					required: true,
					values: ["stream", "fetch_deferred", "cancel_deferred", "generate_images"],
					description: "Logical provider operation",
				},
				"diffex.ai.provider": {
					type: "string",
					required: true,
					description: "Selected provider id",
				},
				"diffex.ai.model": {
					type: "string",
					required: true,
					description: "Requested model id",
				},
				"diffex.ai.api": {
					type: "string",
					required: true,
					description: "Provider API id",
				},
				"diffex.ai.streaming": {
					type: "boolean",
					required: true,
					description: "Whether this operation returns a stream",
				},
				"diffex.ai.deferred": {
					type: "boolean",
					required: false,
					description: "Whether the operation requests or participates in deferred execution",
				},
			},
			endAttributes: {
				"diffex.ai.response.model": { type: "string", description: "Concrete response model" },
				"diffex.ai.response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response id",
				},
				"diffex.ai.response.stop_reason": {
					type: "string",
					values: ["stop", "length", "tool_use", "error", "aborted", "deferred"],
					description: "Normalized terminal response reason",
				},
				"diffex.ai.http.status_code": { type: "number", description: "Final HTTP status" },
				"diffex.ai.usage.input_tokens": { type: "number", description: "Reported input tokens" },
				"diffex.ai.usage.output_tokens": { type: "number", description: "Reported output tokens" },
				"diffex.ai.usage.cache_read_tokens": { type: "number", description: "Reported cache-read tokens" },
				"diffex.ai.usage.cache_write_tokens": {
					type: "number",
					description: "Reported cache-write tokens",
				},
				"diffex.ai.usage.reasoning_tokens": { type: "number", description: "Reported reasoning tokens" },
				"diffex.ai.usage.total_tokens": { type: "number", description: "Reported total tokens" },
				"diffex.ai.usage.cost": { type: "number", description: "Reported total cost" },
				"diffex.ai.stream.chunk_count": { type: "number", description: "Streamed update chunk count" },
				"diffex.ai.stream.time_to_first_chunk_ms": {
					type: "number",
					description: "Elapsed milliseconds to first update chunk",
				},
				"diffex.ai.error.type": {
					type: "string",
					cardinality: "low",
					description: "Provider or transport error class",
				},
			},
			status: { default: "ok", errorWhen: "The operation throws or returns an error result" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

export type AiSpanName = TelemetrySchemaSpanName<typeof AI_TELEMETRY_SCHEMA>;
export type AiSpanStartAttributes<Name extends AiSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanEndAttributes<Name extends AiSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
export type AiSpanAttributes<Name extends AiSpanName> = AiSpanStartAttributes<Name> & AiSpanEndAttributes<Name>;
export type AiSpanEventName<Name extends AiSpanName> = TelemetrySchemaSpanEventName<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpanEventAttributes<
	Name extends AiSpanName,
	EventName extends AiSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof AI_TELEMETRY_SCHEMA, Name, EventName>;
export type AiTelemetrySpan<Name extends AiSpanName> = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, Name>;
export type AiSpan = TelemetrySchemaSpanUnion<typeof AI_TELEMETRY_SCHEMA>;

export function startAiSpan<Name extends AiSpanName, const Attributes extends AiSpanStartAttributes<Name>, Result>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<AiSpanStartAttributes<Name>, Attributes>,
	callback: (span: AiTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	return telemetryContext.startSpan({ name, attributes }, (span) => callback(span as AiTelemetrySpan<Name>));
}

export interface AiRequestCompletionMetrics {
	chunkCount?: number;
	timeToFirstChunkMs?: number;
	httpStatusCode?: number;
	errorType?: string;
}

/** Add content-free completion metadata to an AI request span. */
export function completeAiRequestSpan(
	span: AiTelemetrySpan<"diffex.ai.request">,
	message: AssistantMessage,
	metrics: AiRequestCompletionMetrics = {},
): void {
	const stopReason =
		message.stopReason === "toolUse" ? "tool_use" : message.stopReason === "pending" ? undefined : message.stopReason;
	span.setAttributes({
		...(message.responseModel ? { "diffex.ai.response.model": message.responseModel } : {}),
		...(message.responseId ? { "diffex.ai.response.id": message.responseId } : {}),
		...(stopReason ? { "diffex.ai.response.stop_reason": stopReason } : {}),
		...(metrics.httpStatusCode === undefined ? {} : { "diffex.ai.http.status_code": metrics.httpStatusCode }),
		"diffex.ai.usage.input_tokens": message.usage.input,
		"diffex.ai.usage.output_tokens": message.usage.output,
		"diffex.ai.usage.cache_read_tokens": message.usage.cacheRead,
		"diffex.ai.usage.cache_write_tokens": message.usage.cacheWrite,
		...(message.usage.reasoning === undefined ? {} : { "diffex.ai.usage.reasoning_tokens": message.usage.reasoning }),
		"diffex.ai.usage.total_tokens": message.usage.totalTokens,
		"diffex.ai.usage.cost": message.usage.cost.total,
		...(metrics.chunkCount === undefined ? {} : { "diffex.ai.stream.chunk_count": metrics.chunkCount }),
		...(metrics.timeToFirstChunkMs === undefined
			? {}
			: { "diffex.ai.stream.time_to_first_chunk_ms": metrics.timeToFirstChunkMs }),
		...(metrics.errorType ? { "diffex.ai.error.type": metrics.errorType } : {}),
	});
	if (message.stopReason === "error") span.setStatus({ status: "error" });
}

/** Mark a thrown AI request failure without retaining a free-form error message. */
export function failAiRequestSpan(span: AiTelemetrySpan<"diffex.ai.request">, errorType: string): void {
	span.setAttributes({ "diffex.ai.error.type": errorType });
	span.setStatus({ status: "error" });
}

const HOOK_NAMES = [
	"before_run",
	"before_resume",
	"before_run_end",
	"transform_context",
	"before_request",
	"before_payload",
	"after_response",
	"before_tool",
	"after_tool",
	"before_compaction",
	"before_navigation",
] as const;

const EVENT_TYPES = [
	"run_start",
	"run_resume",
	"run_suspend",
	"run_abort",
	"run_end",
	"fault",
	"handler_error",
	"turn_start",
	"turn_end",
	"retry_scheduled",
	"retry_start",
	"retry_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_added",
	"write_pending",
	"queue_update",
	"fact_update",
	"config_update",
	"compaction_start",
	"compaction_end",
	"navigation_start",
	"navigation_end",
	"lane_created",
	"usage",
] as const;

const operationStartAttributes = {
	"diffex.session.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Session id",
	},
	"diffex.lane.name": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Lane name",
	},
	"diffex.operation.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Durable operation id",
	},
	"diffex.operation.recovery": {
		type: "boolean",
		required: true,
		description: "Whether this invocation resumes durable work",
	},
} as const;

const operationErrorAttributes = {
	"diffex.error.code": {
		type: "string",
		cardinality: "low",
		description: "Stable operation error code",
	},
	"diffex.error.type": {
		type: "string",
		cardinality: "low",
		description: "Low-cardinality operation error class",
	},
} as const;

export const HARNESS_TELEMETRY_SCHEMA = {
	version: 3,
	spans: {
		"diffex.harness.run": {
			description: "One admitted in-process run invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"diffex.operation.kind": {
					type: "string",
					required: true,
					values: ["run"],
					description: "Run operation kind",
				},
			},
			endAttributes: {
				"diffex.operation.outcome": {
					type: "string",
					values: ["completed", "aborted", "failed", "suspended"],
					description: "Run invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The run fails or throws" },
		},
		"diffex.harness.compaction": {
			description: "One admitted in-process manual compaction invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"diffex.operation.kind": {
					type: "string",
					required: true,
					values: ["compaction"],
					description: "Compaction operation kind",
				},
			},
			endAttributes: {
				"diffex.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Compaction invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The compaction fails or throws" },
		},
		"diffex.harness.navigation": {
			description: "One admitted in-process navigation invocation",
			parents: { kind: "root_or_external" },
			startAttributes: {
				...operationStartAttributes,
				"diffex.operation.kind": {
					type: "string",
					required: true,
					values: ["navigation"],
					description: "Navigation operation kind",
				},
			},
			endAttributes: {
				"diffex.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Navigation invocation outcome",
				},
				...operationErrorAttributes,
			},
			status: { default: "ok", errorWhen: "The navigation fails or throws" },
		},
		"diffex.harness.checkpoint": {
			description: "One run checkpoint",
			parents: { kind: "spans", spans: ["diffex.harness.run"] },
			startAttributes: {
				"diffex.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"diffex.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"diffex.checkpoint.kind": {
					type: "string",
					required: true,
					values: ["normal", "failure_drain", "abort_reconcile"],
					description: "Checkpoint purpose",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Checkpoint work throws" },
		},
		"diffex.harness.turn": {
			description: "One assistant response and its tool batch",
			parents: { kind: "spans", spans: ["diffex.harness.run"] },
			startAttributes: {
				"diffex.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"diffex.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"diffex.turn.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Invocation-local turn id",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "Turn work throws" },
		},
		"diffex.harness.step": {
			description: "One durable retry attempt",
			parents: {
				kind: "spans",
				spans: [
					"diffex.harness.turn",
					"diffex.harness.checkpoint",
					"diffex.harness.compaction",
					"diffex.harness.navigation",
				],
			},
			startAttributes: {
				"diffex.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"diffex.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"diffex.step.kind": {
					type: "string",
					required: true,
					values: ["assistant", "compaction", "branch_summary"],
					description: "Retryable step kind",
				},
				"diffex.step.attempt": {
					type: "number",
					required: true,
					description: "One-based durable attempt number",
				},
				"diffex.compaction.reason": {
					type: "string",
					required: false,
					values: ["manual", "threshold", "overflow"],
					description: "Compaction trigger",
				},
			},
			endAttributes: {
				"diffex.step.outcome": {
					type: "string",
					values: ["succeeded", "retry", "failed", "aborted", "deferred", "overflow"],
					description: "Attempt outcome",
				},
			},
			status: { default: "ok", errorWhen: "The attempt retries, fails, or throws" },
		},
		"diffex.harness.tool": {
			description: "One raw phase-2 tool execution",
			parents: { kind: "spans", spans: ["diffex.harness.turn", "diffex.harness.run"] },
			startAttributes: {
				"diffex.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"diffex.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"diffex.turn.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Invocation-local live turn id",
				},
				"diffex.tool.name": {
					type: "string",
					required: true,
					description: "Tool name",
				},
				"diffex.tool.call_id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Tool call id",
				},
				"diffex.tool.replay": {
					type: "string",
					required: true,
					values: ["never", "safe"],
					description: "Declared replay policy",
				},
				"diffex.tool.recovery": {
					type: "boolean",
					required: true,
					description: "Whether this is recovery execution",
				},
			},
			endAttributes: {
				"diffex.tool.is_error": {
					type: "boolean",
					description: "Whether raw phase-2 execution returned an error",
				},
			},
			status: { default: "ok", errorWhen: "Raw phase-2 execution returns an error" },
		},
		"diffex.harness.profile_route": {
			description: "One structural task-profile routing decision",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"diffex.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Session id before routing",
				},
				"diffex.routing.mode": {
					type: "string",
					required: true,
					values: ["auto", "pinned"],
					description: "Configured profile-routing mode",
				},
				"diffex.routing.trigger": {
					type: "string",
					required: true,
					values: ["initial_turn", "future_turn"],
					description: "Turn phase that triggered the routing pass",
				},
				"diffex.routing.current_profile_id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Profile active before routing",
				},
				"diffex.routing.current_harness_id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Harness active before routing, when one is established",
				},
				"diffex.routing.session_established": {
					type: "boolean",
					required: true,
					description: "Whether the session already contains task history",
				},
			},
			endAttributes: {
				"diffex.routing.outcome": {
					type: "string",
					values: ["bypassed", "selected", "reused", "stayed", "declined", "failed"],
					description: "Closed routing outcome",
				},
				"diffex.routing.target_profile_id": {
					type: "string",
					cardinality: "high",
					description: "Profile selected, proposed, or retained by routing",
				},
				"diffex.routing.harness_id": {
					type: "string",
					cardinality: "high",
					description: "Stable harness identifier associated with the routing outcome",
				},
				"diffex.routing.confidence": {
					type: "number",
					description: "Router confidence between zero and one",
				},
				"diffex.routing.fallback": {
					type: "string",
					values: ["completion_error", "invalid_output", "low_confidence"],
					description: "Structured fallback class when routing used one",
				},
			},
			status: { default: "ok", errorWhen: "Routing fails or throws" },
		},
		"diffex.harness.evolution": {
			description: "One structural EVOLVED note proposal or write pass",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"diffex.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Session id associated with the evolution pass",
				},
				"diffex.evolution.trigger": {
					type: "string",
					required: true,
					values: ["explicit", "run_settled", "session_shutdown"],
					description: "Trigger for the evolution pass",
				},
				"diffex.evolution.profile_id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Profile associated with the evolution pass",
				},
			},
			endAttributes: {
				"diffex.evolution.outcome": {
					type: "string",
					values: ["completed", "skipped", "failed"],
					description: "Evolution pass outcome",
				},
				"diffex.evolution.candidate_count": {
					type: "number",
					description: "Number of proposed notes",
				},
				"diffex.evolution.accepted_count": {
					type: "number",
					description: "Number of notes written",
				},
				"diffex.evolution.rejected_count": {
					type: "number",
					description: "Number of notes rejected or deduplicated",
				},
				"diffex.evolution.scope": {
					type: "string",
					values: ["global", "project"],
					description: "Scope written by an explicit evolution pass",
				},
			},
			status: { default: "ok", errorWhen: "Evolution evaluation or writing fails" },
		},
		"diffex.harness.hook": {
			description: "One registered hook handler invocation",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"diffex.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when accepted",
				},
				"diffex.hook.name": {
					type: "string",
					required: true,
					values: HOOK_NAMES,
					description: "Hook name",
				},
				"diffex.hook.registration_id": {
					type: "string",
					required: false,
					description: "Stable hook registration id",
				},
			},
			endAttributes: {
				"diffex.hook.outcome": {
					type: "string",
					values: ["completed", "skipped", "blocked", "failed"],
					description: "Handler outcome",
				},
			},
			status: { default: "ok", errorWhen: "The handler throws" },
		},
		"diffex.harness.sleep": {
			description: "One retry delay",
			parents: { kind: "spans", spans: ["diffex.harness.step", "diffex.harness.run"] },
			startAttributes: {
				"diffex.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				"diffex.sleep.delay_ms": {
					type: "number",
					required: true,
					description: "Requested delay in milliseconds",
				},
			},
			endAttributes: {
				"diffex.sleep.outcome": {
					type: "string",
					values: ["elapsed", "aborted"],
					description: "Delay outcome",
				},
			},
			status: { default: "ok", errorWhen: "Sleep work throws" },
		},
		"diffex.harness.event_handler": {
			description: "One passive event listener invocation",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.event.type": {
					type: "string",
					required: true,
					cardinality: "low",
					values: EVENT_TYPES,
					description: "Delivered harness event type",
				},
				"diffex.lane.name": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Lane name for lane-scoped events",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "The listener throws" },
		},
		"diffex.session.write": {
			description: "One committed session mutation",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				"diffex.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when accepted",
				},
				"diffex.session.mutation": {
					type: "string",
					required: true,
					values: ["entry", "record", "lane", "fact"],
					description: "Session mutation kind",
				},
				"diffex.session.item_type": {
					type: "string",
					required: false,
					description: "Entry, record, lane, or fact subtype",
				},
			},
			endAttributes: {
				"diffex.session.seq": {
					type: "number",
					description: "Committed session sequence when exposed",
				},
			},
			status: { default: "ok", errorWhen: "Storage rejects the mutation" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

/** Combined typed span vocabulary for agent-owned AI-request and harness telemetry. */
export const AGENT_TELEMETRY_SCHEMAS = [AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA] as const;

export type HarnessSpanName = TelemetrySchemaSpanName<typeof HARNESS_TELEMETRY_SCHEMA>;
export type HarnessSpanStartAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanEndAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanAttributes<Name extends HarnessSpanName> = HarnessSpanStartAttributes<Name> &
	HarnessSpanEndAttributes<Name>;
export type HarnessSpanEventName<Name extends HarnessSpanName> = TelemetrySchemaSpanEventName<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpanEventAttributes<
	Name extends HarnessSpanName,
	EventName extends HarnessSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof HARNESS_TELEMETRY_SCHEMA, Name, EventName>;
export type HarnessTelemetrySpan<Name extends HarnessSpanName> = SchemaTelemetrySpan<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
export type HarnessSpan = TelemetrySchemaSpanUnion<typeof HARNESS_TELEMETRY_SCHEMA>;

export function startHarnessSpan<
	Name extends HarnessSpanName,
	const Attributes extends HarnessSpanStartAttributes<Name>,
	Result,
>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<HarnessSpanStartAttributes<Name>, Attributes>,
	callback: (span: HarnessTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	return telemetryContext.startSpan({ name, attributes }, (span: TelemetrySpan) =>
		callback(span as HarnessTelemetrySpan<Name>),
	);
}
