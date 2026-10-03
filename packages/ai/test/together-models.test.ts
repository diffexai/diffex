import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { Model } from "../src/types.ts";
import { individualModelCatalog, withModelGenerationFixture } from "./fixtures/model-generation.ts";

const togetherModels = {
	"moonshotai/Kimi-K3": {
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		tool_call: true,
		reasoning: true,
		modalities: { input: ["text", "image"] },
		limit: { context: 1048576, output: 131072 },
		cost: { input: 3, output: 15, cache_read: 0.3 },
	},
	"openai/gpt-oss-120b": {
		id: "openai/gpt-oss-120b",
		tool_call: true,
		reasoning: true,
		reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
	},
	"deepseek-ai/DeepSeek-V4-Pro": { id: "deepseek-ai/DeepSeek-V4-Pro", tool_call: true, reasoning: true },
	"MiniMaxAI/MiniMax-M2.7": { id: "MiniMaxAI/MiniMax-M2.7", tool_call: true, reasoning: true },
};

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("generates Together metadata and reasoning controls independently of the live catalog", () => {
		withModelGenerationFixture({ ...individualModelCatalog, together: { models: togetherModels } }, (fixture) => {
			const result = fixture.generate();
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			const catalog: Record<string, Record<string, Model<"openai-completions">>> = JSON.parse(
				readFileSync(join(fixture.packageRoot, "src/providers/data/together.json"), "utf8"),
			);
			const models = catalog["openai-completions"];
			const model = models["moonshotai/Kimi-K3"];

			expect(model).toBeDefined();
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("together");
			expect(model.baseUrl).toBe("https://api.together.ai/v1");
			expect(model.reasoning).toBe(true);
			expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
			expect(model.input).toEqual(["text", "image"]);
			expect(model.contextWindow).toBe(1048576);
			expect(model.maxTokens).toBe(131072);
			expect(model.cost).toEqual({
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 0,
			});
			expect(model.compat).toEqual({
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				thinkingFormat: "together",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			});
			const gptOss = models["openai/gpt-oss-120b"];
			expect(gptOss.thinkingLevelMap).toEqual({
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				max: null,
				xhigh: null,
			});
			expect(gptOss.compat).toMatchObject({
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			});

			const deepSeekV4 = models["deepseek-ai/DeepSeek-V4-Pro"];
			expect(deepSeekV4.thinkingLevelMap).toEqual({
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
			});
			expect(deepSeekV4.compat).toMatchObject({
				supportsReasoningEffort: true,
				thinkingFormat: "together",
			});

			const minimax = models["MiniMaxAI/MiniMax-M2.7"];
			expect(minimax.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null });
			expect(minimax.compat?.thinkingFormat).toBeUndefined();
			expect(minimax.compat?.supportsReasoningEffort).toBe(false);
		});
	});

	it.each(["absent", "deprecated", "without tools"] as const)("omits a Together model that is %s", (state) => {
		const models: Record<string, object> = { ...togetherModels };
		const deepSeekId = "deepseek-ai/DeepSeek-V4-Pro";
		if (state === "absent") delete models[deepSeekId];
		else models[deepSeekId] = { ...togetherModels[deepSeekId], status: state, tool_call: state !== "without tools" };
		withModelGenerationFixture({ ...individualModelCatalog, together: { models } }, (fixture) => {
			const result = fixture.generate();
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			const catalog = JSON.parse(
				readFileSync(join(fixture.packageRoot, "src/providers/data/together.json"), "utf8"),
			);
			expect(catalog["openai-completions"][deepSeekId]).toBeUndefined();
			expect(catalog["openai-completions"]["openai/gpt-oss-120b"]).toMatchObject({
				provider: "together",
				compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
			});
		});
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
