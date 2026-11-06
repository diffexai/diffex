import type { HarnessVersion } from "@diffexai/diffex-harness-state";
import type { SessionManager } from "./session-manager.ts";

export type InvocationSessionAttachmentReason = "startup" | "resume" | "new" | "import" | "fork" | "switch";

export interface AgentSessionOperationSettlement {
	operationId: string;
	taskLineageId?: string;
	sessionManager: SessionManager;
	firstEntryOrdinal: number;
	/** The operation included recalled goal evidence and must not become evolution input. */
	excludeEvidence?: boolean;
}

/** Passive process-owned observation hooks for durable invocation tracing. */
export interface AgentSessionLifecycleObserver {
	operationSettled(settlement: AgentSessionOperationSettlement): void | Promise<void>;
	harnessActivated(version: HarnessVersion): void | Promise<void>;
	/** Suspend process-owned evolution without changing its global preference. */
	setGoalSuspended?(suspended: boolean): void | Promise<void>;
}
