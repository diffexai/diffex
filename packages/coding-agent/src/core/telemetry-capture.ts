import {
	InMemoryTelemetryContext,
	type SettledTelemetrySpanSnapshot,
	type TelemetryContext,
} from "@earendil-works/pi-agent-core";

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
	outcome: "bypassed" | "selected" | "reused" | "failed";
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
			case "pi.harness.run":
				runCount += 1;
				if (span.attributes["pi.operation.outcome"] === "failed" || span.status.status === "error") {
					failedRunCount += 1;
				}
				if (span.attributes["pi.operation.outcome"] === "aborted") abortedRunCount += 1;
				break;
			case "pi.harness.step":
				if (span.attributes["pi.step.kind"] === "assistant") assistantAttemptCount += 1;
				if (span.attributes["pi.step.outcome"] === "retry") retryCount += 1;
				if (
					span.attributes["pi.step.outcome"] === "failed" ||
					(span.status.status === "error" && span.attributes["pi.step.outcome"] !== "retry")
				) {
					failedStepCount += 1;
				}
				break;
			case "pi.ai.request":
				aiRequestCount += 1;
				if (span.status.status === "error" || span.attributes["pi.ai.response.stop_reason"] === "error") {
					failedAiRequestCount += 1;
				}
				break;
			case "pi.harness.tool": {
				const name = span.attributes["pi.tool.name"];
				if (typeof name !== "string") break;
				const current = tools.get(name) ?? { callCount: 0, failureCount: 0 };
				current.callCount += 1;
				if (span.attributes["pi.tool.is_error"] === true || span.status.status === "error") {
					current.failureCount += 1;
				}
				tools.set(name, current);
				break;
			}
			case "pi.harness.profile_route": {
				const outcome = span.attributes["pi.routing.outcome"];
				if (outcome !== "bypassed" && outcome !== "selected" && outcome !== "reused" && outcome !== "failed") {
					break;
				}
				const targetProfileId = span.attributes["pi.routing.target_profile_id"];
				const harnessId = span.attributes["pi.routing.harness_id"];
				const fallback = span.attributes["pi.routing.fallback"];
				routes.push({
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
