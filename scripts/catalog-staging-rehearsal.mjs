#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogFixture } from "./fixtures/model-catalog.mjs";
import { createS3Store, publishCatalog, validateBundle } from "./publish-model-catalog.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--staging") throw new Error("Explicit --staging opt-in required");
const bucket = "diffex-artifacts-staging";
const endpoint = "https://6b24afa849f8254ab5e6e2d1956239cc.r2.cloudflarestorage.com";
const origin = "https://diffex-public-api-staging.yibai14651.workers.dev";
const indexKey = "models/v1/index.json";
const root = mkdtempSync(join(tmpdir(), "diffex-catalog-staging-"));
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const store = createS3Store(bucket, endpoint, root);
const previous = store.get(indexKey);
if (previous) writeFileSync(join(root, "index-before.json"), previous.bytes);
let fixtureRevision;
let writtenIndex;
let fixtureKeys = [];
try {
	const input = join(root, "catalog");
	const models = catalogFixture(input, source);
	models.openai["model-0"].name = `Staging rehearsal ${randomUUID()}`;
	writeFileSync(join(input, "models.json"), JSON.stringify(models));
	writeFileSync(join(input, "providers/openai.json"), JSON.stringify(models.openai));
	writeFileSync(join(input, "generation.json"), JSON.stringify({ generatedAt: new Date().toISOString(), sourceCommit: source }));
	fixtureRevision = validateBundle(input).revision;
	const prefix = `models/v1/revisions/${fixtureRevision}`;
	fixtureKeys = ["models.json", "providers.json", "publication.json", ...Object.keys(models).map((id) => `providers/${id}.json`)].map((suffix) => `${prefix}/${suffix}`);
	for (const key of fixtureKeys) assert.equal(store.get(key), null, "Fixture must not already exist");
	let puts = 0;
	assert.throws(() => publishCatalog(input, { ...store, put: (...args) => {
		if (++puts === 3) throw new Error("Intentional interrupted fixture upload");
		return store.put(...args);
	} }, source), /Intentional interrupted/);
	assert.deepEqual(store.get(indexKey)?.bytes, previous?.bytes, "Interrupted upload changed index");
	const publication = publishCatalog(input, store, source);
	writtenIndex = store.get(indexKey);
	assert.equal(store.put(indexKey, Buffer.from("{}"), '"incorrect-etag"'), false, "R2 must reject stale conditional index writes");
	assert.equal(store.put(`${prefix}/publication.json`, Buffer.from("{}")), false, "R2 must reject immutable overwrites");
	const url = `${origin}/api/models/providers/openai`;
	// Synchronous S3 checks can outlast an idle HTTP connection; do not reuse it across those checks.
	const first = await fetch(url, { headers: { "User-Agent": "diffex/0.3.3", Connection: "close" }, signal: AbortSignal.timeout(10000) });
	assert.equal(first.status, 200);
	assert.deepEqual(await first.json(), models.openai);
	assert.equal(first.headers.get("etag")?.replace(/^W\//, ""), `"${fixtureRevision}:openai"`);
	assert.equal(first.headers.get("last-modified"), new Date(publication.generatedAt).toUTCString());
	assert.deepEqual(publishCatalog(input, store, source), publication);
	writtenIndex = store.get(indexKey);
	const revalidated = await fetch(url, { headers: { "If-None-Match": first.headers.get("etag"), Connection: "close" }, signal: AbortSignal.timeout(10000) });
	assert.equal(revalidated.status, 304);
	assert.equal(await revalidated.text(), "");
	assert.equal(revalidated.headers.get("last-modified"), first.headers.get("last-modified"));
	const head = await fetch(url, { method: "HEAD", headers: { Connection: "close" }, signal: AbortSignal.timeout(10000) });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "staging-fixture-never-used" } }));
	const preload = join(root, "staging-route.mjs");
	writeFileSync(preload, `let original = globalThis.fetch;
const routed = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://api.diffex.ai" && url.pathname.startsWith("/api/models/providers/")) return original(${JSON.stringify(origin)} + url.pathname, init);
  throw new Error("Unexpected outbound request in staging rehearsal");
};
Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => routed, set: (value) => { original = value; } });
`);
	const cliEnv = { ...process.env, DIFFEX_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: `--import=${preload}` };
	for (let i = 0; i < 2; i++) {
		const output = execFileSync("./diffex-test.sh", ["--no-env", "update", "--models"], { env: cliEnv, encoding: "utf8", timeout: 30_000 });
		assert.match(output, /Model catalogs refreshed/);
		const cache = JSON.parse(readFileSync(join(agentDir, "models-store.json"), "utf8"));
		assert.equal(cache.openai.models.length, 170);
		assert.equal(cache.openai.etag.replace(/^W\//, ""), `"${fixtureRevision}:openai"`);
	}
	const offline = execFileSync("./diffex-test.sh", ["--no-env", "--list-models", "model-0"], { env: { ...cliEnv, DIFFEX_OFFLINE: "1" }, encoding: "utf8", timeout: 30_000 });
	assert.match(offline, /model-0/);
	console.log(JSON.stringify({ staging: true, revision: fixtureRevision, interruptedUploadPreservedIndex: true, conditionalConflictsRejected: true, identicalRetryPreservedManifest: true, clientRefreshAndOfflineRecovery: true, statuses: [first.status, revalidated.status, head.status] }));
} finally {
	try {
		if (writtenIndex) {
			if (previous) {
				assert.equal(store.put(indexKey, previous.bytes, writtenIndex.etag), true, "Concurrent staging publication: refusing to overwrite index");
			} else {
				execFileSync("aws", ["s3api", "delete-object", "--bucket", bucket, "--endpoint-url", endpoint, "--key", indexKey, "--if-match", writtenIndex.etag], { stdio: "pipe" });
			}
		}
		const current = store.get(indexKey);
		if (current && JSON.parse(current.bytes).catalogs.some((tier) => tier.revision === fixtureRevision)) throw new Error("Fixture is still selected; refusing cleanup");
		for (const key of fixtureKeys) {
			const object = store.get(key);
			if (object) execFileSync("aws", ["s3api", "delete-object", "--bucket", bucket, "--endpoint-url", endpoint, "--key", key, "--if-match", object.etag], { stdio: "pipe" });
			assert.equal(store.get(key), null, `Fixture cleanup failed: ${key}`);
		}
		assert.deepEqual(store.get(indexKey)?.bytes, previous?.bytes, "Original index was not restored");
		console.log(JSON.stringify({ cleanup: "verified", indexRestored: true, remainingFixtureObjects: 0 }));
	} catch (error) {
		console.error(`Cleanup did not complete; recovery evidence retained at ${root}`);
		throw error;
	}
	rmSync(root, { recursive: true, force: true });
}
