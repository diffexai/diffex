import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { SUBAGENT_NAME_PATTERN } from "../subagents/types.ts";

const spawnAgentSchema = Type.Object({
	name: Type.String({
		description: "Unique lowercase name for the child agent",
		pattern: SUBAGENT_NAME_PATTERN.source,
	}),
	task: Type.String({ description: "Focused task for the child agent", minLength: 1 }),
});

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
