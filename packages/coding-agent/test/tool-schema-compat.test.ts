import { describe, expect, test } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { createAgentActionTool, createAgentStatusTool, createSpawnAgentTool } from "../src/core/tools/subagents.ts";

const PROHIBITED_ROOT_KEYWORDS = ["oneOf", "anyOf", "allOf", "enum", "const", "not"] as const;

describe("built-in tool schema compatibility", () => {
	test("publishes object-rooted schemas without top-level composition keywords", () => {
		const definitions = [
			...Object.values(createAllToolDefinitions("/workspace")),
			createSpawnAgentTool(() => {}),
			createAgentActionTool(async () => {
				throw new Error("Not executed by schema test");
			}),
			createAgentStatusTool(async () => ({ timedOut: false, agents: [] })),
		];

		for (const definition of definitions) {
			const parameters = definition.parameters as Record<string, unknown>;
			expect({ name: definition.name, type: parameters.type }).toEqual({
				name: definition.name,
				type: "object",
			});
			for (const keyword of PROHIBITED_ROOT_KEYWORDS) {
				expect(parameters, `${definition.name} must not use ${keyword} at the schema root`).not.toHaveProperty(
					keyword,
				);
			}
		}
	});
});
