import { describe, expect, it } from "vitest";
import { generateModelsFixture, modelsDevProvider } from "./generate-models-fixture.ts";

const catalog = generateModelsFixture({
	xiaomi: modelsDevProvider({ "mimo-v2-flash": {}, "mimo-v2-omni": {}, "mimo-v2.5-pro": {} }),
	...Object.fromEntries(
		["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"].map((provider) => [
			provider,
			modelsDevProvider({ "mimo-v2.5-pro": {} }),
		]),
	),
});

describe("Xiaomi MiMo models", () => {
	it.each(["mimo-v2-flash", "mimo-v2-omni"] as const)("keeps %s on the API billing provider", (modelId) => {
		expect(catalog.getModel("xiaomi", modelId, "openai-completions").baseUrl).toBe("https://api.xiaomimimo.com/v1");
	});

	it.each(["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"omits API-billing-only models from %s",
		(provider) => {
			const modelIds = catalog.getModels(provider).map((model) => model.id);
			expect(modelIds).toContain("mimo-v2.5-pro");
			expect(modelIds).not.toContain("mimo-v2-flash");
			expect(modelIds).not.toContain("mimo-v2-omni");
		},
	);
});
