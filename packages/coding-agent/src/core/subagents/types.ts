import type { AgentSession } from "../agent-session.ts";

export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type SubagentStatus = "queued" | "running" | "idle" | "failed" | "interrupted";

export interface SubagentSummary {
	readonly name: string;
	readonly status: SubagentStatus;
	readonly task: string;
}

export type CreateSubagentSession = (signal: AbortSignal) => Promise<AgentSession>;

export type SubagentSpawnOrigin =
	| {
			readonly type: "agent_tool_call";
			readonly toolCallId: string;
			readonly assistantEntryId: string;
			readonly contextEntryId: string | null;
	  }
	| {
			readonly type: "direct_tool_call";
			readonly toolCallId: string;
			readonly contextEntryId: null;
	  }
	| {
			readonly type: "programmatic";
			readonly contextEntryId: null;
	  };

export type CaptureSubagentSession = (
	parent: AgentSession,
	childName: string,
	origin: SubagentSpawnOrigin,
) => CreateSubagentSession;

export type SubagentMessageDelivery = "steer" | "follow_up" | "prompt";

export type SubagentActionResult =
	| {
			readonly target: string;
			readonly action: "message";
			readonly status: SubagentStatus;
			readonly delivery: SubagentMessageDelivery;
	  }
	| {
			readonly target: string;
			readonly action: "interrupt";
			readonly status: SubagentStatus;
	  };

export interface SubagentSnapshot {
	readonly name: string;
	readonly status: SubagentStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
}

export interface SubagentControllerSnapshot {
	readonly revision: number;
	readonly agents: readonly SubagentSnapshot[];
}

export type SubagentQueryUntil = "any" | "all";

export interface SubagentQueryOptions {
	readonly timeoutMs: number;
	readonly targets?: readonly string[];
	readonly until?: SubagentQueryUntil;
	readonly signal?: AbortSignal;
}

export interface SubagentResultView {
	readonly name: string;
	readonly status: SubagentStatus;
	readonly result?: string;
	readonly error?: string;
}

export interface SubagentQueryResultView extends SubagentResultView {
	readonly runId?: number;
}

export interface SubagentQueryResult {
	readonly timedOut: boolean;
	readonly agents: readonly SubagentQueryResultView[];
}

export type SubagentTerminalStatus = Extract<SubagentStatus, "idle" | "failed" | "interrupted">;

export interface SubagentDeliveryBatch {
	readonly id: number;
	readonly attempts: readonly {
		readonly name: string;
		readonly runId: number;
	}[];
}

export interface SubagentBatchResult {
	readonly name: string;
	readonly status: SubagentTerminalStatus;
	readonly attempt: "initial" | "retry";
	readonly retryAvailable: boolean;
	readonly result?: string;
	readonly error?: string;
}

export interface SubagentBatchWaitOptions {
	readonly signal?: AbortSignal;
	readonly onTerminal?: (result: SubagentBatchResult) => void;
}

export type SubagentLifecycleEvent =
	| {
			readonly type: "subagent_reserved";
			readonly revision: number;
			readonly name: string;
			readonly status: "queued";
			readonly timestamp: number;
	  }
	| {
			readonly type: "subagent_status_changed";
			readonly revision: number;
			readonly name: string;
			readonly previousStatus: SubagentStatus;
			readonly status: SubagentStatus;
			readonly timestamp: number;
	  }
	| {
			readonly type: "subagent_controller_reset";
			readonly revision: number;
			readonly timestamp: number;
	  }
	| {
			readonly type: "subagent_controller_disposed";
			readonly revision: number;
			readonly timestamp: number;
	  };

export type SubagentLifecycleListener = (event: SubagentLifecycleEvent) => void;

export type SubagentWaitResult =
	| { readonly reason: "changed"; readonly snapshot: SubagentControllerSnapshot }
	| { readonly reason: "timeout" }
	| { readonly reason: "reset" }
	| { readonly reason: "disposed" };

export interface SubagentWaitOptions {
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface SubagentPermit {
	release(): void;
}
