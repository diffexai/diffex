import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveArtifactDirectory } from "./artifact-installation.mjs";

export const MAX_HOMEBREW_BYTES = 512 * 1024 * 1024;
export const HOMEBREW_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
export const runtimePinsFile = fileURLToPath(new URL("../docs/release/node-runtime.json", import.meta.url));
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// CLI paths may live in the workspace, home, or temporary directory, but the
// caller's own parent directory is not itself a trust anchor. Validate against
// the shared artifact roots before canonicalizing, and never follow file links.
export function resolveHomebrewFile(file) {
	assert(typeof file === "string" && file.length > 0 && !/[\x00-\x1f\x7f\\]/.test(file), "Invalid Homebrew file path");
	const name = basename(file);
	assert(name !== "." && name !== ".." && /^[A-Za-z0-9_. -]+$/.test(name) && name.trim() === name, "Invalid Homebrew filename");
	const directory = dirname(resolve(file));
	for (const base of [process.cwd(), homedir(), tmpdir(), "/tmp"]) {
		const root = realpathSync(base);
		for (const anchor of [resolve(base), root]) {
			const local = relative(anchor, directory);
			if (isAbsolute(local) || local === ".." || local.startsWith("../")) continue;
			// The shared validator rejects links in every descendant component.
			// Translate canonical /private/tmp back to /tmp on macOS when needed.
			const parent = realpathSync(local === "" ? base : resolveArtifactDirectory(join(base, local)));
			const contained = relative(root, parent);
			assert(!isAbsolute(contained) && contained !== ".." && !contained.startsWith("../"), "Homebrew directory escapes its trusted root");
			const result = join(parent, name);
			assert.equal(relative(parent, result), name, "Homebrew file escapes its trusted directory");
			return result;
		}
	}
	throw new Error("Homebrew file must be inside the workspace, home, or temporary directory");
}

export function readHomebrewFile(file, limit = MAX_HOMEBREW_BYTES, { optional = false } = {}) {
	try {
		return regularHomebrewBytes(resolveHomebrewFile(file), limit);
	} catch (error) {
		if (optional && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function regularHomebrewBytes(file, limit) {
	assert(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_HOMEBREW_BYTES, "Invalid Homebrew file byte limit");
	const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(descriptor);
		assert(stat.isFile() && stat.size > 0 && stat.size <= limit, `Invalid regular retained file: ${basename(file)}`);
		const chunks = [];
		let size = 0;
		// Read at most the inspected size plus one byte: concurrent growth cannot
		// turn a bounded retained input into an unbounded allocation.
		while (size <= stat.size) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size + 1 - size));
			const count = readSync(descriptor, chunk, 0, chunk.length, null);
			if (!count) break;
			chunks.push(chunk.subarray(0, count));
			size += count;
		}
		assert.equal(size, stat.size, "Retained Homebrew file size changed while reading");
		return Buffer.concat(chunks, size);
	} finally {
		closeSync(descriptor);
	}
}

export function readRuntimePins(file = runtimePinsFile) {
	// The fixed module-owned authority remains trusted when publication fixtures
	// run from an external cwd with an isolated HOME. This exception trusts only
	// this compile-time file, never a caller-supplied parent or repository root.
	const bytes = file === runtimePinsFile ? regularHomebrewBytes(runtimePinsFile, 64 * 1024) : readHomebrewFile(file, 64 * 1024);
	return validateRuntimePins(JSON.parse(bytes.toString("utf8")));
}

export function validateRuntimePins(pins) {
	assert.equal(pins.schemaVersion, 1, "Invalid Node runtime pins schema");
	assert(typeof pins.nodeVersion === "string" && pins.nodeVersion.trim() === pins.nodeVersion, "Invalid Node version");
	assert.match(pins.nodeVersion, /^22\.\d+\.\d+$/, "Homebrew requires a patched, maintained Node 22 release");
	assert.match(pins.npmVersion, /^\d+\.\d+\.\d+$/);
	assert.match(pins.releaseKey?.fingerprint, /^[A-F0-9]{40}$/);
	for (const hash of [pins.releaseKey.sha256, pins.checksumsSha256, pins.signatureSha256, ...Object.values(pins.platforms)])
		assert.match(hash, /^[a-f0-9]{64}$/);
	assert.deepEqual(Object.keys(pins.platforms).sort(), [...HOMEBREW_PLATFORMS].sort());
	assert.equal(pins.maintenanceEnds, "2027-04-30", "Review Node 22 maintenance schedule before changing pins");
	assert(Date.now() < Date.parse(`${pins.maintenanceEnds}T00:00:00Z`), "Node 22 is no longer maintained");
	return pins;
}

export function runtimeIdentity(pins, platform, arch) {
	const target = `${platform}-${arch}`;
	assert(HOMEBREW_PLATFORMS.includes(target), "Unsupported Homebrew runtime target");
	const filename = `node-v${pins.nodeVersion}-${target}.tar.gz`;
	return {
		nodeVersion: pins.nodeVersion, npmVersion: pins.npmVersion,
		filename, sha256: pins.platforms[target],
		url: `https://nodejs.org/dist/v${pins.nodeVersion}/${filename}`,
		checksumsSha256: pins.checksumsSha256, signatureSha256: pins.signatureSha256,
		signer: pins.releaseKey.fingerprint, releaseKeySha256: pins.releaseKey.sha256,
	};
}

async function boundedFetch(url, maxBytes, fetcher) {
	const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
	assert(response.ok && response.body, `Node authority download failed: ${url} (${response.status})`);
	const length = response.headers.get("content-length");
	if (length !== null) assert(Number(length) <= maxBytes, "Node authority download exceeds byte limit");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		assert(size <= maxBytes, "Node authority download exceeds byte limit");
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

// Runtime inputs may be retained offline. Cache entries are never trusted by name:
// every byte is pinned and the official detached checksum signature is verified.
export async function verifyHomebrewRuntime({
	platform = process.platform, arch = process.arch, runtimeDirectory,
	pins = readRuntimePins(), fetcher = fetch,
}) {
	validateRuntimePins(pins);
	const identity = runtimeIdentity(pins, platform, arch);
	assert.equal(platform, process.platform, "Runtime preparation requires a native OS runner");
	assert.equal(arch, process.arch, "Runtime preparation requires a native CPU runner");
	if (runtimeDirectory !== undefined) runtimeDirectory = resolveArtifactDirectory(runtimeDirectory);
	// Only macOS/glibc Linux are supported. GPG still probes its agent socket
	// during public-key import, so keep this private keyring below sockaddr_un's
	// path limit even when the calling test/build has a deeply nested TMPDIR.
	const temporary = mkdtempSync("/tmp/diffex-node-trust-");
	try {
		const base = `https://nodejs.org/dist/v${pins.nodeVersion}`;
		const inputs = [
			["release-key.asc", `https://keys.openpgp.org/vks/v1/by-fingerprint/${pins.releaseKey.fingerprint}`, pins.releaseKey.sha256, 256 * 1024],
			["SHASUMS256.txt", `${base}/SHASUMS256.txt`, pins.checksumsSha256, 256 * 1024],
			["SHASUMS256.txt.sig", `${base}/SHASUMS256.txt.sig`, pins.signatureSha256, 256 * 1024],
			[identity.filename, identity.url, identity.sha256, MAX_HOMEBREW_BYTES],
		];
		for (const [name, url, expected, limit] of inputs) {
			const retained = runtimeDirectory === undefined ? undefined : readHomebrewFile(join(runtimeDirectory, name), limit, { optional: true });
			const bytes = retained ?? await boundedFetch(url, limit, fetcher);
			assert.equal(digest(bytes), expected, `Official Node input checksum mismatch: ${name}`);
			writeFileSync(join(temporary, name), bytes, { flag: "wx" });
		}
		const home = join(temporary, "gnupg");
		mkdirSync(home, { mode: 0o700 });
		const options = { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
		// Public-key import/signature verification needs no agent. Do not spawn a
		// persistent daemon or exceed Unix socket limits under isolated long TMPDIRs.
		const args = ["--homedir", home, "--batch", "--no-options", "--no-auto-key-retrieve", "--no-autostart"];
		execFileSync("gpg", [...args, "--import", join(temporary, "release-key.asc")], options);
		const fingerprints = execFileSync("gpg", [...args, "--with-colons", "--fingerprint"], options)
			.split("\n").filter((line) => line.startsWith("fpr:")).map((line) => line.split(":")[9]);
		assert(fingerprints.includes(pins.releaseKey.fingerprint), "Node signer fingerprint mismatch");
		const status = execFileSync("gpg", [...args, "--status-fd", "1", "--verify", join(temporary, "SHASUMS256.txt.sig"), join(temporary, "SHASUMS256.txt")], options);
		const valid = status.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
		assert(valid.length === 1 && valid[0].split(" ")[2] === pins.releaseKey.fingerprint, "Unapproved Node checksum signer");
		const lines = readFileSync(join(temporary, "SHASUMS256.txt"), "utf8").split("\n");
		const matched = lines.filter((line) => line.endsWith(`  ${identity.filename}`));
		assert.deepEqual(matched, [`${identity.sha256}  ${identity.filename}`], "Signed Node checksum differs from reviewed pin");
		return {
			identity, archive: readFileSync(join(temporary, identity.filename)),
			proof: Object.fromEntries(["release-key.asc", "SHASUMS256.txt", "SHASUMS256.txt.sig"]
				.map((name) => [name, readFileSync(join(temporary, name))])),
		};
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
