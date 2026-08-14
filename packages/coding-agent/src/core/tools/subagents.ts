import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type {
	SubagentActionResult,
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
	task: Type.String({ description: "Focused task for the child agent", minLength: 1 }),
});

const targetSchema = Type.String({
	description: "Name of an existing child agent",
	pattern: SUBAGENT_NAME_PATTERN.source,
});

const agentActionSchema = Type.Union(
	[
		Type.Object(
			{
				target: targetSchema,
				action: Type.Literal("message"),
				message: Type.String({ description: "Message for the child agent", minLength: 1 }),
				wake: Type.Optional(Type.Boolean({ default: false })),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				target: targetSchema,
				action: Type.Literal("interrupt"),
			},
			{ additionalProperties: false },
		),
	],
	{ type: "object" },
);

const agentsSchema = Type.Object(
	{
		timeout_ms: Type.Integer({
			description: "Maximum time to wait in milliseconds, or zero to return immediately",
			minimum: 0,
		}),
		targets: Type.Optional(
			Type.Array(targetSchema, {
				description: "Child agent names to inspect, frozen when the call starts",
				minItems: 1,
				uniqueItems: true,
			}),
		),
		until: Type.Optional(
			Type.Union([Type.Literal("any"), Type.Literal("all")], {
				description: "Wait until any or all selected agents reach a terminal status",
			}),
		),
	},
	{ additionalProperties: false },
);

export type AgentActionRequest =
	| { readonly target: string; readonly action: "message"; readonly message: string; readonly wake?: boolean }
	| { readonly target: string; readonly action: "interrupt" };

export interface SpawnAgentDetails {
	readonly name: string;
	readonly status: "queued";
}

export interface AgentsRequest {
	readonly timeout_ms: number;
	readonly targets?: string[];
	readonly until?: "any" | "all";
}

export interface AgentsDetails {
	readonly timed_out: boolean;
	readonly agents: readonly SubagentResultView[];
}

function assertAgentsRequest(request: unknown): asserts request is AgentsRequest {
	if (typeof request !== "object" || request === null || Array.isArray(request)) {
		throw new Error("Agents request must be an object");
	}
	for (const key of Object.keys(request)) {
		if (key !== "timeout_ms" && key !== "targets" && key !== "until") {
			throw new Error(`Unknown agents request field: ${key}`);
		}
	}

	const { timeout_ms, targets, until } = request as Partial<AgentsRequest>;
	if (!Number.isInteger(timeout_ms) || timeout_ms === undefined || timeout_ms < 0) {
		throw new RangeError("timeout_ms must be a non-negative integer");
	}
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
	if (until !== undefined && until !== "any" && until !== "all") {
		throw new Error(`Invalid agents wait condition: ${String(until)}`);
	}
}

export function createSpawnAgentTool(
	spawn: (name: string, task: string, toolCallId: string) => void,
): ToolDefinition<typeof spawnAgentSchema, SpawnAgentDetails> {
	return {
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Start an independent child agent asynchronously. The tool returns after acceptance, but the enclosing parent prompt remains active until coordinated child work is delivered.",
		promptGuidelines: [
			"After spawning child agents, you may finish the current response. The session waits for the frozen child batch and automatically sends one hidden, name-sorted result message before the parent prompt settles.",
		],
		parameters: spawnAgentSchema,
		executionMode: "parallel",
		execute: async (toolCallId, { name, task }) => {
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
		description: "Message, wake, or interrupt an existing child agent.",
		parameters: agentActionSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, request) => {
			if (!SUBAGENT_NAME_PATTERN.test(request.target)) {
				throw new Error(`Invalid subagent name: ${request.target}`);
			}
			if (request.action === "interrupt") {
				if ("message" in request || "wake" in request) {
					throw new Error("Interrupt actions do not accept message fields");
				}
			} else if (request.message.trim().length === 0) {
				throw new Error("Subagent message must be non-empty");
			}

			const normalized: AgentActionRequest =
				request.action === "message" ? { ...request, wake: request.wake ?? false } : request;
			const details = await action(normalized);
			return {
				content: [{ type: "text", text: `Completed ${details.action} action for ${details.target}` }],
				details,
			};
		},
	};
}

export function createAgentsTool(
	query: (options: SubagentQueryOptions) => Promise<SubagentQueryResult>,
): ToolDefinition<typeof agentsSchema, AgentsDetails> {
	return {
		name: "agents",
		label: "Agents",
		description: "List child agents immediately or wait for controller changes and terminal statuses.",
		parameters: agentsSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, request, signal) => {
			assertAgentsRequest(request);
			const result = await query({
				timeoutMs: request.timeout_ms,
				...(request.targets === undefined ? {} : { targets: request.targets }),
				...(request.until === undefined ? {} : { until: request.until }),
				...(signal === undefined ? {} : { signal }),
			});
			const details: AgentsDetails = Object.freeze({
				timed_out: result.timedOut,
				agents: result.agents,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	};
}
