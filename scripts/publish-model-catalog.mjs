#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { parseModelCatalog } from "../packages/ai/src/model-validation.ts";

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_PREFIX = `models/v${CATALOG_SCHEMA_VERSION}`;
const CATALOG_INDEX_KEY = `${CATALOG_PREFIX}/index.json`;
// Bump this only when generated model metadata requires behavior unavailable in older Diffex clients.
const MINIMUM_DIFFEX_VERSION = "0.3.3";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const INDEX_CACHE_CONTROL = "no-store";
const REQUIRED_PROVIDERS = ["anthropic", "openai", "openrouter"];
const MINIMUM_MODEL_COUNT = 500;

function parseArgs(args) {
	const options = {
		input: undefined,
		bucket: undefined,
		endpoint: undefined,
		sourceCommit: undefined,
		dryRun: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--require-main") {
			options.requireMain = true;
			continue;
		}
		if (arg === "--input" || arg === "--bucket" || arg === "--endpoint" || arg === "--source-commit") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			options[
				{
					"--input": "input",
					"--bucket": "bucket",
					"--endpoint": "endpoint",
					"--source-commit": "sourceCommit",
				}[arg]
			] = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.input) throw new Error("--input is required");
	if (!options.dryRun && !options.bucket) throw new Error("--bucket is required when publishing");
	if (!options.dryRun && !options.endpoint) throw new Error("--endpoint is required when publishing");
	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function validateBundle(inputDir) {
	const modelsPath = join(inputDir, "models.json");
	const providerIndexPath = join(inputDir, "providers.json");
	const providersDir = join(inputDir, "providers");
	const modelsBytes = readFileSync(modelsPath);
	const models = JSON.parse(modelsBytes.toString("utf8"));
	const providerIds = readJson(providerIndexPath);
	const generation = readJson(join(inputDir, "generation.json"));
	if (typeof generation.generatedAt !== "string" || !Number.isFinite(Date.parse(generation.generatedAt))) {
		throw new Error("Invalid generation timestamp");
	}

	if (typeof models !== "object" || models === null || Array.isArray(models)) {
		throw new Error("models.json must contain an object");
	}
	if (!Array.isArray(providerIds) || !providerIds.every((value) => typeof value === "string")) {
		throw new Error("providers.json must contain an array of provider IDs");
	}

	const expectedProviderIds = Object.keys(models).sort();
	if (!isDeepStrictEqual(providerIds, expectedProviderIds)) {
		throw new Error("providers.json does not match the sorted providers in models.json");
	}
	for (const providerId of REQUIRED_PROVIDERS) {
		if (!Object.hasOwn(models, providerId)) throw new Error(`Required provider is missing: ${providerId}`);
	}

	let modelCount = 0;
	for (const providerId of providerIds) {
		if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(providerId)) throw new Error(`Invalid provider ID: ${providerId}`);
		const providerModels = models[providerId];
		if (typeof providerModels !== "object" || providerModels === null || Array.isArray(providerModels)) {
			throw new Error(`Provider catalog must be an object: ${providerId}`);
		}
		const providerFile = readJson(join(providersDir, `${providerId}.json`));
		if (!isDeepStrictEqual(providerFile, providerModels)) {
			throw new Error(`Provider shard does not match models.json: ${providerId}`);
		}
		modelCount += parseModelCatalog(providerId, providerModels).length;
	}

	const shardFiles = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort();
	const expectedShardFiles = providerIds.map((providerId) => `${providerId}.json`).sort();
	if (!isDeepStrictEqual(shardFiles, expectedShardFiles)) {
		throw new Error("Provider shard files do not match providers.json");
	}
	if (modelCount < MINIMUM_MODEL_COUNT) {
		throw new Error(`Refusing to publish only ${modelCount} models; expected at least ${MINIMUM_MODEL_COUNT}`);
	}

	const digest = createHash("sha256").update(modelsBytes).digest("hex");
	return {
		generatedAt: generation.generatedAt,
		sourceCommit: generation.sourceCommit,
		modelsPath,
		providerIndexPath,
		providersDir,
		providerIds,
		providerCount: providerIds.length,
		modelCount,
		revision: `sha256-${digest}`,
	};
}

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to determine source commit: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

// Use S3 conditional puts, never copy/overwrite immutable revision objects.
export function createS3Store(bucket, endpoint, temporaryDir) {
	let sequence = 0;
	function command(args, { missing = false, conflict = false } = {}) {
		const result = spawnSync("aws", ["s3api", ...args, "--bucket", bucket, "--endpoint-url", endpoint, "--output", "json"], {
			encoding: "utf8",
			env: { ...process.env, AWS_DEFAULT_REGION: "auto", AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "" },
		});
		if (result.error) throw result.error;
		if (result.status === 0) return JSON.parse(result.stdout || "{}");
		const message = `${result.stdout}\n${result.stderr}`;
		if (missing && /(?:NoSuchKey|\(404\)|Not Found)/i.test(message)) return null;
		if (conflict && /(?:PreconditionFailed|ConditionalRequestConflict|\(412\)|\(409\))/i.test(message)) return false;
		throw new Error(`R2 ${args[0]} failed: ${message.trim()}`);
	}
	return {
		get(key) {
			const path = join(temporaryDir, `get-${sequence++}`);
			const metadata = command(["get-object", "--key", key, path], { missing: true });
			if (!metadata) return null;
			if (!metadata.ETag) throw new Error(`Missing ETag for ${key}`);
			return { bytes: readFileSync(path), etag: metadata.ETag };
		},
		put(key, bytes, etag) {
			const path = join(temporaryDir, `put-${sequence++}`);
			writeFileSync(path, bytes);
			return command([
				"put-object", "--key", key, "--body", path,
				"--content-type", JSON_CONTENT_TYPE,
				"--cache-control", key === CATALOG_INDEX_KEY ? INDEX_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
				...(etag ? ["--if-match", etag] : ["--if-none-match", "*"]),
			], { conflict: true }) !== false;
		},
	};
}

function validateIndex(index) {
	if (
		typeof index !== "object" ||
		index === null ||
		Array.isArray(index) ||
		index.schemaVersion !== CATALOG_SCHEMA_VERSION
	) {
		throw new Error(`Existing ${CATALOG_INDEX_KEY} has an unsupported schema`);
	}
	if (!Array.isArray(index.catalogs)) throw new Error(`Existing ${CATALOG_INDEX_KEY} has no catalogs array`);
	for (const catalog of index.catalogs) {
		if (
			typeof catalog !== "object" ||
			catalog === null ||
			Array.isArray(catalog) ||
			!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(catalog.minimumDiffexVersion) ||
			!/^sha256-[a-f0-9]{64}$/.test(catalog.revision)
		) {
			throw new Error(`Existing ${CATALOG_INDEX_KEY} contains an invalid catalog entry`);
		}
	}
	if (!index.catalogs.some((catalog) => catalog.revision === index.defaultRevision) ||
		new Set(index.catalogs.map((catalog) => catalog.minimumDiffexVersion)).size !== index.catalogs.length) {
		throw new Error("Invalid default revision or duplicate compatibility floors");
	}
	return index;
}

function compareDiffexVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
		if (difference !== 0) return difference;
	}
	return left.localeCompare(right);
}

function buildIndex(existingIndex, publication) {
	const entry = {
		minimumDiffexVersion: MINIMUM_DIFFEX_VERSION,
		revision: publication.revision,
		sourceCommit: publication.sourceCommit,
		generatedAt: publication.generatedAt,
		providerCount: publication.providerCount,
		modelCount: publication.modelCount,
	};
	const catalogs = (existingIndex?.catalogs || [])
		.filter((catalog) => catalog.minimumDiffexVersion !== MINIMUM_DIFFEX_VERSION)
		.concat(entry)
		.sort((left, right) => compareDiffexVersions(left.minimumDiffexVersion, right.minimumDiffexVersion));
	return {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		defaultRevision: publication.revision,
		validatedAt: new Date().toISOString(),
		catalogs,
	};
}

function jsonBytes(value) {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function assertCurrentSource(sourceCommit) {
	if (!/^[a-f0-9]{40}$/.test(sourceCommit) || gitSourceCommit() !== sourceCommit) {
		throw new Error("Publisher code and artifact source SHA differ");
	}
	const repository = process.env.GITHUB_REPOSITORY;
	if (repository !== "diffexai/diffex") throw new Error("Untrusted catalog repository");
	const result = spawnSync("gh", ["api", `repos/${repository}/commits/main`, "--jq", ".sha"], { encoding: "utf8" });
	if (result.status !== 0 || result.stdout.trim() !== sourceCommit) throw new Error("Refusing stale main revision");
}

export function publishCatalog(inputDir, store, sourceCommit, checkSource = () => {}) {
	const bundle = validateBundle(inputDir);
	if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Invalid source commit");
	if (bundle.sourceCommit !== undefined && bundle.sourceCommit !== sourceCommit) throw new Error("Artifact source SHA differs");
	checkSource(sourceCommit);
	const prefix = `${CATALOG_PREFIX}/revisions/${bundle.revision}`;
	const objects = new Map([
		[`${prefix}/models.json`, readFileSync(bundle.modelsPath)],
		[`${prefix}/providers.json`, readFileSync(bundle.providerIndexPath)],
		...bundle.providerIds.map((id) => [`${prefix}/providers/${id}.json`, readFileSync(join(bundle.providersDir, `${id}.json`))]),
	]);
	const providers = Object.fromEntries(bundle.providerIds.map((id) => {
		const key = `${prefix}/providers/${id}.json`;
		const bytes = objects.get(key);
		return [id, { key, sha256: createHash("sha256").update(bytes).digest("hex"), modelCount: Object.keys(JSON.parse(bytes)).length }];
	}));
	const publication = {
		schemaVersion: CATALOG_SCHEMA_VERSION,
		minimumDiffexVersion: MINIMUM_DIFFEX_VERSION,
		revision: bundle.revision,
		sourceCommit,
		generatedAt: bundle.generatedAt,
		providerIds: bundle.providerIds,
		providerCount: bundle.providerCount,
		modelCount: bundle.modelCount,
		providers,
	};
	const current = store.get(CATALOG_INDEX_KEY);
	const index = current ? validateIndex(JSON.parse(current.bytes)) : undefined;
	for (const [key, bytes] of objects) {
		store.put(key, bytes); // Create-only; another publisher may already own it.
		const stored = store.get(key);
		if (!stored || !stored.bytes.equals(bytes)) throw new Error(`Revision verification failed: ${key}`);
	}
	const manifestKey = `${prefix}/publication.json`;
	store.put(manifestKey, jsonBytes(publication));
	const storedManifest = store.get(manifestKey);
	if (!storedManifest) throw new Error("Missing publication manifest after upload");
	const immutable = JSON.parse(storedManifest.bytes);
	// Identical content retains the first successful generation timestamp and source.
	if (!/^[a-f0-9]{40}$/.test(immutable.sourceCommit) ||
		typeof immutable.generatedAt !== "string" || !Number.isFinite(Date.parse(immutable.generatedAt)) ||
		!isDeepStrictEqual(immutable, { ...publication, sourceCommit: immutable.sourceCommit, generatedAt: immutable.generatedAt })) {
		throw new Error("Immutable publication manifest differs");
	}
	checkSource(sourceCommit); // Recheck after uploading, immediately before the CAS.
	const next = { ...buildIndex(index, immutable), validationSourceCommit: sourceCommit };
	if (!store.put(CATALOG_INDEX_KEY, jsonBytes(next), current?.etag)) {
		throw new Error("Catalog index changed concurrently; regenerate from current main and retry");
	}
	const verified = store.get(CATALOG_INDEX_KEY);
	if (!verified || !verified.bytes.equals(jsonBytes(next))) throw new Error("Catalog index changed after publication");
	return immutable;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const inputDir = resolve(options.input);
	const bundle = validateBundle(inputDir);
	if (options.dryRun) {
		console.log(`Validated ${bundle.modelCount} models at ${bundle.generatedAt}; revision ${bundle.revision}`);
		return;
	}
	const sourceCommit = options.sourceCommit || gitSourceCommit();
	if (options.requireMain && bundle.sourceCommit !== sourceCommit) throw new Error("Artifact is not bound to publisher SHA");
	const temporaryDir = mkdtempSync(join(tmpdir(), "diffex-model-catalog-"));
	try {
		const publication = publishCatalog(inputDir, createS3Store(options.bucket, options.endpoint, temporaryDir), sourceCommit,
			options.requireMain ? assertCurrentSource : undefined);
		console.log(`Published and validated ${publication.revision}; generated ${publication.generatedAt}`);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { main(); } catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
