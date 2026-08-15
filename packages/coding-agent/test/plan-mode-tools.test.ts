import { describe, expect, it, vi } from "vitest";
import {
	createPlanImplementationPrompt,
	createSubmitPlanToolDefinition,
	type PlanArtifact,
	SUBMIT_PLAN_TOOL_NAME,
} from "../src/core/plan-mode.ts";

describe("submit_plan", () => {
	it("normalizes the title to one line and returns the persisted artifact", async () => {
		const plan: PlanArtifact = {
			id: "plan-1",
			title: "Ship the change",
			markdown: "1. Inspect\n2. Implement\n3. Test",
		};
		const submitPlan = vi.fn(() => plan);
		const tool = createSubmitPlanToolDefinition({ submitPlan });

		const result = await tool.execute(
			"call-1",
			{ title: "  Ship\n\tthe change  ", markdown: "  1. Inspect\n2. Implement\n3. Test  " },
			undefined,
			undefined,
			undefined as never,
		);

		expect(tool.name).toBe(SUBMIT_PLAN_TOOL_NAME);
		expect(tool.executionMode).toBe("sequential");
		expect(submitPlan).toHaveBeenCalledWith({
			title: "Ship the change",
			markdown: "1. Inspect\n2. Implement\n3. Test",
		});
		expect(result.details).toEqual({ plan });
	});

	it.each([
		["title", { title: "unsafe\u001b[31m", markdown: "Safe body" }],
		["Markdown", { title: "Safe title", markdown: "unsafe\u202e body" }],
	])("rejects unsafe control text in plan %s", async (_field, input) => {
		const tool = createSubmitPlanToolDefinition({
			submitPlan: () => ({ id: "unused", title: input.title, markdown: input.markdown }),
		});

		await expect(tool.execute("call-1", input, undefined, undefined, undefined as never)).rejects.toThrow(
			"unsafe control text",
		);
	});

	it("builds an explicit implementation authorization prompt", () => {
		const prompt = createPlanImplementationPrompt({
			id: "plan-1",
			title: "Ship the change",
			markdown: "- Update the API\n- Add tests",
		});

		expect(prompt).toContain("explicitly accepted");
		expect(prompt).toContain("# Ship the change");
		expect(prompt).toContain("- Add tests");
	});
});
