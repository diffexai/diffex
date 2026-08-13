import { describe, expect, it, vi } from "vitest";
import { createEvolveTool } from "../src/core/tools/evolve.ts";

describe("evolve tool", () => {
	it("appends a normalized structured note", async () => {
		const appendNote = vi.fn(async () => ({ path: "/agent/EVOLVED.md" }));
		const tool = createEvolveTool({ appendNote });

		const result = await tool.execute(
			"call-1",
			{
				note: "  Prefer primary sources.  ",
				category: "workflow",
				scope: "global",
				appliesTo: "user",
				evidence: "  The user corrected an uncited claim.  ",
			},
			undefined,
			undefined,
		);

		expect(appendNote).toHaveBeenCalledWith({
			note: "Prefer primary sources.",
			category: "workflow",
			scope: "global",
			appliesTo: "user",
			evidence: "The user corrected an uncited claim.",
		});
		expect(result.details).toEqual({ path: "/agent/EVOLVED.md" });
	});

	it("rejects whitespace-only notes", async () => {
		const tool = createEvolveTool({
			appendNote: async () => ({ path: "/agent/EVOLVED.md" }),
		});

		await expect(
			tool.execute("call-1", { note: "   ", category: "other", scope: "global" }, undefined, undefined),
		).rejects.toThrow("Evolution note must not be empty");
	});
});
