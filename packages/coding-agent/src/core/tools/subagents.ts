import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SubagentActionResult } from "../subagents/types.ts";
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

const agentActionSchema = Type.Union([
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
]);

export type AgentActionRequest =
	| { readonly target: string; readonly action: "message"; readonly message: string; readonly wake?: boolean }
	| { readonly target: string; readonly action: "interrupt" };

export interface SpawnAgentDetails {
	readonly name: string;
	readonly status: "queued";
}

export function createSpawnAgentTool(
	spawn: (name: string, task: string) => void,
): ToolDefinition<typeof spawnAgentSchema, SpawnAgentDetails> {
	return {
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Start an independent child agent for a focused task and return immediately after acceptance.",
		parameters: spawnAgentSchema,
		executionMode: "parallel",
		execute: async (_toolCallId, { name, task }) => {
			if (!SUBAGENT_NAME_PATTERN.test(name)) {
				throw new Error(`Invalid subagent name: ${name}`);
			}
			if (task.trim().length === 0) {
				throw new Error("Subagent task must be non-empty");
			}
			spawn(name, task);
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
