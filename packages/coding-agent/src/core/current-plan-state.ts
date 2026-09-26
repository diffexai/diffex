import type { SessionManager } from "./session-manager.ts";
import {
	createUpdatePlanToolDefinition,
	resolveUpdatePlanOperation,
	type UpdatePlanToolDetails,
} from "./tools/update-plan.ts";

export const CURRENT_PLAN_CUSTOM_ENTRY_TYPE = "diffex.current-plan";

export type CurrentPlanState =
	| { status: "absent" }
	| { status: "corrupt" }
	| { status: "active"; operation: Extract<UpdatePlanToolDetails, { plan: unknown }> }
	| { status: "inactive"; operation: UpdatePlanToolDetails };

export function appendCurrentPlanRecord(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	operation: UpdatePlanToolDetails,
): string {
	return sessionManager.appendCustomEntry(CURRENT_PLAN_CUSTOM_ENTRY_TYPE, resolveUpdatePlanOperation(operation));
}

export function resolveCurrentPlanState(sessionManager: Pick<SessionManager, "getBranch">): CurrentPlanState {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== CURRENT_PLAN_CUSTOM_ENTRY_TYPE) {
			continue;
		}

		let operation: UpdatePlanToolDetails;
		try {
			operation = resolveUpdatePlanOperation(entry.data);
		} catch {
			return { status: "corrupt" };
		}

		if ("clear" in operation || operation.plan.every((item) => item.status === "completed")) {
			return { status: "inactive", operation };
		}
		return { status: "active", operation };
	}
	return { status: "absent" };
}

export function createSessionUpdatePlanToolDefinition(
	sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">,
): ReturnType<typeof createUpdatePlanToolDefinition> {
	const definition = createUpdatePlanToolDefinition(undefined, () => {
		const state = resolveCurrentPlanState(sessionManager);
		if (state.status === "active") return state.operation.plan;
		if (state.status === "inactive" && "plan" in state.operation) return state.operation.plan;
		return undefined;
	});
	const execute = definition.execute;
	return {
		...definition,
		async execute(...args: Parameters<typeof execute>) {
			const result = await execute(...args);
			appendCurrentPlanRecord(sessionManager, result.details);
			return result;
		},
	};
}
