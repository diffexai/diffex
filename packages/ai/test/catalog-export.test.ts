import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("strict JSON catalog export", () => {
	it.each(["valid", "upstream-failure", "malformed-model"])("validates %s before writing output", (scenario) => {
		const root = mkdtempSync(join(tmpdir(), "diffex-export-"));
		try {
			const preload = join(root, "upstream.mjs");
			const catalog = {
				"alibaba-token-plan": {
					models: Object.fromEntries(
						[
							"deepseek-v4-flash-0731",
							"deepseek-v4-pro",
							"glm-5.2",
							"qwen3.6-flash",
							"qwen3.7-max",
							"qwen3.7-plus",
							"qwen3.8-max",
						].map((id) => [id, { id, name: id, tool_call: true }]),
					),
				},
			};
			writeFileSync(
				preload,
				`const scenario = ${JSON.stringify(scenario)};
const catalog = ${JSON.stringify(catalog)};
globalThis.fetch = async (input) => {
  if (scenario === "upstream-failure") return new Response("unavailable", { status: 503 });
  if (String(input) === "https://models.dev/api.json") return Response.json(catalog);
  if (String(input) === "https://openrouter.ai/api/v1/models") return Response.json({ data: [{
    id: "fixture", name: "Fixture", supported_parameters: ["tools"],
    pricing: { prompt: scenario === "malformed-model" ? "invalid" : "0.001" }
  }] });
  return Response.json({ data: [] });
};
`,
			);
			const output = join(root, "catalog");
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preload).href,
					"scripts/generate-models.ts",
					"--strict",
					"--json-only",
					"--json-output",
					output,
				],
				{
					cwd: fileURLToPath(new URL("..", import.meta.url)),
					encoding: "utf8",
					timeout: 10_000,
				},
			);
			if (scenario === "valid") {
				expect(result.status, result.stderr).toBe(0);
				const generation = JSON.parse(readFileSync(join(output, "generation.json"), "utf8"));
				expect(Number.isFinite(Date.parse(generation.generatedAt))).toBe(true);
			} else {
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(scenario === "upstream-failure" ? "503" : "cost.input");
				expect(existsSync(output)).toBe(false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
