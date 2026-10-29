import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readHomebrewFile, resolveHomebrewFile } from "./homebrew-runtime.mjs";

export const HOMEBREW_PLATFORMS = Object.freeze(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
export const HOMEBREW_MAX_ASSET_SIZE = 512 * 1024 * 1024;
export const HOMEBREW_ASSET_REPOSITORY = "https://github.com/diffexai/diffex/releases/download";
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256 = /^[a-f0-9]{64}$/;

function exactKeys(value, keys) {
	assert(value && typeof value === "object" && !Array.isArray(value), "Expected a manifest object");
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "Unexpected manifest fields");
}

export function validateHomebrewManifest(manifest) {
	exactKeys(manifest, [
		"schemaVersion", "product", "version", "sourceCommit", "nodeVersion", "npmVersion", "platforms",
	]);
	assert.equal(manifest.schemaVersion, 1, "Unsupported Homebrew manifest schema");
	assert.equal(manifest.product, "@diffexai/diffex", "Unexpected Homebrew product");
	for (const field of ["version", "nodeVersion", "npmVersion"])
		assert(typeof manifest[field] === "string" && manifest[field].trim() === manifest[field] && stable.test(manifest[field]), `Invalid ${field}`);
	assert(typeof manifest.sourceCommit === "string" && manifest.sourceCommit.length === 40 && /^[a-f0-9]{40}$/.test(manifest.sourceCommit), "Invalid sourceCommit");
	assert(Array.isArray(manifest.platforms) && manifest.platforms.length === 4, "Exactly four platforms are required");
	assert.deepEqual(manifest.platforms.map((entry) => entry?.platform).sort(), [...HOMEBREW_PLATFORMS].sort());
	for (const entry of manifest.platforms) {
		exactKeys(entry, ["platform", "filename", "size", "sha256", "inventorySha256", "osBaseline"]);
		assert.equal(entry.filename, `diffex-${manifest.version}-${entry.platform}.tar.gz`, "Noncanonical asset filename");
		assert(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= HOMEBREW_MAX_ASSET_SIZE, "Invalid asset size");
		for (const field of ["sha256", "inventorySha256"])
			assert(typeof entry[field] === "string" && entry[field].length === 64 && sha256.test(entry[field]), `Invalid ${field}`);
		assert.equal(entry.osBaseline, entry.platform.startsWith("darwin-") ? "macos-15" : "ubuntu-24.04", "Unsupported OS baseline");
	}
	return manifest;
}

export function homebrewAssetUrl(manifest, platform) {
	validateHomebrewManifest(manifest);
	const entry = manifest.platforms.find((entry) => entry.platform === platform);
	assert(entry, "Unsupported Homebrew platform");
	return `${HOMEBREW_ASSET_REPOSITORY}/v${manifest.version}/${entry.filename}`;
}

export function generateHomebrewFormula(manifest) {
	validateHomebrewManifest(manifest);
	let formula = readFileSync(new URL("../homebrew/diffex.rb.template", import.meta.url), "utf8");
	const substitutions = { VERSION: manifest.version };
	for (const entry of manifest.platforms) {
		const target = entry.platform.toUpperCase().replaceAll("-", "_");
		substitutions[`${target}_URL`] = homebrewAssetUrl(manifest, entry.platform);
		substitutions[`${target}_SHA256`] = entry.sha256;
	}
	formula = formula.replace(/@@([A-Z0-9_]+)@@/g, (_, key) => {
		assert(Object.hasOwn(substitutions, key), `Unknown formula template field: ${key}`);
		return substitutions[key];
	});
	assert(!formula.includes("@@"), "Unexpanded formula template field");
	return formula;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [manifest, output, ...extra] = process.argv.slice(2);
	assert(manifest && output && !extra.length, "Usage: node scripts/homebrew-formula.mjs MANIFEST OUTPUT");
	const formula = generateHomebrewFormula(JSON.parse(readHomebrewFile(manifest, 64 * 1024).toString("utf8")));
	const descriptor = openSync(resolveHomebrewFile(output), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
	try {
		assert(fstatSync(descriptor).isFile(), "Formula output must be a regular file");
		// Keep intentional regeneration of existing formula files, but only after
		// validating the opened descriptor, never by following a caller's symlink.
		ftruncateSync(descriptor, 0);
		writeFileSync(descriptor, formula);
	} finally {
		closeSync(descriptor);
	}
}
