import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "../src/types.ts";

/** Small upstream inputs, not snapshots of generated output or the live catalog. */
export function modelsDevProvider(models: Record<string, object>): { models: Record<string, object> } {
	return {
		models: Object.fromEntries(
			Object.entries(models).map(([id, metadata]) => [
				id,
				{ id, name: id, tool_call: true, reasoning: true, ...metadata },
			]),
		),
	};
}

/** Exercise the production generator without network access or source-tree writes. */
export function generateModelsFixture(modelsDev: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "diffex-model-catalog-fixture-"));
	try {
		// Strict generation requires this explicit Individual plan allowlist.
		const catalog = {
			"alibaba-token-plan": modelsDevProvider(
				Object.fromEntries(
					[
						"deepseek-v4-flash-0731",
						"deepseek-v4-pro",
						"glm-5.2",
						"qwen3.6-flash",
						"qwen3.7-max",
						"qwen3.7-plus",
						"qwen3.8-max",
					].map((id) => [id, {}]),
				),
			),
			...modelsDev,
		};
		const preloadPath = join(root, "mock-catalog.mjs");
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
				`  if (["https://openrouter.ai/api/v1/models", "https://ai-gateway.vercel.sh/v1/models"].includes(url)) return Response.json({ data: [] });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--strict",
				"--json-only",
				"--json-output",
				join(root, "catalog"),
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
		);
		if (result.status !== 0) {
			throw new Error(`Fixture model generation failed: ${result.stdout}\n${result.stderr}`, {
				cause: result.error,
			});
		}
		const providers = JSON.parse(readFileSync(join(root, "catalog/models.json"), "utf8")) as Record<
			string,
			Record<string, Model<Api>>
		>;
		return {
			getModels(provider: string): Model<Api>[] {
				return Object.values(providers[provider] ?? {});
			},
			getModel<TApi extends Api>(provider: string, id: string, api: TApi): Model<TApi> {
				const model = providers[provider]?.[id];
				if (!model || model.api !== api) throw new Error(`Missing fixture model ${provider}/${id} (${api})`);
				return structuredClone(model) as Model<TApi>;
			},
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
