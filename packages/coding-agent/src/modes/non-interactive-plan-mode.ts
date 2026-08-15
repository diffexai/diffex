import type { CollaborationMode } from "../core/plan-mode.ts";
import { buildSessionContext, type SessionManager } from "../core/session-manager.ts";

export const NON_INTERACTIVE_PLAN_MODE_ERROR = "Plan mode is not supported in print, JSON, or RPC mode.";

interface NonInteractivePlanState {
	collaborationMode: CollaborationMode;
	pendingPlan?: unknown;
	pendingPlanContinuation?: unknown;
}

export function isNonInteractivePlanStateUnsupported(state: NonInteractivePlanState): boolean {
	return (
		state.collaborationMode === "plan" ||
		state.pendingPlan !== undefined ||
		state.pendingPlanContinuation !== undefined
	);
}

export function assertNonInteractivePlanModeDisabled(state: NonInteractivePlanState): void {
	if (isNonInteractivePlanStateUnsupported(state)) {
		throw new Error(NON_INTERACTIVE_PLAN_MODE_ERROR);
	}
}

export function validateNonInteractiveSessionTarget(sessionManager: SessionManager, leafId: string | null): void {
	const context = buildSessionContext(sessionManager.getEntries(), leafId);
	assertNonInteractivePlanModeDisabled(context);
}
