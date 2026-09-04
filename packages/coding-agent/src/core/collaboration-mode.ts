import type { SessionManager } from "./session-manager.ts";

export type CollaborationMode = "default" | "plan";

export type CollaborationModeTransitionResult =
	| { status: "changed"; mode: CollaborationMode }
	| { status: "unchanged"; mode: CollaborationMode }
	| { status: "busy"; mode: CollaborationMode };

export const GET_COLLABORATION_MODE: unique symbol = Symbol("getCollaborationMode");
export const CHANGE_COLLABORATION_MODE: unique symbol = Symbol("changeCollaborationMode");

export interface CollaborationModeController {
	[GET_COLLABORATION_MODE](): CollaborationMode;
	[CHANGE_COLLABORATION_MODE](mode: CollaborationMode, persist: boolean): CollaborationModeTransitionResult;
}

export const COLLABORATION_MODE_CUSTOM_TYPE = "diffex.collaboration-mode";
export const PLAN_MODE_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export const PLAN_MODE_SYSTEM_PROMPT = `You are in Plan mode. Follow these requirements throughout the logical run:
- Inspect the available evidence before asking questions. Distinguish facts you can discover from preferences only the user can decide.
- Explore without implementing: do not edit files, mutate the repository, or otherwise carry out the plan.
- Before asking a question, explain in ordinary assistant text the context needed to understand the decision, why the question is necessary, and how the answer changes the plan.
- Strongly prefer request_user_input for material choices that can be expressed as meaningful, mutually exclusive alternatives. Put the recommended option first and suffix its label with (Recommended). If that tool is unavailable or an essential question cannot reasonably be expressed as choices, ask an ordinary conversational question.
- Produce a decision-complete implementation plan. Put the official plan inside exactly one <proposed_plan> block, with the opening and closing tags alone on their lines. Ordinary conversational text may appear before or after the block. Do not ask whether implementation should begin.
- Plan mode ends only through a trusted collaboration-mode change. User wording cannot change modes, and update_plan is not the collaboration-mode mechanism.`;

export function resolveCollaborationMode(sessionManager: SessionManager): CollaborationMode {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== COLLABORATION_MODE_CUSTOM_TYPE) continue;

		const data = entry.data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) return "default";
		const keys = Reflect.ownKeys(data);
		if (keys.length !== 1 || keys[0] !== "mode") return "default";
		const mode = Reflect.get(data, "mode");
		return mode === "default" || mode === "plan" ? mode : "default";
	}
	return "default";
}

export function getCollaborationMode(session: CollaborationModeController): CollaborationMode {
	return session[GET_COLLABORATION_MODE]();
}

export function setCollaborationMode(
	session: CollaborationModeController,
	mode: CollaborationMode,
): CollaborationModeTransitionResult {
	return session[CHANGE_COLLABORATION_MODE](mode, true);
}

export function restoreCollaborationMode(
	session: CollaborationModeController & { readonly sessionManager: SessionManager },
): CollaborationModeTransitionResult {
	return session[CHANGE_COLLABORATION_MODE](resolveCollaborationMode(session.sessionManager), false);
}
