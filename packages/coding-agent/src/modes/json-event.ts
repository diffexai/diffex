import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonEvent<T> = T extends {
	type: "message_update";
	assistantMessageEvent: infer TAssistantMessageEvent;
}
	? {
			type: "message_update";
			assistantMessageEvent: WithoutPartial<TAssistantMessageEvent>;
		}
	: T;

/** Session event shape emitted by the JSON and RPC stdout protocols. */
type PlanOnlyAgentSessionEvent = Extract<
	AgentSessionEvent,
	{ type: "collaboration_mode_changed" | "plan_submitted" | "plan_resolved" }
>;
type WireAgentSessionEvent = Exclude<AgentSessionEvent, PlanOnlyAgentSessionEvent>;

export type JsonAgentSessionEvent = ToJsonEvent<WireAgentSessionEvent>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent | undefined;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent | undefined {
	if (
		event.type === "collaboration_mode_changed" ||
		event.type === "plan_submitted" ||
		event.type === "plan_resolved"
	) {
		return undefined;
	}

	if (event.type !== "message_update") {
		return event;
	}

	const assistantMessageEvent = event.assistantMessageEvent;
	if (!("partial" in assistantMessageEvent)) {
		return { type: "message_update", assistantMessageEvent };
	}

	const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
	return { type: "message_update", assistantMessageEvent: deltaEvent };
}
