import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function catalogFixture(root, source = "a".repeat(40)) {
	mkdirSync(join(root, "providers"), { recursive: true });
	const models = Object.fromEntries(["anthropic", "openai", "openrouter"].map((provider) => [provider,
		Object.fromEntries(Array.from({ length: 170 }, (_, i) => [`model-${i}`, {
			id: `model-${i}`, name: `Model ${i}`, api: "openai-completions", provider,
			baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1000,
		}]))]));
	writeFileSync(join(root, "models.json"), JSON.stringify(models));
	writeFileSync(join(root, "providers.json"), JSON.stringify(Object.keys(models)));
	writeFileSync(join(root, "generation.json"), JSON.stringify({ generatedAt: "2026-10-26T10:00:00.000Z", sourceCommit: source }));
	for (const [id, shard] of Object.entries(models)) writeFileSync(join(root, "providers", `${id}.json`), JSON.stringify(shard));
	return models;
}

