import type { AgentToolResult } from "@earendil-works/diffex-agent-core";
import type { TUI } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	createUpdatePlanTool,
	createUpdatePlanToolDefinition,
	type UpdatePlanToolDetails,
	type UpdatePlanToolInput,
} from "../src/core/tools/update-plan.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function getTextOutput(result: AgentToolResult<UpdatePlanToolDetails>): string {
	return result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

async function executeUpdatePlan(input: UpdatePlanToolInput): Promise<AgentToolResult<UpdatePlanToolDetails>> {
	const tool = createUpdatePlanTool();
	return tool.execute("tool-1", input);
}

describe("update_plan tool", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("accepts a full ordered plan snapshot and returns exact counts", async () => {
		const input: UpdatePlanToolInput = {
			plan: [
				{ step: "Read the code", status: "completed" },
				{ step: "Implement the tool", status: "in_progress" },
				{ step: "Run checks", status: "pending" },
			],
		};

		const result = await executeUpdatePlan(input);

		expect(getTextOutput(result)).toBe("Plan updated: 1 completed, 1 in progress, 1 pending.");
		expect(result.details).toEqual({ plan: input.plan });
		expect(result.details.plan).not.toBe(input.plan);
		expect(result.details.plan[0]).not.toBe(input.plan[0]);

		input.plan[0]!.step = "mutated";
		expect(result.details.plan[0]?.step).toBe("Read the code");
	});

	test("accepts all-completed plans without an in-progress item", async () => {
		const result = await executeUpdatePlan({
			plan: [
				{ step: "Read the code", status: "completed" },
				{ step: "Run checks", status: "completed" },
			],
		});

		expect(getTextOutput(result)).toBe("Plan updated: 2 completed, 0 in progress, 0 pending.");
	});

	test("treats each call as a replacement snapshot", async () => {
		const first = await executeUpdatePlan({
			plan: [
				{ step: "One", status: "in_progress" },
				{ step: "Two", status: "pending" },
			],
		});
		const second = await executeUpdatePlan({
			plan: [{ step: "Different", status: "completed" }],
		});

		expect(first.details.plan).toEqual([
			{ step: "One", status: "in_progress" },
			{ step: "Two", status: "pending" },
		]);
		expect(second.details.plan).toEqual([{ step: "Different", status: "completed" }]);
		expect(getTextOutput(second)).toBe("Plan updated: 1 completed, 0 in progress, 0 pending.");
	});

	test("rejects invalid plan snapshots", async () => {
		await expect(executeUpdatePlan({ plan: [] })).rejects.toThrow("Plan must contain at least one item.");
		await expect(executeUpdatePlan({ plan: [{ step: "   ", status: "in_progress" }] })).rejects.toThrow(
			"Plan item 1 step must be a non-empty string.",
		);
		await expect(
			executeUpdatePlan({
				plan: [
					{ step: "One", status: "pending" },
					{ step: "Two", status: "pending" },
				],
			}),
		).rejects.toThrow("Unfinished plans must contain exactly one in_progress item.");
		await expect(
			executeUpdatePlan({
				plan: [
					{ step: "One", status: "in_progress" },
					{ step: "Two", status: "in_progress" },
				],
			}),
		).rejects.toThrow("Unfinished plans must contain exactly one in_progress item.");
		await expect(
			executeUpdatePlan({
				plan: [{ step: "One", status: "blocked" }],
			} as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Plan item 1 status must be pending, in_progress, or completed.");
	});

	test("uses a provider-compatible string enum schema and requires a non-empty plan array", () => {
		const definition = createUpdatePlanToolDefinition();
		const parameters = definition.parameters as {
			properties: {
				plan: {
					minItems?: number;
					items?: {
						properties?: {
							status?: { enum?: string[] };
						};
					};
				};
			};
		};

		expect(parameters.properties.plan.minItems).toBe(1);
		expect(parameters.properties.plan.items?.properties?.status?.enum).toEqual([
			"pending",
			"in_progress",
			"completed",
		]);
	});

	test("renders the checklist once and suppresses the successful result body", () => {
		const plan: UpdatePlanToolInput = {
			plan: [
				{ step: "Read the code", status: "completed" },
				{ step: "Implement the tool", status: "in_progress" },
				{ step: "Run checks", status: "pending" },
			],
		};
		const definition = createUpdatePlanToolDefinition() as ToolDefinition;
		const component = new ToolExecutionComponent(
			"update_plan",
			"tool-1",
			plan,
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Plan updated: 1 completed, 1 in progress, 1 pending." }],
				details: { plan: plan.plan },
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("update_plan");
		expect(rendered).toContain("[x] Read the code");
		expect(rendered).toContain("[>] Implement the tool");
		expect(rendered).toContain("[ ] Run checks");
		expect(rendered).not.toContain("Plan updated: 1 completed, 1 in progress, 1 pending.");
	});

	test("renders update_plan errors normally", () => {
		const definition = createUpdatePlanToolDefinition() as ToolDefinition;
		const component = new ToolExecutionComponent(
			"update_plan",
			"tool-1",
			{ plan: [{ step: "Read", status: "pending" }] },
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Unfinished plans must contain exactly one in_progress item." }],
				details: undefined,
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("update_plan");
		expect(rendered).toContain("Unfinished plans must contain exactly one in_progress item.");
	});
});
