import type { AgentSessionEvent } from "../core/agent-session.ts";
import type { ProfileSwitchEvent } from "../core/agent-session-runtime.ts";

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
export interface JsonProfileSwitchEvent {
	type: "profile_switch";
	fromProfileId: string;
	toProfileId: string;
	harnessId: string;
	harnessRevision: string;
	harnessName: string;
	reused: boolean;
	notice: string;
}

export type JsonAgentSessionEvent = ToJsonEvent<AgentSessionEvent> | JsonProfileSwitchEvent;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
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

/** Convert a runtime harness switch into its reason-free public wire event. */
export function toJsonProfileSwitchEvent(event: ProfileSwitchEvent): JsonProfileSwitchEvent {
	return {
		type: "profile_switch",
		fromProfileId: event.fromProfileId,
		toProfileId: event.toProfileId,
		harnessId: event.harnessId,
		harnessRevision: event.harnessRevision,
		harnessName: event.harnessName,
		reused: event.reused,
		notice: event.notice,
	};
}
