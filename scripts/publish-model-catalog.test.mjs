import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishCatalog, validateBundle } from "./publish-model-catalog.mjs";
import { publicationAllowed } from "./model-publication-window.mjs";

const source = "a".repeat(40);
const indexKey = "models/v1/index.json";

export function catalogFixture(root) {
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

function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "diffex-publish-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	catalogFixture(root);
	const objects = new Map();
	const store = {
		get(key) { return objects.get(key) ?? null; },
		put(key, bytes, etag) {
			const existing = objects.get(key);
			if (etag ? existing?.etag !== etag : existing !== undefined) return false;
			objects.set(key, { bytes: Buffer.from(bytes), etag: `"${createHash("sha256").update(bytes).digest("hex")}"` });
			return true;
		},
	};
	return { root, objects, store };
}

test("publishes complete revisions and preserves immutable metadata on identical retries", (t) => {
	const { root, store, objects } = setup(t);
	const first = publishCatalog(root, store, source);
	const immutable = new Map([...objects].filter(([key]) => key !== indexKey));
	const firstIndex = JSON.parse(objects.get(indexKey).bytes);
	assert.equal(first.minimumDiffexVersion, "0.3.3");
	assert.equal(first.providerCount, 3);
	assert.equal(first.modelCount, 510);
	assert.ok(firstIndex.validatedAt);
	writeFileSync(join(root, "generation.json"), JSON.stringify({ generatedAt: "2026-10-27T10:00:00.000Z", sourceCommit: "b".repeat(40) }));
	assert.deepEqual(publishCatalog(root, store, "b".repeat(40)), first);
	assert.equal(JSON.parse(objects.get(indexKey).bytes).validationSourceCommit, "b".repeat(40));
	assert.deepEqual(new Map([...objects].filter(([key]) => key !== indexKey)), immutable);
});

test("interrupted uploads leave the index untouched and can be resumed", (t) => {
	const { root, store, objects } = setup(t);
	const put = store.put;
	let writes = 0;
	store.put = (...args) => { if (++writes === 3) throw new Error("interrupted"); return put(...args); };
	assert.throws(() => publishCatalog(root, store, source), /interrupted/);
	assert.equal(objects.has(indexKey), false);
	store.put = put;
	publishCatalog(root, store, source);
	assert.ok(objects.has(indexKey));
});

test("rejects conflicting revision bytes and conditional index conflicts", (t) => {
	const { root, store, objects } = setup(t);
	const revision = validateBundle(root).revision;
	store.put(`models/v1/revisions/${revision}/models.json`, Buffer.from("{}"));
	assert.throws(() => publishCatalog(root, store, source), /verification failed/);
	assert.equal(objects.has(indexKey), false);
	objects.clear();
	const put = store.put;
	store.put = (key, ...args) => key === indexKey ? false : put(key, ...args);
	assert.throws(() => publishCatalog(root, store, source), /changed concurrently/);
	assert.equal(objects.has(indexKey), false);
});

test("rejects stale sources both before and after upload", (t) => {
	const { root, store, objects } = setup(t);
	assert.throws(() => publishCatalog(root, store, "b".repeat(40)), /source SHA/);
	assert.throws(() => publishCatalog(root, store, source, () => { throw new Error("stale"); }), /stale/);
	assert.equal(objects.size, 0);
	let checks = 0;
	assert.throws(() => publishCatalog(root, store, source, () => { if (++checks === 2) throw new Error("stale"); }), /stale/);
	assert.equal(objects.has(indexKey), false);
});

test("rejects malformed fields, inconsistent shards, invalid timestamps and small catalogs", (t) => {
	const { root } = setup(t);
	const models = JSON.parse(readFileSync(join(root, "models.json")));
	models.openai["model-0"].contextWindow = -1;
	writeFileSync(join(root, "models.json"), JSON.stringify(models));
	assert.throws(() => validateBundle(root), /shard does not match/);
	writeFileSync(join(root, "providers/openai.json"), JSON.stringify(models.openai));
	assert.throws(() => validateBundle(root), /contextWindow/);
	catalogFixture(root);
	writeFileSync(join(root, "generation.json"), "{}");
	assert.throws(() => validateBundle(root), /timestamp/);
	catalogFixture(root);
	for (const provider of Object.keys(models)) {
		models[provider] = { "model-1": models[provider]["model-1"] };
		writeFileSync(join(root, "providers", `${provider}.json`), JSON.stringify(models[provider]));
	}
	writeFileSync(join(root, "models.json"), JSON.stringify(models));
	assert.throws(() => validateBundle(root), /expected at least 500/);
});

test("publication windows preserve weekday Vienna hours across DST boundaries", () => {
	for (const [date, schedule, ci] of [
		["2026-03-27T09:17:00Z", true, true], ["2026-03-30T08:17:00Z", true, true],
		["2026-10-23T12:17:00Z", true, true], ["2026-10-26T13:17:00Z", true, true],
		["2026-10-26T10:17:00Z", false, true], ["2026-10-26T14:00:00Z", false, false],
		["2026-10-26T08:59:00Z", false, false], ["2026-10-25T09:17:00Z", false, false],
	]) {
		assert.equal(publicationAllowed("schedule", false, new Date(date)), schedule, date);
		assert.equal(publicationAllowed("workflow_run", false, new Date(date)), ci, date);
	}
	assert.equal(publicationAllowed("workflow_dispatch", true, new Date("2026-10-25")), true);
	assert.equal(publicationAllowed("pull_request", true), false);
});
