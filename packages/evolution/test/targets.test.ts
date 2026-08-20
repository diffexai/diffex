import { describe, expect, it } from "vitest";
import { EvolutionTargetAdapterRegistry, type EvolutionTargetWriter } from "../src/index.ts";

describe("evolution target boundaries", () => {
	it.each(["skill", "orchestration-source"] as const)("keeps %s targets non-executable", (kind) => {
		const registry = new EvolutionTargetAdapterRegistry();
		const writer = {
			kind,
			write: () => Promise.reject(new Error("disabled writer executed")),
			activate: () => Promise.reject(new Error("disabled activator executed")),
		} satisfies EvolutionTargetWriter;

		expect(registry.isEnabled(kind)).toBe(false);
		expect(registry.writerFor(kind)).toBeUndefined();
		expect(() => registry.register(writer)).toThrow(`Evolution target "${kind}" is not enabled`);
	});
});
