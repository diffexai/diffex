import {
	InMemoryTelemetryContext,
	type SettledTelemetrySpanSnapshot,
	type TelemetryContext,
} from "@earendil-works/diffex-agent-core";

export type TelemetryCaptureSnapshot = SettledTelemetrySpanSnapshot;

/** Host-owned readable capture paired with the context passed into the runtime. */
export interface ReadableTelemetryCapture {
	readonly context: TelemetryContext;
	readSettled(afterEndSequence?: number): TelemetryCaptureSnapshot;
}

export interface BoundedTelemetryCaptureOptions {
	/** Maximum process-local spans retained for post-turn inspection. Defaults to 2,048. */
	maxSpans?: number;
}

export interface EvolutionToolSignal {
	name: string;
	callCount: number;
	failureCount: number;
}

export interface EvolutionRouteSignal {
	trigger?: "initial_turn" | "future_turn";
	currentHarnessId?: string;
	outcome: "bypassed" | "selected" | "reused" | "stayed" | "declined" | "failed";
	targetProfileId?: string;
	harnessId?: string;
	fallback?: "completion_error" | "invalid_output" | "low_confidence";
}

/** Content-free structural telemetry ready for a bounded post-turn evaluator. */
export interface EvolutionTraceSnapshot {
	cursor: number;
	droppedSpanCount: number;
	incomplete: boolean;
	runCount: number;
	failedRunCount: number;
	abortedRunCount: number;
	assistantAttemptCount: number;
	retryCount: number;
	failedStepCount: number;
	aiRequestCount: number;
	failedAiRequestCount: number;
	tools: readonly EvolutionToolSignal[];
	routes: readonly EvolutionRouteSignal[];
}

/**
 * Consume newly settled spans by cursor and reduce them to content-free signals.
 *
 * This does not infer preferences, inspect transcripts, or write EVOLVED. A host
 * coordinator must correlate useful signals with a bounded, redacted local
 * transcript before proposing durable notes.
 */
export function readEvolutionTraceSnapshot(
	capture: ReadableTelemetryCapture,
	afterEndSequence = 0,
): EvolutionTraceSnapshot {
	const snapshot = capture.readSettled(afterEndSequence);
	const tools = new Map<string, { callCount: number; failureCount: number }>();
	const routes: EvolutionRouteSignal[] = [];
	let runCount = 0;
	let failedRunCount = 0;
	let abortedRunCount = 0;
	let assistantAttemptCount = 0;
	let retryCount = 0;
	let failedStepCount = 0;
	let aiRequestCount = 0;
	let failedAiRequestCount = 0;

	for (const span of snapshot.spans) {
		switch (span.name) {
			case "diffex.harness.run":
				runCount += 1;
				if (span.attributes["diffex.operation.outcome"] === "failed" || span.status.status === "error") {
					failedRunCount += 1;
				}
				if (span.attributes["diffex.operation.outcome"] === "aborted") abortedRunCount += 1;
				break;
			case "diffex.harness.step":
				if (span.attributes["diffex.step.kind"] === "assistant") assistantAttemptCount += 1;
				if (span.attributes["diffex.step.outcome"] === "retry") retryCount += 1;
				if (
					span.attributes["diffex.step.outcome"] === "failed" ||
					(span.status.status === "error" && span.attributes["diffex.step.outcome"] !== "retry")
				) {
					failedStepCount += 1;
				}
				break;
			case "diffex.ai.request":
				aiRequestCount += 1;
				if (span.status.status === "error" || span.attributes["diffex.ai.response.stop_reason"] === "error") {
					failedAiRequestCount += 1;
				}
				break;
			case "diffex.harness.tool": {
				const name = span.attributes["diffex.tool.name"];
				if (typeof name !== "string") break;
				const current = tools.get(name) ?? { callCount: 0, failureCount: 0 };
				current.callCount += 1;
				if (span.attributes["diffex.tool.is_error"] === true || span.status.status === "error") {
					current.failureCount += 1;
				}
				tools.set(name, current);
				break;
			}
			case "diffex.harness.profile_route": {
				const trigger = span.attributes["diffex.routing.trigger"];
				const outcome = span.attributes["diffex.routing.outcome"];
				if (
					outcome !== "bypassed" &&
					outcome !== "selected" &&
					outcome !== "reused" &&
					outcome !== "stayed" &&
					outcome !== "declined" &&
					outcome !== "failed"
				) {
					break;
				}
				const currentHarnessId = span.attributes["diffex.routing.current_harness_id"];
				const targetProfileId = span.attributes["diffex.routing.target_profile_id"];
				const harnessId = span.attributes["diffex.routing.harness_id"];
				const fallback = span.attributes["diffex.routing.fallback"];
				routes.push({
					...(trigger === "initial_turn" || trigger === "future_turn" ? { trigger } : {}),
					...(typeof currentHarnessId === "string" ? { currentHarnessId } : {}),
					outcome,
					...(typeof targetProfileId === "string" ? { targetProfileId } : {}),
					...(typeof harnessId === "string" ? { harnessId } : {}),
					...(fallback === "completion_error" || fallback === "invalid_output" || fallback === "low_confidence"
						? { fallback }
						: {}),
				});
				break;
			}
		}
	}

	return {
		cursor: snapshot.cursor,
		droppedSpanCount: snapshot.droppedSpanCount,
		incomplete: snapshot.droppedSpanCount > 0,
		runCount,
		failedRunCount,
		abortedRunCount,
		assistantAttemptCount,
		retryCount,
		failedStepCount,
		aiRequestCount,
		failedAiRequestCount,
		tools: [...tools.entries()]
			.map(([name, signal]) => ({ name, ...signal }))
			.sort((left, right) => left.name.localeCompare(right.name)),
		routes,
	};
}

/**
 * Bounded process-local telemetry capture for hosts that opt into trace-informed work.
 *
 * It is independent of install telemetry and analytics. Callers own its lifetime,
 * cursor, retention policy, and any downstream use of the content-free spans.
 */
export class BoundedTelemetryCapture implements ReadableTelemetryCapture {
	readonly context: InMemoryTelemetryContext;

	constructor(options: BoundedTelemetryCaptureOptions = {}) {
		this.context = new InMemoryTelemetryContext({ maxSpans: options.maxSpans ?? 2_048 });
	}

	readSettled(afterEndSequence = 0): TelemetryCaptureSnapshot {
		return this.context.getSettledSpansAfter(afterEndSequence);
	}
}
