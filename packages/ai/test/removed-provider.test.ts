import { describe, expect, it } from "vitest";
import { createModels, createProvider } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

describe("removed provider registration", () => {
	it.each(["radius", "Radius", " radius "])("rejects %s before invoking any provider hooks", (id) => {
		const models = createModels();
		expect(() => models.setProvider({ ...anthropicProvider(), id })).toThrow("Radius support has been removed");
		expect(() => createProvider({ id, auth: {}, models: [], api: {} })).toThrow("Radius support has been removed");
		expect(models.getProviders()).toEqual([]);
	});
});
