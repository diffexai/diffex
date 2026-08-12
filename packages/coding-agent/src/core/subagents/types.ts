import type { AgentSession } from "../agent-session.ts";

export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type SubagentStatus = "queued" | "running" | "idle" | "failed" | "interrupted";

export type CreateSubagentSession = (signal: AbortSignal) => Promise<AgentSession>;

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

export interface SubagentRecord {
	name: string;
	task: string;
	status: SubagentStatus;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	finalText?: string;
	error?: string;
	session?: AgentSession;
	run?: Promise<void>;
	createSession?: CreateSubagentSession;
	runController?: AbortController;
	interruptionRequested?: boolean;
	actionTail?: Promise<void>;
}

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
			readonly type: "subagent_controller_disposed";
			readonly revision: number;
			readonly timestamp: number;
	  };

export type SubagentLifecycleListener = (event: SubagentLifecycleEvent) => void;

export type SubagentWaitResult =
	| { readonly reason: "changed"; readonly snapshot: SubagentControllerSnapshot }
	| { readonly reason: "timeout" }
	| { readonly reason: "disposed" };

export interface SubagentWaitOptions {
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface SubagentPermit {
	release(): void;
}
