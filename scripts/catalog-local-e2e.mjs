#!/usr/bin/env node
// Explicit opt-in integration with the companion checkout and an installed AWS CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { catalogFixture } from "./fixtures/model-catalog.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloud = process.env.DIFFEX_CLOUD_DIR;
if (!cloud) throw new Error("Set DIFFEX_CLOUD_DIR to the companion diffex-cloud checkout");
const requireCloud = createRequire(join(resolve(cloud), "services/public-api/package.json"));
const { Miniflare, convertV4MiniflareOptions } = requireCloud("miniflare");
const root = mkdtempSync(join(tmpdir(), "diffex-catalog-e2e-"));
const env = { ...process.env, AWS_ACCESS_KEY_ID: "catalog-local", AWS_SECRET_ACCESS_KEY: "catalog-local-secret", AWS_DEFAULT_REGION: "auto", AWS_EC2_METADATA_DISABLED: "true" };

async function run(command, args, extra = {}) {
	return new Promise((resolveResult, reject) => {
		if (command === "tmux") args = ["-L", `diffex-catalog-${process.pid}`, ...args];
		const child = spawn(command, args, { cwd: repo, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? resolveResult(output) : reject(new Error(`${command} exited ${code}: ${output}`)));
	});
}

const bundle = buildSync({ entryPoints: [join(cloud, "services/public-api/src/index.ts")], bundle: true, format: "esm", write: false, platform: "browser", target: "es2022" }).outputFiles[0].text;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: "2026-09-10", host: "127.0.0.1", port: 0,
	r2Buckets: { MODEL_CATALOGS: { id: "catalog-fixture", s3Credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }, RELEASES: "release-fixture" },
	bindings: { RELEASE_SERVING_ENABLED: "true" }, ratelimits: { RELEASE_RATE_LIMITER: { namespace_id: "1", simple: { limit: 600, period: 60 } } },
}));
try {
	const origin = (await mf.ready).origin;
	const input = join(root, "catalog");
	catalogFixture(input);
	writeFileSync(join(input, "generation.json"), JSON.stringify({ generatedAt: new Date(Date.now() + 60_000).toISOString() }));
	const publish = ["scripts/publish-model-catalog.mjs", "--input", input, "--bucket", "catalog-fixture", "--endpoint", `${origin}/cdn-cgi/local/r2/s3`, "--source-commit", "a".repeat(40)];
	console.log(await run(process.execPath, publish));
	const first = await fetch(`${origin}/api/models/providers/openai`, { headers: { "User-Agent": "diffex/0.3.3" } });
	assert.equal(first.status, 200);
	const etag = first.headers.get("etag");
	const modified = first.headers.get("last-modified");
	await first.body.cancel();
	console.log(await run(process.execPath, publish));
	const unchanged = await fetch(`${origin}/api/models/providers/openai`, { headers: { "If-None-Match": etag } });
	assert.equal(unchanged.status, 304);
	assert.equal(unchanged.headers.get("last-modified"), modified);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "local-fixture-never-used" } }));
	const preload = join(root, "route-catalog.mjs");
	writeFileSync(preload, `let original = globalThis.fetch;
const routed = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://api.diffex.ai" && url.pathname.startsWith("/api/models/providers/")) {
    return original(${JSON.stringify(origin)} + url.pathname, init);
  }
  throw new Error("Unexpected outbound request in isolated catalog rehearsal");
};
Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => routed, set: (value) => { original = value; } });
`);
	const cliEnv = { DIFFEX_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: `--import=${preload}` };
	const cli = join(repo, "diffex-test.sh");
	console.log(await run(cli, ["--no-env", "update", "--models"], cliEnv));
	const cache = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
	assert.equal(cache.openai.models.length, 170);
	assert.equal(cache.openai.catalogUrl, "https://api.diffex.ai/api/models/providers/openai");
	assert.equal(cache.openai.etag, etag);
	console.log(await run(cli, ["--no-env", "update", "--models"], cliEnv));
	assert.equal(JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8")).openai.etag, etag);
	// Use tmux to exercise the real interactive model selector without inference.
	const session = `diffex-catalog-${process.pid}`;
	const tmuxConfig = join(root, "tmux.conf");
	writeFileSync(tmuxConfig, "set -g extended-keys on\nset -g extended-keys-format csi-u\n");
	try {
		await run("tmux", ["-f", tmuxConfig, "new-session", "-d", "-s", session, "-x", "100", "-y", "30", "-c", root, "env", `DIFFEX_CODING_AGENT_DIR=${agentDir}`, `NODE_OPTIONS=--import=${preload}`, cli, "--no-env", "--provider", "openai", "--model", "model-0", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"]);
		let snapshot = "";
		for (let i = 0; i < 30; i++) {
			snapshot = await run("tmux", ["capture-pane", "-t", session, "-p"]);
			if (snapshot.includes("model-0") && snapshot.includes("Ask Diffex")) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		await run("tmux", ["send-keys", "-t", session, "/scoped-models", "Enter"]);
		for (let i = 0; i < 30; i++) {
			snapshot = await run("tmux", ["capture-pane", "-t", session, "-p"]);
			if (snapshot.includes("model-0") && snapshot.includes("Model catalogs refreshed")) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.match(snapshot, /model-0/);
		assert.match(snapshot, /Model catalogs refreshed/);
		assert.doesNotMatch(snapshot, /Connection error/);
		await run("tmux", ["send-keys", "-t", session, "model-0"]);
		for (let i = 0; i < 30; i++) {
			snapshot = await run("tmux", ["capture-pane", "-t", session, "-p"]);
			if (snapshot.includes("model-0 [openai]")) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.match(snapshot, /model-0 \[openai\]/);
		console.log(snapshot);
		await mf.dispose();
		const restarted = await run(cli, ["--no-env", "--list-models", "model-0"], { ...cliEnv, DIFFEX_OFFLINE: "1" });
		assert.match(restarted, /model-0/);
		await run("tmux", ["send-keys", "-t", session, "Escape"]);
		await run("tmux", ["send-keys", "-t", session, "/scoped-models", "Enter"]);
		await new Promise((r) => setTimeout(r, 500));
		const offline = await run("tmux", ["capture-pane", "-t", session, "-p"]);
		assert.match(offline, /model-0/);
	} finally {
		await run("tmux", ["kill-session", "-t", session]);
	}
	console.log("Local publisher -> R2 -> Worker -> CLI -> interactive selector passed; offline cache preserved.");
} finally {
	await mf.dispose();
	rmSync(root, { recursive: true, force: true });
}
