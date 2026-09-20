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
	task: Type.String({ description: "Task for the child agent", minLength: 1 }),
});

const escalateToParentSchema = Type.Object(
	{
		message: Type.String({
			description: "Checkpoint for the parent",
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
				description: "Required for renew: justify against current progress, remaining work, and the goal",
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
		description: "Report blockers, risks, contradictions, decisions, or extension needs to the parent.",
		promptSnippet: "Escalate issues or request an extension",
		promptGuidelines: [
			"Include current progress, remaining work, the goal, and the decision or extension needed. Only escalate information that could change the parent's plan; omit routine progress and tool logs. Still provide a complete final response.",
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
		description: "Start a child on an independent task; return its name and queued status immediately.",
		promptSnippet: "Delegate an independent task",
		promptGuidelines: [
			"Request file references and evidence for research or audits. Assign non-overlapping file ownership for edits.",
			"Continue independent work while children run. When only needed child work remains, end your response; the runtime keeps the task open and resumes you with child reports or results.",
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
		description: "Message, wake, renew, or interrupt an existing child agent.",
		promptSnippet: "Manage an existing child agent",
		promptGuidelines: [
			"Set wake: true to resume an idle child; steering an idle child without it fails.",
			"Use action: 'renew' with a reason to approve an extension. Each approval adds one configured allowance (15 minutes by default) to the existing deadline, capped by the parent deadline. Waiting does not renew it.",
			"Interrupt obsolete or misdirected work, or when a user request or material risk requires stopping. Otherwise let needed work finish.",
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
		description: "Immediately return child statuses and recorded output or errors.",
		promptSnippet: "Inspect child agent status and results",
		promptGuidelines: [
			"Terminal results returned here are consumed and will not be delivered again automatically.",
			"Do not repeatedly poll for completion.",
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
