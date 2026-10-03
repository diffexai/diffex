import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export const individualModelIds = [
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max",
] as const;

export const individualModelCatalog = {
	"alibaba-token-plan": {
		models: Object.fromEntries(individualModelIds.map((id) => [id, { id, name: id, tool_call: true }])),
	},
};

export function withModelGenerationFixture(
	catalog: object,
	verify: (fixture: { packageRoot: string; generate: () => SpawnSyncReturns<string> }) => void,
): void {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "diffex-generate-models-"));
	const isolatedPackageRoot = join(fixtureRoot, "package");
	const preloadPath = join(fixtureRoot, "mock-catalog.mjs");
	function generate() {
		return spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
	}
	try {
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`const emptyFeeds = new Set(["https://openrouter.ai/api/v1/models", "https://ai-gateway.vercel.sh/v1/models", "https://integrate.api.nvidia.com/v1/models"]);\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  if (emptyFeeds.has(url)) return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);
		verify({ packageRoot: isolatedPackageRoot, generate });
	} finally {
		rmSync(fixtureRoot, { force: true, recursive: true });
	}
}
