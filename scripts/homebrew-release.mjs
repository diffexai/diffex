import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOMEBREW_PLATFORMS, validateHomebrewManifest } from "./homebrew-formula.mjs";
import { readReleaseArtifacts } from "./release-artifacts.mjs";
import { assertHomebrewPublicationPolicy } from "./homebrew-policy.mjs";
import { readRuntimePins } from "./homebrew-runtime.mjs";

const repository = "diffexai/diffex";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signerFile = new URL("../docs/release/homebrew-signers.json", import.meta.url);
const policyFile = new URL("../docs/release/distribution-policy.json", import.meta.url);
const metadataNames = ["homebrew-manifest.json", "SHA256SUMS", "SHA256SUMS.sig"];

function retainedBytes(path, encoding) {
	const limit = basename(path).endsWith(".tar.gz") ? 512 * 1024 * 1024 : 64 * 1024;
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error("Invalid retained Homebrew file type or size");
	return readFileSync(path, encoding);
}

export function trustedHomebrewKeys(configuration = JSON.parse(readFileSync(signerFile, "utf8"))) {
	if (configuration.schemaVersion !== 1 || !Array.isArray(configuration.keys) || !configuration.keys.length)
		throw new Error("No reviewed Homebrew release signing keys are configured");
	const keys = configuration.keys.map((entry) => {
		const key = createPublicKey(entry.publicKey);
		if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072 ||
			entry.sha256 !== digest(key.export({ type: "spki", format: "der" })))
			throw new Error("Invalid Homebrew RSA-3072 public key or fingerprint");
		return { key, sha256: entry.sha256 };
	});
	if (new Set(keys.map((entry) => entry.sha256)).size !== keys.length) throw new Error("Duplicate release signing key");
	return keys;
}

export function homebrewChecksums(directory, manifest) {
	validateHomebrewManifest(manifest);
	const names = ["homebrew-manifest.json", ...manifest.platforms.map((entry) => entry.filename)].sort();
	return names.map((name) => `${digest(retainedBytes(join(directory, name)))}  ${name}\n`).join("");
}

export function inspectHomebrewArchive(file) {
	return JSON.parse(execFileSync("python3", [fileURLToPath(new URL("./check-homebrew-payload.py", import.meta.url)), "inspect", resolve(file)], {
		encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
	}));
}

export function collectHomebrewRelease(inputDirectory, outputDirectory, release, inspectArchive = inspectHomebrewArchive) {
	if (existsSync(outputDirectory)) throw new Error("Homebrew release already exists; reuse retained bytes instead of rebuilding");
	const records = HOMEBREW_PLATFORMS.map((platform) => {
		const filename = `diffex-${release.version}-${platform}`;
		const directory = join(inputDirectory, platform);
		const record = JSON.parse(retainedBytes(join(directory, `${filename}.json`), "utf8"));
		if (record.platform !== platform || record.version !== release.version || record.sourceCommit !== release.source.commit ||
			record.filename !== `${filename}.tar.gz`) throw new Error("Homebrew platform source/version conflicts with retained npm artifacts");
		const bytes = retainedBytes(join(directory, record.filename));
		if (bytes.length !== record.size || digest(bytes) !== record.sha256) throw new Error("Retained Homebrew archive identity mismatch");
		const inspected = inspectArchive(join(directory, record.filename));
		for (const field of ["version", "sourceCommit", "platform", "nodeVersion", "npmVersion", "inventorySha256"])
			if (inspected[field] !== record[field]) throw new Error("Inspected payload differs from retained platform record");
		return record;
	});
	const pins = readRuntimePins();
	if (records.some((record) => record.nodeVersion !== pins.nodeVersion || record.npmVersion !== pins.npmVersion))
		throw new Error("Homebrew platforms must use the committed reviewed runtime versions");
	const manifest = validateHomebrewManifest({
		schemaVersion: 1, product: "@diffexai/diffex", version: release.version, sourceCommit: release.source.commit,
		nodeVersion: records[0].nodeVersion, npmVersion: records[0].npmVersion,
		platforms: records.map(({ platform, filename, size, sha256, inventorySha256, osBaseline }) =>
			({ platform, filename, size, sha256, inventorySha256, osBaseline })),
	});
	mkdirSync(outputDirectory, { recursive: true });
	for (const record of records) copyFileSync(join(inputDirectory, record.platform, record.filename), join(outputDirectory, record.filename));
	writeFileSync(join(outputDirectory, "homebrew-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	writeFileSync(join(outputDirectory, "SHA256SUMS"), homebrewChecksums(outputDirectory, manifest), { flag: "wx" });
	return manifest;
}

export function signHomebrewRelease(directory, privateKeyPem, configuration) {
	const manifest = readHomebrewRelease(directory, { signature: false });
	const keys = trustedHomebrewKeys(configuration);
	const key = createPrivateKey(privateKeyPem);
	const publicKey = createPublicKey(key);
	const fingerprint = digest(publicKey.export({ type: "spki", format: "der" }));
	if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072 ||
		!keys.some((entry) => entry.sha256 === fingerprint)) throw new Error("Signing credential does not match a reviewed release key");
	const signature = sign("sha256", retainedBytes(join(directory, "SHA256SUMS")), key);
	const path = join(directory, "SHA256SUMS.sig");
	if (existsSync(path)) {
		if (!retainedBytes(path).equals(signature)) throw new Error("Existing retained signature conflicts with signing credential");
	} else writeFileSync(path, signature, { flag: "wx" });
	return manifest;
}

export function readHomebrewRelease(directory, { version, sourceCommit = process.env.DIFFEX_SOURCE_COMMIT, signature = true, configuration } = {}) {
	const manifest = validateHomebrewManifest(JSON.parse(retainedBytes(join(directory, "homebrew-manifest.json"), "utf8")));
	const pins = readRuntimePins();
	if (manifest.nodeVersion !== pins.nodeVersion || manifest.npmVersion !== pins.npmVersion)
		throw new Error("Homebrew release differs from the committed reviewed runtime versions");
	if ((version && version !== manifest.version) || (sourceCommit && sourceCommit !== manifest.sourceCommit))
		throw new Error("Homebrew release source/version mismatch");
	for (const entry of manifest.platforms) {
		const bytes = retainedBytes(join(directory, entry.filename));
		if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) throw new Error("Retained Homebrew archive identity mismatch");
	}
	if (retainedBytes(join(directory, "SHA256SUMS"), "utf8") !== homebrewChecksums(directory, manifest))
		throw new Error("Retained Homebrew checksum inventory mismatch");
	if (signature && !trustedHomebrewKeys(configuration).some(({ key }) =>
		verify("sha256", retainedBytes(join(directory, "SHA256SUMS")), key, retainedBytes(join(directory, "SHA256SUMS.sig")))))
		throw new Error("Homebrew release signature is not from a reviewed signer");
	const allowed = new Set([...metadataNames, ...manifest.platforms.map((entry) => entry.filename)]);
	if (readdirSync(directory).some((name) => !allowed.has(name))) throw new Error("Unexpected files in public Homebrew release directory");
	return manifest;
}

export function homebrewReleaseUrl(version, filename) {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
		(!metadataNames.includes(filename) && !HOMEBREW_PLATFORMS.some((platform) => filename === `diffex-${version}-${platform}.tar.gz`)))
		throw new Error("Invalid Homebrew release asset identity");
	return `https://github.com/${repository}/releases/download/v${version}/${filename}`;
}

/** GitHub redirects to its asset CDN. Never forward authorization or log signed CDN URLs. */
export async function downloadHomebrewAsset(url, size, request = fetch) {
	if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024) throw new Error("Invalid release download bound");
	const signal = AbortSignal.timeout(120_000);
	for (let redirects = 0; redirects <= 3; redirects++) {
		const target = new URL(url);
		if (target.protocol !== "https:" || target.username || target.password || target.port || target.hash ||
			!((redirects === 0 && target.hostname === "github.com" && target.pathname.startsWith(`/${repository}/releases/download/`)) ||
				(redirects > 0 && ["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname))))
			throw new Error("Unexpected Homebrew asset download origin");
		const response = await request(target.href, { redirect: "manual", signal, credentials: "omit", referrerPolicy: "no-referrer" });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location || redirects === 3) throw new Error("Invalid Homebrew asset redirect");
			url = new URL(location, target).href;
			continue;
		}
		if (response.status !== 200 || !response.body) throw new Error("Public Homebrew asset is unavailable");
		const declared = response.headers.get("content-length");
		if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size)) throw new Error("Public Homebrew asset size mismatch");
		let received = 0;
		const chunks = [];
		for await (const chunk of response.body) {
			received += chunk.length;
			if (received > size) throw new Error("Public Homebrew asset exceeds retained size");
			chunks.push(chunk);
		}
		if (received !== size) throw new Error("Public Homebrew asset is truncated");
		return Buffer.concat(chunks);
	}
	throw new Error("Too many release asset redirects");
}

export async function verifyPublicHomebrewRelease(directory, options = {}) {
	const manifest = readHomebrewRelease(directory, options);
	for (const filename of [...metadataNames, ...manifest.platforms.map((entry) => entry.filename)]) {
		const retained = retainedBytes(join(directory, filename));
		const bytes = await downloadHomebrewAsset(homebrewReleaseUrl(manifest.version, filename), retained.length, options.request);
		if (!bytes.equals(retained)) throw new Error(`Public Homebrew asset conflicts with retained bytes: ${filename}`);
	}
	return manifest;
}

function gh(args) {
	try {
		return execFileSync("gh", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		throw new Error("GitHub release operation failed; check repository authorization and retained asset identity");
	}
}

function githubReleases(runGh) {
	const releases = [];
	for (let page = 1; page <= 100; page++) {
		const batch = JSON.parse(runGh(["api", `repos/${repository}/releases?per_page=100&page=${page}`]));
		if (!Array.isArray(batch)) throw new Error("Incomplete GitHub release inventory");
		releases.push(...batch);
		if (batch.length < 100) return releases;
	}
	throw new Error("Incomplete GitHub release inventory");
}

export async function publishHomebrewRelease(directory, { runGh = gh, request = fetch, policy, configuration } = {}) {
	assertHomebrewPublicationPolicy(policy ?? JSON.parse(readFileSync(policyFile, "utf8")));
	const manifest = readHomebrewRelease(directory, { configuration });
	const remoteCommit = JSON.parse(runGh(["api", `repos/${repository}/commits/v${manifest.version}`]));
	if (remoteCommit.sha !== manifest.sourceCommit) throw new Error("GitHub release tag differs from the immutable approved source");
	// Query the inventory, not a guessed missing-tag error: permission failures must never create a release.
	const releases = githubReleases(runGh);
	let release = releases.find((entry) => entry.tag_name === `v${manifest.version}`);
	if (!release) {
		runGh(["release", "create", `v${manifest.version}`, "--repo", repository, "--verify-tag", "--latest=false", "--title", `Diffex ${manifest.version}`, "--notes", "Verified Homebrew application archives. Use Homebrew to install and upgrade."]);
		release = JSON.parse(runGh(["api", `repos/${repository}/releases/tags/v${manifest.version}`]));
	}
	if (release.draft || release.prerelease || release.tag_name !== `v${manifest.version}` || !Array.isArray(release.assets))
		throw new Error("Conflicting GitHub release metadata");
	const names = [...metadataNames, ...manifest.platforms.map((entry) => entry.filename)];
	if (release.assets.some((entry) => !names.includes(entry.name)) || new Set(release.assets.map((entry) => entry.name)).size !== release.assets.length)
		throw new Error("Unexpected or duplicate immutable GitHub release assets");
	// Check ALL existing public bytes before uploading even one missing asset. Never use --clobber.
	for (const entry of release.assets) {
		const expected = retainedBytes(join(directory, entry.name));
		if (entry.size !== expected.length || !(await downloadHomebrewAsset(homebrewReleaseUrl(manifest.version, entry.name), expected.length, request)).equals(expected))
			throw new Error("Existing GitHub release asset conflicts with retained bytes");
	}
	for (const name of names.filter((name) => !release.assets.some((entry) => entry.name === name)))
		runGh(["release", "upload", `v${manifest.version}`, resolve(directory, name), "--repo", repository]);
	await verifyPublicHomebrewRelease(directory, { request, configuration });
	return manifest;
}

export async function promoteHomebrewLatest(directory, { runGh = gh, request = fetch, configuration } = {}) {
	const manifest = await verifyPublicHomebrewRelease(directory, { request, configuration });
	const latest = githubReleases(runGh);
	// Serialized with announcement in CI. A later stable release must never be displaced.
	if (latest.some((entry) => {
		if (entry.draft || entry.prerelease || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry.tag_name)) return false;
		const current = entry.tag_name.slice(1).split(".").map(BigInt);
		const target = manifest.version.split(".").map(BigInt);
		const difference = current.findIndex((value, index) => value !== target[index]);
		return difference >= 0 && current[difference] > target[difference];
	})) return false;
	runGh(["release", "edit", `v${manifest.version}`, "--repo", repository, "--latest"]);
	return true;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, directory, other] = process.argv.slice(2);
	if (!directory) throw new Error("Usage: homebrew-release.mjs <collect|sign|verify|publish|verify-public|promote> DIRECTORY [OUTPUT]");
	if (command === "collect") collectHomebrewRelease(directory, other, readReleaseArtifacts(".artifacts/release"));
	else if (command === "sign") {
		assertHomebrewPublicationPolicy(JSON.parse(readFileSync(policyFile, "utf8")));
		signHomebrewRelease(directory, process.env.HOMEBREW_SIGNING_KEY);
	}
	else if (command === "verify") readHomebrewRelease(directory);
	else if (command === "publish") await publishHomebrewRelease(directory);
	else if (command === "verify-public") await verifyPublicHomebrewRelease(directory);
	else if (command === "promote") await promoteHomebrewLatest(directory);
	else throw new Error("Unknown Homebrew release command");
}
