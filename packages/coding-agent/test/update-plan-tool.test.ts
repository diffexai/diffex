import type { AgentToolResult } from "@earendil-works/diffex-agent-core";
import { getModel, streamSimple } from "@earendil-works/diffex-ai/compat";
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

	test("accepts an exact plan update with an optional explanation and returns defensive details", async () => {
		const input = {
			explanation: "  Repository evidence changed.\n",
			plan: [
				{ step: "Read the code", status: "completed" },
				{ step: "  Implement the tool  ", status: "in_progress" },
				{ step: "Run checks", status: "pending" },
			],
		} satisfies UpdatePlanToolInput;

		const result = await executeUpdatePlan(input);

		expect(getTextOutput(result)).toBe("Plan updated: 1 completed, 1 in progress, 1 pending.");
		expect(result.details).toEqual(input);
		expect(result.details).not.toBe(input);
		expect("plan" in result.details).toBe(true);
		if (!("plan" in result.details)) return;
		expect(result.details.plan).not.toBe(input.plan);
		expect(result.details.plan[0]).not.toBe(input.plan[0]);

		input.plan[0]!.step = "mutated";
		input.explanation = "mutated";
		expect(result.details.plan[0]?.step).toBe("Read the code");
		expect(result.details.plan[1]?.step).toBe("  Implement the tool  ");
		expect(result.details.explanation).toBe("  Repository evidence changed.\n");
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
			explanation: "Initial approach",
			plan: [
				{ step: "One", status: "in_progress" },
				{ step: "Two", status: "pending" },
			],
		});
		const second = await executeUpdatePlan({
			plan: [{ step: "Different", status: "completed" }],
		});

		expect(first.details).toEqual({
			explanation: "Initial approach",
			plan: [
				{ step: "One", status: "in_progress" },
				{ step: "Two", status: "pending" },
			],
		});
		expect(second.details).toEqual({ plan: [{ step: "Different", status: "completed" }] });
		expect("explanation" in second.details).toBe(false);
		expect(getTextOutput(second)).toBe("Plan updated: 1 completed, 0 in progress, 0 pending.");
	});

	test("clears idempotently with or without an exact explanation", async () => {
		const first = await executeUpdatePlan({ clear: true, explanation: "  Work is no longer required.  " });
		const second = await executeUpdatePlan({ clear: true });

		expect(getTextOutput(first)).toBe("Plan cleared.");
		expect(first.details).toEqual({ clear: true, explanation: "  Work is no longer required.  " });
		expect(getTextOutput(second)).toBe("Plan cleared.");
		expect(second.details).toEqual({ clear: true });
	});

	test("rejects ambiguous operations and unknown fields", async () => {
		await expect(executeUpdatePlan({} as UpdatePlanToolInput)).rejects.toThrow(
			"Provide exactly one update_plan operation: plan or clear.",
		);
		await expect(
			executeUpdatePlan({
				plan: [{ step: "One", status: "completed" }],
				clear: true,
			} as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Provide exactly one update_plan operation: plan or clear.");
		await expect(executeUpdatePlan({ clear: false } as unknown as UpdatePlanToolInput)).rejects.toThrow(
			"Clear must be true.",
		);
		await expect(
			executeUpdatePlan({ clear: true, extra: "field" } as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Unexpected update_plan field: extra.");
		await expect(
			executeUpdatePlan({ clear: true, explanation: 42 } as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Explanation must be a string.");
	});

	test("rejects invalid plan items and snapshots", async () => {
		await expect(executeUpdatePlan({ plan: [] })).rejects.toThrow("Plan must contain at least one item.");
		await expect(executeUpdatePlan({ plan: ["step"] } as unknown as UpdatePlanToolInput)).rejects.toThrow(
			"Plan item 1 must be an object.",
		);
		await expect(executeUpdatePlan({ plan: [{ step: "   ", status: "in_progress" }] })).rejects.toThrow(
			"Plan item 1 step must be a non-empty string.",
		);
		await expect(
			executeUpdatePlan({
				plan: [{ step: "One", status: "in_progress", owner: "agent" }],
			} as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Plan item 1 contains unexpected field: owner.");
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

	test("publishes a DeepSeek-compatible object schema", () => {
		const definition = createUpdatePlanToolDefinition();
		const parameters = definition.parameters as {
			type?: string;
			anyOf?: Array<{
				additionalProperties?: boolean;
				properties?: {
					clear?: { const?: boolean };
					explanation?: { type?: string };
					plan?: {
						minItems?: number;
						items?: {
							additionalProperties?: boolean;
							properties?: {
								status?: { enum?: string[] };
							};
						};
					};
				};
				required?: string[];
			}>;
		};
		const update = parameters.anyOf?.[0];
		const clear = parameters.anyOf?.[1];

		expect(parameters.type).toBe("object");
		expect(parameters.anyOf).toHaveLength(2);
		expect(update?.required).toEqual(["plan"]);
		expect(update?.additionalProperties).toBe(false);
		expect(update?.properties?.plan?.minItems).toBe(1);
		expect(update?.properties?.plan?.items?.additionalProperties).toBe(false);
		expect(update?.properties?.plan?.items?.properties?.status?.enum).toEqual([
			"pending",
			"in_progress",
			"completed",
		]);
		expect(update?.properties?.explanation?.type).toBe("string");
		expect(clear?.required).toEqual(["clear"]);
		expect(clear?.additionalProperties).toBe(false);
		expect(clear?.properties?.clear?.const).toBe(true);
		expect(clear?.properties?.explanation?.type).toBe("string");
	});

	test("sends the object schema through a DeepSeek interaction", async () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		if (!model) throw new Error("Expected the DeepSeek model fixture");
		let payload: unknown;

		const result = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Plan this task", timestamp: Date.now() }],
				tools: [createUpdatePlanTool()],
			},
			{
				apiKey: "test-key",
				fetch: async () =>
					new Response(
						'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
				onPayload: (requestPayload) => {
					payload = requestPayload;
				},
			},
		).result();

		const sentPayload = payload as {
			tools?: Array<{ function?: { name?: string; parameters?: { type?: string } } }>;
		};
		const updatePlan = sentPayload.tools?.find((tool) => tool.function?.name === "update_plan");
		expect(updatePlan?.function?.parameters?.type).toBe("object");
		expect(result.stopReason).toBe("stop");
	});

	test("marks both tool representations as sequential", () => {
		expect(createUpdatePlanToolDefinition().executionMode).toBe("sequential");
		expect(createUpdatePlanTool().executionMode).toBe("sequential");
	});

	test("renders update explanations and checklists once while suppressing the successful result body", () => {
		const input = {
			explanation: "Repository evidence changed.",
			plan: [
				{ step: "Read the code", status: "completed" },
				{ step: "Implement the tool", status: "in_progress" },
				{ step: "Run checks", status: "pending" },
			],
		} satisfies UpdatePlanToolInput;
		const definition = createUpdatePlanToolDefinition() as ToolDefinition;
		const component = new ToolExecutionComponent(
			"update_plan",
			"tool-1",
			input,
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Plan updated: 1 completed, 1 in progress, 1 pending." }],
				details: input,
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("update_plan");
		expect(rendered).toContain("Explanation: Repository evidence changed.");
		expect(rendered).toContain("[x] Read the code");
		expect(rendered).toContain("[>] Implement the tool");
		expect(rendered).toContain("[ ] Run checks");
		expect(rendered).not.toContain("Plan updated: 1 completed, 1 in progress, 1 pending.");
	});

	test("renders clear explanations and labels while suppressing the successful result body", () => {
		const definition = createUpdatePlanToolDefinition() as ToolDefinition;
		const component = new ToolExecutionComponent(
			"update_plan",
			"tool-1",
			{ clear: true, explanation: "The user cancelled the work." },
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Plan cleared." }],
				details: { clear: true, explanation: "The user cancelled the work." },
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("Explanation: The user cancelled the work.");
		expect(rendered).toContain("Plan cleared.");
		expect(rendered.match(/Plan cleared\./g)).toHaveLength(1);
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
