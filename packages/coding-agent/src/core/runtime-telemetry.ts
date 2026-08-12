import {
	completeAiRequestSpan,
	failAiRequestSpan,
	startAiSpan,
	startHarnessSpan,
	type TelemetryContext,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export interface ProfileRouteSpanStart {
	sessionId: string;
	routingMode: "auto" | "pinned";
	trigger: "initial_turn" | "future_turn";
	currentProfileId: string;
	currentHarnessId?: string;
	sessionEstablished: boolean;
}

export interface ProfileRouteSpanResult {
	outcome: "bypassed" | "selected" | "reused" | "stayed" | "declined" | "failed";
	targetProfileId?: string;
	harnessId?: string;
	confidence?: number;
	fallback?: "completion_error" | "invalid_output" | "low_confidence";
}

export interface ProfileRouteSpanScope {
	/** Child context for the router model request and related work. */
	context: TelemetryContext;
	complete(result: ProfileRouteSpanResult): void;
}

/** Instrument one routing pass without retaining prompt text or router explanations. */
export function startProfileRouteSpan<Result>(
	telemetryContext: TelemetryContext,
	start: ProfileRouteSpanStart,
	callback: (scope: ProfileRouteSpanScope) => Result | Promise<Result>,
): Promise<Result> {
	return startHarnessSpan(
		telemetryContext,
		"pi.harness.profile_route",
		{
			"pi.session.id": start.sessionId,
			"pi.routing.mode": start.routingMode,
			"pi.routing.trigger": start.trigger,
			"pi.routing.current_profile_id": start.currentProfileId,
			...(start.currentHarnessId ? { "pi.routing.current_harness_id": start.currentHarnessId } : {}),
			"pi.routing.session_established": start.sessionEstablished,
		},
		async (span) => {
			const complete = (result: ProfileRouteSpanResult): void => {
				span.setAttributes({
					"pi.routing.outcome": result.outcome,
					...(result.targetProfileId ? { "pi.routing.target_profile_id": result.targetProfileId } : {}),
					...(result.harnessId ? { "pi.routing.harness_id": result.harnessId } : {}),
					...(result.confidence === undefined ? {} : { "pi.routing.confidence": result.confidence }),
					...(result.fallback ? { "pi.routing.fallback": result.fallback } : {}),
				});
				if (result.outcome === "failed") span.setStatus({ status: "error" });
			};
			try {
				return await callback({ context: span, complete });
			} catch (error) {
				complete({ outcome: "failed" });
				throw error;
			}
		},
	);
}

export interface EvolutionSpanStart {
	sessionId: string;
	trigger: "explicit" | "run_settled" | "session_shutdown";
	profileId?: string;
}

export interface EvolutionSpanResult {
	outcome: "completed" | "skipped" | "failed";
	candidateCount?: number;
	acceptedCount?: number;
	rejectedCount?: number;
	scope?: "global" | "project";
}

export interface EvolutionSpanScope {
	context: TelemetryContext;
	complete(result: EvolutionSpanResult): void;
}

/** Instrument an evolution pass without retaining note content or file paths. */
export function startEvolutionSpan<Result>(
	telemetryContext: TelemetryContext,
	start: EvolutionSpanStart,
	callback: (scope: EvolutionSpanScope) => Result | Promise<Result>,
): Promise<Result> {
	return startHarnessSpan(
		telemetryContext,
		"pi.harness.evolution",
		{
			"pi.session.id": start.sessionId,
			"pi.evolution.trigger": start.trigger,
			...(start.profileId ? { "pi.evolution.profile_id": start.profileId } : {}),
		},
		async (span) => {
			const complete = (result: EvolutionSpanResult): void => {
				span.setAttributes({
					"pi.evolution.outcome": result.outcome,
					...(result.candidateCount === undefined
						? {}
						: { "pi.evolution.candidate_count": result.candidateCount }),
					...(result.acceptedCount === undefined ? {} : { "pi.evolution.accepted_count": result.acceptedCount }),
					...(result.rejectedCount === undefined ? {} : { "pi.evolution.rejected_count": result.rejectedCount }),
					...(result.scope ? { "pi.evolution.scope": result.scope } : {}),
				});
				if (result.outcome === "failed") span.setStatus({ status: "error" });
			};
			try {
				return await callback({ context: span, complete });
			} catch (error) {
				complete({ outcome: "failed" });
				throw error;
			}
		},
	);
}

/** Trace a non-stream-returning AI completion under an existing runtime scope. */
export function traceAiCompletion(
	telemetryContext: TelemetryContext,
	model: Model<Api>,
	complete: (telemetryContext: TelemetryContext) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
	return startAiSpan(
		telemetryContext,
		"pi.ai.request",
		{
			"pi.ai.operation": "stream",
			"pi.ai.provider": model.provider,
			"pi.ai.model": model.id,
			"pi.ai.api": model.api,
			"pi.ai.streaming": false,
		},
		async (span) => {
			try {
				const message = await complete(span);
				completeAiRequestSpan(span, message);
				return message;
			} catch (error) {
				failAiRequestSpan(span, classifyTelemetryError(error));
				throw error;
			}
		},
	);
}

function classifyTelemetryError(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") return "AbortError";
	if (error instanceof TypeError) return "TypeError";
	if (error instanceof Error) return "Error";
	return "NonError";
}
