import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createDiffexCodingAgentHarness } from "./diffex-harness.ts";

const diffexCodingAgentHarness = createDiffexCodingAgentHarness({ noTools: "all" });

describeEval("Diffex Coding Agent smoke", { harness: diffexCodingAgentHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.DIFFEX_PROVIDER);
		expect(result.usage.model).toBe(process.env.DIFFEX_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
