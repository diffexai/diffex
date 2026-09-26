import type { AgentToolResult } from "@diffexai/diffex-agent-core";
import { getModel, streamSimple } from "@diffexai/diffex-ai/compat";
import type { TUI } from "@diffexai/diffex-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	createUpdatePlanTool,
	createUpdatePlanToolDefinition,
	resolveUpdatePlanOperation,
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
				{ id: "read-the-code", step: "Read the code", status: "completed" },
				{
					id: "implement-the-tool",
					step: "  Implement the tool  ",
					status: "in_progress",
					success_criteria: ["Survives restart"],
				},
				{ id: "run-checks", step: "Run checks", status: "pending" },
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
		input.plan[1]!.success_criteria![0] = "mutated";
		input.explanation = "mutated";
		expect(result.details.plan[0]?.step).toBe("Read the code");
		expect(result.details.plan[1]?.step).toBe("  Implement the tool  ");
		expect(result.details.plan[1]?.success_criteria).toEqual(["Survives restart"]);
		expect(result.details.explanation).toBe("  Repository evidence changed.\n");
	});

	test("accepts all-completed plans without an in-progress item", async () => {
		const result = await executeUpdatePlan({
			plan: [
				{ id: "read-the-code", step: "Read the code", status: "completed" },
				{ id: "run-checks", step: "Run checks", status: "completed" },
			],
		});

		expect(getTextOutput(result)).toBe("Plan updated: 2 completed, 0 in progress, 0 pending.");
	});

	test("updates one step by ID while preserving its identity and the other steps", async () => {
		const plan = [
			{
				id: "settings",
				step: "Fix settings",
				status: "in_progress" as const,
				success_criteria: ["Survives restart"],
			},
			{ id: "checks", step: "Run checks", status: "pending" as const },
		];
		const tool = createUpdatePlanTool(() => plan);
		const result = await tool.execute("tool-1", {
			update: {
				id: "settings",
				step: "Fix settings persistence",
				success_criteria: ["Changed settings survive restart", "Existing settings remain readable"],
			},
		});

		expect(getTextOutput(result)).toBe("Plan updated: 0 completed, 1 in progress, 1 pending.");
		expect(result.details).toEqual({
			plan: [
				{
					id: "settings",
					step: "Fix settings persistence",
					status: "in_progress",
					success_criteria: ["Changed settings survive restart", "Existing settings remain readable"],
				},
				plan[1],
			],
		});
		expect(plan[0]?.step).toBe("Fix settings");
		expect(plan[0]?.success_criteria).toEqual(["Survives restart"]);

		const clearedCriteria = resolveUpdatePlanOperation({ update: { id: "settings", success_criteria: [] } }, plan);
		expect(clearedCriteria).toEqual({
			plan: [{ id: "settings", step: "Fix settings", status: "in_progress" }, plan[1]],
		});
	});

	test("validates step identity, criteria, and single-step updates", async () => {
		await expect(
			executeUpdatePlan({ plan: [{ step: "Missing ID", status: "in_progress" }] } as unknown as UpdatePlanToolInput),
		).rejects.toThrow("id must be a non-empty string");
		await expect(
			executeUpdatePlan({
				plan: [
					{ id: "same", step: "First", status: "in_progress" },
					{ id: "same", step: "Second", status: "pending" },
				],
			}),
		).rejects.toThrow("Duplicate plan item id: same.");
		await expect(
			executeUpdatePlan({ plan: [{ id: "one", step: "One", status: "in_progress", success_criteria: [" "] }] }),
		).rejects.toThrow("success_criteria must be an array of non-empty strings");
		expect(() => resolveUpdatePlanOperation({ update: { id: "unknown", status: "completed" } })).toThrow(
			"without a current plan",
		);
		expect(() =>
			resolveUpdatePlanOperation({ update: { id: "unknown", status: "completed" } }, [
				{ id: "one", step: "One", status: "in_progress" },
			]),
		).toThrow("Unknown plan step id: unknown.");
		expect(() =>
			resolveUpdatePlanOperation({ update: { id: "one", status: "pending" } }, [
				{ id: "one", step: "One", status: "in_progress" },
			]),
		).toThrow("exactly one in_progress");
	});

	test("treats each call as a replacement snapshot", async () => {
		const first = await executeUpdatePlan({
			explanation: "Initial approach",
			plan: [
				{ id: "one", step: "One", status: "in_progress" },
				{ id: "two", step: "Two", status: "pending" },
			],
		});
		const second = await executeUpdatePlan({
			plan: [{ id: "different", step: "Different", status: "completed" }],
		});

		expect(first.details).toEqual({
			explanation: "Initial approach",
			plan: [
				{ id: "one", step: "One", status: "in_progress" },
				{ id: "two", step: "Two", status: "pending" },
			],
		});
		expect(second.details).toEqual({ plan: [{ id: "different", step: "Different", status: "completed" }] });
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
			"Provide exactly one update_plan operation: plan, update, or clear.",
		);
		await expect(
			executeUpdatePlan({
				plan: [{ id: "one", step: "One", status: "completed" }],
				clear: true,
			} as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Provide exactly one update_plan operation: plan, update, or clear.");
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
		await expect(executeUpdatePlan({ plan: [{ id: "blank", step: "   ", status: "in_progress" }] })).rejects.toThrow(
			"Plan item 1 step must be a non-empty string.",
		);
		await expect(
			executeUpdatePlan({
				plan: [{ id: "one", step: "One", status: "in_progress", owner: "agent" }],
			} as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Plan item 1 contains unexpected field: owner.");
		await expect(
			executeUpdatePlan({
				plan: [
					{ id: "one", step: "One", status: "pending" },
					{ id: "two", step: "Two", status: "pending" },
				],
			}),
		).rejects.toThrow("Unfinished plans must contain exactly one in_progress item.");
		await expect(
			executeUpdatePlan({
				plan: [
					{ id: "one", step: "One", status: "in_progress" },
					{ id: "two", step: "Two", status: "in_progress" },
				],
			}),
		).rejects.toThrow("Unfinished plans must contain exactly one in_progress item.");
		await expect(
			executeUpdatePlan({
				plan: [{ id: "one", step: "One", status: "blocked" }],
			} as unknown as UpdatePlanToolInput),
		).rejects.toThrow("Plan item 1 status must be pending, in_progress, or completed.");
	});

	test("publishes a provider-compatible object schema", () => {
		const definition = createUpdatePlanToolDefinition();
		const parameters = definition.parameters as {
			type?: string;
			additionalProperties?: boolean;
			properties?: {
				clear?: { const?: boolean };
				explanation?: { type?: string };
				update?: { additionalProperties?: boolean; properties?: { id?: { type?: string } } };
				plan?: {
					minItems?: number;
					items?: {
						additionalProperties?: boolean;
						properties?: {
							id?: { type?: string };
							status?: { enum?: string[] };
							success_criteria?: { type?: string };
						};
					};
				};
			};
			required?: string[];
		};

		expect(parameters.type).toBe("object");
		expect(parameters.additionalProperties).toBe(false);
		expect(parameters.required).toBeUndefined();
		for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
			expect(parameters).not.toHaveProperty(keyword);
		}
		expect(parameters.properties?.plan?.minItems).toBe(1);
		expect(parameters.properties?.plan?.items?.additionalProperties).toBe(false);
		expect(parameters.properties?.plan?.items?.properties?.id?.type).toBe("string");
		expect(parameters.properties?.plan?.items?.properties?.success_criteria?.type).toBe("array");
		expect(parameters.properties?.update?.additionalProperties).toBe(false);
		expect(parameters.properties?.update?.properties?.id?.type).toBe("string");
		expect(parameters.properties?.plan?.items?.properties?.status?.enum).toEqual([
			"pending",
			"in_progress",
			"completed",
		]);
		expect(parameters.properties?.clear?.const).toBe(true);
		expect(parameters.properties?.explanation?.type).toBe("string");
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

	test("sends the object schema through an OpenAI Responses interaction", async () => {
		const model = getModel("openai", "gpt-5-mini");
		expect(model).toBeDefined();
		if (!model) throw new Error("Expected the OpenAI model fixture");
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
						`data: ${JSON.stringify({
							type: "response.completed",
							response: {
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						})}\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
				onPayload: (requestPayload) => {
					payload = requestPayload;
				},
			},
		).result();

		const sentPayload = payload as {
			tools?: Array<{ name?: string; parameters?: Record<string, unknown> & { type?: string } }>;
		};
		const updatePlan = sentPayload.tools?.find((tool) => tool.name === "update_plan");
		expect(updatePlan?.parameters?.type).toBe("object");
		for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
			expect(updatePlan?.parameters).not.toHaveProperty(keyword);
		}
		expect(result.stopReason).toBe("stop");
	});

	test("marks both tool representations as sequential", () => {
		expect(createUpdatePlanToolDefinition().executionMode).toBe("sequential");
		expect(createUpdatePlanTool().executionMode).toBe("sequential");
	});

	test("does not render partial update_plan arguments as invalid", () => {
		const definition = createUpdatePlanToolDefinition() as ToolDefinition;
		const component = new ToolExecutionComponent(
			"update_plan",
			"tool-streaming",
			{},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);

		const streaming = stripAnsi(component.render(120).join("\n"));
		expect(streaming).toContain("update_plan");
		expect(streaming).not.toContain("[invalid arg]");

		component.setArgsComplete();
		const complete = stripAnsi(component.render(120).join("\n"));
		expect(complete).toContain("[invalid arg]");
	});

	test("renders update explanations and checklists once while suppressing the successful result body", () => {
		const input = {
			explanation: "Repository evidence changed.",
			plan: [
				{ id: "read-the-code", step: "Read the code", status: "completed" },
				{
					id: "implement-the-tool",
					step: "Implement the tool",
					status: "in_progress",
					success_criteria: ["Works after restart"],
				},
				{ id: "run-checks", step: "Run checks", status: "pending" },
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
		expect(rendered).toContain("[x] read-the-code Read the code");
		expect(rendered).toContain("[>] implement-the-tool Implement the tool");
		expect(rendered).toContain("- Works after restart");
		expect(rendered).toContain("[ ] run-checks Run checks");
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
			{ plan: [{ id: "read", step: "Read", status: "pending" }] },
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
