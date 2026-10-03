import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { individualModelCatalog, individualModelIds, withModelGenerationFixture } from "./fixtures/model-generation.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("strict model generation", () => {
	it("preserves Kimi Coding models from the renamed regional catalog", () => {
		const catalog = {
			...individualModelCatalog,
			"kimi-code-plan-cn": {
				models: {
					"kimi-for-coding": {
						id: "kimi-for-coding",
						name: "Kimi For Coding",
						tool_call: true,
						reasoning: true,
						limit: { context: 1048576, output: 32768 },
					},
				},
			},
		};
		withModelGenerationFixture(catalog, (fixture) => {
			const result = fixture.generate();
			expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
			const models = JSON.parse(
				readFileSync(join(fixture.packageRoot, "src/providers/data/kimi-coding.json"), "utf8"),
			);
			expect(models["anthropic-messages"]["kimi-for-coding"]).toMatchObject({
				provider: "kimi-coding",
				baseUrl: "https://api.kimi.com/coding",
				contextWindow: 1048576,
				maxTokens: 32768,
				compat: { forceAdaptiveThinking: true, allowEmptySignature: true },
			});
		});
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const sourceModels = Object.fromEntries(
			[...individualModelIds, "qwen3.8-max-preview"].map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		withModelGenerationFixture(catalog, (fixture) => {
			const generatedPaths = [
				"src/models.generated.ts",
				"src/providers/qwen-token-plan-individual.models.ts",
				"src/providers/data/qwen-token-plan-individual.json",
				"src/providers/data/.manifest.json",
			];
			const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
			const isolatedBefore = generatedPaths.map((path) => readFileSync(join(fixture.packageRoot, path), "utf8"));

			const result = fixture.generate();
			expect(result.status).toBe(1);
			expect(`${result.stdout}\n${result.stderr}`).toContain(
				"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
			);
			expect(generatedPaths.map((path) => readFileSync(join(fixture.packageRoot, path), "utf8"))).toEqual(
				isolatedBefore,
			);
			expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
		});
	});
});
