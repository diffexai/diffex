import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type {
	SubagentActionResult,
	SubagentEscalationCallback,
	SubagentQueryOptions,
	SubagentQueryResult,
	SubagentResultView,
} from "../subagents/types.ts";
import { SUBAGENT_NAME_PATTERN } from "../subagents/types.ts";

const spawnAgentSchema = Type.Object({
	name: Type.String({
		description: "Unique lowercase name for the child agent",
		pattern: SUBAGENT_NAME_PATTERN.source,
	}),
	task: Type.String({ description: "The focused task for the child agent", minLength: 1 }),
});

const escalateToParentSchema = Type.Object(
	{
		message: Type.String({
			description:
				"Material blocker, risk, contradiction, decision, or allowance extension requiring parent attention",
			minLength: 1,
			maxLength: 1_000,
		}),
	},
	{ additionalProperties: false },
);

const targetSchema = Type.String({
	description: "Name of an existing child agent",
	pattern: SUBAGENT_NAME_PATTERN.source,
});

const agentActionSchema = Type.Object(
	{
		target: targetSchema,
		reason: Type.Optional(
			Type.String({
				description:
					"Justification for extending needed work based on current progress, remaining work, and the goal",
				minLength: 1,
			}),
		),
		action: Type.Unsafe<AgentActionRequest["action"]>({
			type: "string",
			enum: ["message", "interrupt", "renew"],
		}),
		message: Type.Optional(Type.String({ description: "Message for the child agent", minLength: 1 })),
		wake: Type.Optional(Type.Boolean({ default: false })),
		delivery: Type.Optional(
			Type.Union([Type.Literal("steer"), Type.Literal("follow_up")], {
				description:
					"steer corrects current work at the next tool boundary (default); follow_up waits until the current work finishes",
				default: "steer",
			}),
		),
	},
	{ additionalProperties: false },
);

const agentStatusSchema = Type.Object(
	{
		targets: Type.Optional(
			Type.Array(targetSchema, {
				description: "Child agent names to inspect; omit to inspect all children",
				minItems: 1,
				uniqueItems: true,
			}),
		),
	},
	{ additionalProperties: false },
);

export type AgentActionRequest =
	| {
			readonly target: string;
			readonly action: "message";
			readonly message: string;
			readonly wake?: boolean;
			readonly delivery?: "steer" | "follow_up";
	  }
	| { readonly target: string; readonly action: "interrupt" }
	| { readonly target: string; readonly action: "renew"; readonly reason: string };

export interface SpawnAgentDetails {
	readonly name: string;
	readonly status: "queued";
}

export interface AgentStatusRequest {
	readonly targets?: string[];
}

export interface AgentStatusDetails {
	readonly agents: readonly SubagentResultView[];
}

export interface EscalateToParentDetails {
	readonly accepted: true;
}

export function createEscalateToParentTool(
	escalate: SubagentEscalationCallback,
): ToolDefinition<typeof escalateToParentSchema, EscalateToParentDetails> {
	return {
		name: "escalate_to_parent",
		label: "Escalate to Parent",
		description:
			"Report a material blocker, risk, contradiction, decision, or needed allowance extension to the parent.",
		promptSnippet: "Report blockers, risks, decisions, or needed extensions to the parent agent",
		promptGuidelines: [
			"Provide concise decision checkpoints with current progress, remaining work, the goal, and the decision or extension needed. When more time is needed, request an extension. Use escalate_to_parent only for material information that could change the parent's plan. Do not send routine progress or tool logs, and still provide a complete final response.",
		],
		parameters: escalateToParentSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, request) => {
			if (typeof request.message !== "string" || request.message.trim().length === 0) {
				throw new Error("Escalation message must be non-empty");
			}
			if (request.message.length > 1_000) {
				throw new RangeError("Escalation message must be at most 1,000 characters");
			}
			await escalate(request.message);
			return {
				content: [{ type: "text", text: "Escalation accepted." }],
				details: { accepted: true },
			};
		},
	};
}

function assertAgentStatusRequest(request: unknown): asserts request is AgentStatusRequest {
	if (typeof request !== "object" || request === null || Array.isArray(request)) {
		throw new Error("Agent status request must be an object");
	}
	for (const key of Object.keys(request)) {
		if (key !== "targets") {
			throw new Error(`Unknown agent status request field: ${key}`);
		}
	}

	const { targets } = request as AgentStatusRequest;
	if (targets !== undefined) {
		if (!Array.isArray(targets) || targets.length === 0) {
			throw new Error("targets must be a non-empty array");
		}
		const uniqueTargets = new Set<string>();
		for (const target of targets) {
			if (typeof target !== "string" || !SUBAGENT_NAME_PATTERN.test(target)) {
				throw new Error(`Invalid subagent name: ${String(target)}`);
			}
			if (uniqueTargets.has(target)) {
				throw new Error(`Duplicate subagent target: ${target}`);
			}
			uniqueTargets.add(target);
		}
	}
}

export function createSpawnAgentTool(
	spawn: (name: string, task: string, toolCallId: string) => void,
	assertCanSpawn: () => void = () => {},
): ToolDefinition<typeof spawnAgentSchema, SpawnAgentDetails> {
	return {
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Start an independent child agent to work on a focused task asynchronously. Returns the child’s name and queued status without waiting for completion.",
		promptSnippet: "Delegate a focused task to an independent child agent",
		promptGuidelines: [
			"Use for focused subtasks that can run independently alongside other work. Request file references and supporting evidence for research or audits, and assign non-overlapping file ownership for edit and write operations.",
			"Continue independent work while child agents run. When only needed child work remains, end your current response; the runtime keeps the task open, waits automatically, and resumes you with child reports or results. Cancel obsolete work with agent_action interrupt before declaring completion.",
		],
		parameters: spawnAgentSchema,
		executionMode: "parallel",
		execute: async (toolCallId, { name, task }) => {
			assertCanSpawn();
			if (!SUBAGENT_NAME_PATTERN.test(name)) {
				throw new Error(`Invalid subagent name: ${name}`);
			}
			if (task.trim().length === 0) {
				throw new Error("Subagent task must be non-empty");
			}
			spawn(name, task, toolCallId);
			return {
				content: [{ type: "text", text: `Accepted subagent: ${name}` }],
				details: { name, status: "queued" },
			};
		},
	};
}

export function createAgentActionTool(
	action: (request: AgentActionRequest) => Promise<SubagentActionResult>,
): ToolDefinition<typeof agentActionSchema, SubagentActionResult> {
	return {
		name: "agent_action",
		label: "Agent Action",
		description:
			"Steer an existing child agent, queue follow-up work, wake it, approve an allowance extension, or interrupt its current work.",
		promptSnippet: "Steer, follow up, wake, renew, or interrupt an existing child agent",
		promptGuidelines: [
			"Messages steer current work at the next tool boundary by default. Set delivery: 'follow_up' only for new work that should wait until the child finishes. Set wake: true to resume an idle child; steering an idle child otherwise fails instead of silently queueing stale instructions.",
			"Child runs have a renewable time limit. Approve a needed extension with action: 'renew' and a reason based on the child's current progress, remaining work, and goal. Each approval adds one configured allowance (15 minutes by default) to the existing deadline, capped by the parent deadline. Cancel obsolete work immediately. Let child agents complete delegated work that is still needed. Interrupt only when the work is no longer needed, is proceeding in the wrong direction, or must stop because of a user request or material risk.",
			"Use agent_status for an immediate inspection when needed. When only needed child work remains, end your current response and let the runtime wait automatically. Waiting does not renew a child allowance; approve needed extensions with agent_action renew.",
		],
		parameters: agentActionSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, request) => {
			if (!SUBAGENT_NAME_PATTERN.test(request.target)) {
				throw new Error(`Invalid subagent name: ${request.target}`);
			}
			let normalized: AgentActionRequest;
			if (request.action === "renew") {
				if (!request.reason?.trim()) throw new Error("Lease renewal requires a justification");
				if ("message" in request || "wake" in request || "delivery" in request)
					throw new Error("Renew actions do not accept message fields");
				normalized = {
					target: request.target,
					action: "renew",
					reason: request.reason,
				};
			} else if ("reason" in request) {
				throw new Error("Only renew actions accept a reason");
			} else if (request.action === "interrupt") {
				if ("message" in request || "wake" in request || "delivery" in request) {
					throw new Error("Interrupt actions do not accept message fields");
				}
				normalized = { target: request.target, action: request.action };
			} else {
				if (request.action !== "message") throw new Error(`Invalid subagent action: ${String(request.action)}`);
				if (request.delivery !== undefined && request.delivery !== "steer" && request.delivery !== "follow_up") {
					throw new Error("Invalid subagent message delivery");
				}
				const message = request.message;
				if (message === undefined || message.trim().length === 0) {
					throw new Error("Subagent message must be non-empty");
				}
				normalized = {
					target: request.target,
					action: request.action,
					message,
					wake: request.wake ?? false,
					delivery: request.delivery ?? "steer",
				};
			}

			const details = await action(normalized);
			return {
				content: [{ type: "text", text: `Completed ${details.action} action for ${details.target}` }],
				details,
			};
		},
	};
}

export function createAgentStatusTool(
	query: (options: Pick<SubagentQueryOptions, "targets" | "signal">) => Promise<SubagentQueryResult>,
): ToolDefinition<typeof agentStatusSchema, AgentStatusDetails> {
	return {
		name: "agent_status",
		label: "Agent Status",
		description:
			"Immediately inspect child agent statuses and any recorded output or errors. Does not wait for completion.",
		promptSnippet: "Inspect child agent status and results",
		promptGuidelines: [
			"Use agent_status for an immediate snapshot of selected children, or omit targets to inspect all children. Terminal results returned here are consumed and will not be delivered again automatically.",
			"Do not repeatedly poll for completion. Continue independent work, or end your current response when only needed child work remains; the runtime waits automatically and resumes you with child reports or results.",
		],
		parameters: agentStatusSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, request, signal) => {
			assertAgentStatusRequest(request);
			const result = await query({
				...(request.targets === undefined ? {} : { targets: request.targets }),
				...(signal === undefined ? {} : { signal }),
			});
			const details: AgentStatusDetails = Object.freeze({
				agents: Object.freeze(
					result.agents.map((agent) =>
						Object.freeze({
							name: agent.name,
							status: agent.status,
							...(agent.result === undefined ? {} : { result: agent.result }),
							...(agent.error === undefined ? {} : { error: agent.error }),
						}),
					),
				),
			});
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	};
}
