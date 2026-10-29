import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { distributionDocs } from "./cli-distribution.mjs";
import { HOMEBREW_LAUNCHER, homebrewArchiveFilename, homebrewArchiveUrl, inspectHomebrewArchive, prepareHomebrewArchive, substituteHomebrewInstallLock, validateHomebrewSource } from "./homebrew-archive.mjs";
import { digest, HOMEBREW_PLATFORMS, MAX_HOMEBREW_BYTES, readRuntimePins, runtimeIdentity, verifyHomebrewRuntime } from "./homebrew-runtime.mjs";
import { integrity } from "./release-registry.mjs";
import { createDistributionManifest } from "./release-distribution-manifest.mjs";

const checker = resolve("scripts/check-homebrew-payload.py");
const version = "1.2.3";
const sourceCommit = "a".repeat(40);
const target = `${process.platform}-${process.arch}`;
let directory;
let runtimeDirectory;
let pins;
let manifest;
let archive;
let record;
let installer;
let lock;

function put(path, bytes, mode) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes, mode === undefined ? {} : { mode });
}

function tar(root, name, file) {
	execFileSync("tar", ["-czf", file, "-C", root, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

function py(...args) {
	return execFileSync("python3", [checker, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

before(async () => {
	// Keep the GPG agent socket below the POSIX sockaddr_un path limit on macOS.
	directory = mkdtempSync("/tmp/diffex-brew-test-");
	runtimeDirectory = join(directory, "runtime-inputs");
	mkdirSync(runtimeDirectory);
	// Real cryptographic verification, local fixture authority; no provider/network APIs.
	const home = join(directory, "gnupg");
	mkdirSync(home, { mode: 0o700 });
	const gpg = ["--homedir", home, "--batch", "--no-options", "--pinentry-mode", "loopback", "--passphrase", ""];
	execFileSync("gpg", [...gpg, "--quick-generate-key", "Homebrew fixture <fixture@example.invalid>", "ed25519", "sign", "0"], { stdio: "pipe" });
	const fingerprint = execFileSync("gpg", [...gpg, "--with-colons", "--list-keys"], { encoding: "utf8" }).split("\n").find((line) => line.startsWith("fpr:")).split(":")[9];
	writeFileSync(join(runtimeDirectory, "release-key.asc"), execFileSync("gpg", [...gpg, "--armor", "--export", fingerprint]));
	const nodeVersion = "22.23.4";
	const npmVersion = "10.9.9";
	const nodeRoot = `node-v${nodeVersion}-${target}`;
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const npmBin = execFileSync("which", [npmCommand], { encoding: "utf8" }).trim();
	const npmReal = execFileSync("python3", ["-c", "import os,sys; print(os.path.realpath(sys.argv[1]))", npmBin], { encoding: "utf8" }).trim();
	// Small fake runtime fixtures exercise packaging; they do not claim live Node validation.
	put(join(directory, nodeRoot, "bin/node"), `#!/bin/sh\nif [ "$1" = --version ]; then echo v${nodeVersion}; exit; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`, 0o755);
	put(join(directory, nodeRoot, "LICENSE"), "Node fixture license\n");
	put(join(directory, nodeRoot, "lib/node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: npmVersion }));
	put(join(directory, nodeRoot, "lib/node_modules/npm/LICENSE"), "npm fixture license\n");
	put(join(directory, nodeRoot, "lib/node_modules/npm/.npmrc"), "");
	put(join(directory, nodeRoot, "lib/node_modules/npm/bin/npm-cli.js"), `if (process.argv[2] === '--version') console.log('${npmVersion}'); else require(${JSON.stringify(npmReal)});\n`);
	put(join(directory, nodeRoot, "lib/node_modules/npm/src/upstream.c"), "/* third-party source retained */\n");
	symlinkSync("npm-cli.js", join(directory, nodeRoot, "lib/node_modules/npm/bin/npm-link"));
	const runtimeArchive = join(runtimeDirectory, `${nodeRoot}.tar.gz`);
	tar(directory, nodeRoot, runtimeArchive);
	const runtimeHash = digest(readFileSync(runtimeArchive));
	writeFileSync(join(runtimeDirectory, "SHASUMS256.txt"), `${runtimeHash}  ${nodeRoot}.tar.gz\n`);
	execFileSync("gpg", [...gpg, "--detach-sign", "--output", join(runtimeDirectory, "SHASUMS256.txt.sig"), join(runtimeDirectory, "SHASUMS256.txt")], { stdio: "pipe" });
	pins = {
		schemaVersion: 1, nodeVersion, npmVersion, maintenanceEnds: "2027-04-30",
		releaseKey: { fingerprint, sha256: digest(readFileSync(join(runtimeDirectory, "release-key.asc"))) },
		checksumsSha256: digest(readFileSync(join(runtimeDirectory, "SHASUMS256.txt"))),
		signatureSha256: digest(readFileSync(join(runtimeDirectory, "SHASUMS256.txt.sig"))),
		platforms: Object.fromEntries(HOMEBREW_PLATFORMS.map((platform) => [platform, runtimeHash])),
	};
	installer = { name: "@diffexai/diffex-coding-agent-install", version, private: true, dependencies: { "@diffexai/diffex": version } };
	lock = { name: installer.name, version, lockfileVersion: 3, requires: true, packages: {
		"": { name: installer.name, version, dependencies: installer.dependencies },
		"node_modules/@diffexai/diffex": { version, resolved: `https://registry.npmjs.org/@diffexai/diffex/-/diffex-${version}.tgz`, hasInstallScript: true },
	} };
	const files = {
		...Object.fromEntries(distributionDocs.map((path) => [path, "Reviewed user documentation"])),
		"README.md": "Diffex fixture", LICENSE: readFileSync("LICENSE"),
		"THIRD-PARTY-NOTICES.txt": "Fixture legal notices\n",
		"distribution-components.json": JSON.stringify([{ name: "@diffexai/diffex", license: "MIT" }]),
		"package.json": JSON.stringify({ name: "@diffexai/diffex", version, license: "MIT", bin: { diffex: "dist/cli.js" },
			scripts: { postinstall: 'node -e "require(\"fs\").writeFileSync(\"lifecycle-ran\", \"bad\")"' } }),
		"dist/cli.js": 'console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}));\n',
		"dist/AGENTS.md": readFileSync("AGENTS_release.md"),
		"release/install-package.json": JSON.stringify(installer),
		"release/install-package-lock.json": JSON.stringify(lock),
		"release/distribution-manifest.json": JSON.stringify(createDistributionManifest({ packages: [{ name: "@diffexai/diffex", version }], sourceCommit,
			policy: { status: "approved", publicHosting: "npmjs", channels: { npmjs: "enable", standalone: "defer" } } })),
	};
	files["distribution-files.json"] = JSON.stringify({ sourceCommit, algorithm: "sha256", files: Object.entries(files)
		.filter(([path]) => path.startsWith("dist/")).map(([path, bytes]) => ({ path, sha256: digest(bytes) })) });
	const releaseDirectory = join(directory, "release");
	mkdirSync(releaseDirectory);
	for (const [path, bytes] of Object.entries(files)) put(join(directory, "package", path), bytes);
	const filename = `diffexai-diffex-${version}.tgz`;
	tar(directory, "package", join(releaseDirectory, filename));
	const bytes = readFileSync(join(releaseDirectory, filename));
	manifest = { schemaVersion: 1, version, source: { repository: "diffexai/diffex", commit: sourceCommit },
		packages: [{ name: "@diffexai/diffex", version, filename, size: bytes.length, sha256: digest(bytes), integrity: integrity(bytes) }] };
	record = await prepareHomebrewArchive({ releaseDirectory, outputDirectory: join(directory, "output"), manifest, runtimeDirectory, runtimePins: pins,
		fetcher: () => { throw new Error("Network forbidden in fixture tests"); } });
	archive = join(directory, "output", record.filename);
});

after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

test("reviewed runtime pins cover four exact Node 22 official archive digests", () => {
	const actual = readRuntimePins();
	assert.equal(actual.nodeVersion, "22.23.4");
	assert.equal(actual.npmVersion, "10.9.9");
	for (const platform of HOMEBREW_PLATFORMS) {
		const [os, arch] = platform.split("-");
		assert.equal(runtimeIdentity(actual, os, arch).url, `https://nodejs.org/dist/v${actual.nodeVersion}/node-v${actual.nodeVersion}-${platform}.tar.gz`);
	}
});

test("prepares/inspects a native self-contained archive with an exact tap record", () => {
	assert.deepEqual(Object.keys(record).sort(), ["platform", "filename", "size", "sha256", "inventorySha256", "osBaseline", "version", "sourceCommit", "nodeVersion", "npmVersion"].sort());
	assert.equal(record.platform, target);
	assert.equal(record.sha256, digest(readFileSync(archive)));
	assert.equal(statSync(archive).mode & 0o777, 0o600, "new retained archive must be private");
	assert.equal(statSync(archive.replace(/\.tar\.gz$/, ".json")).mode & 0o777, 0o600, "new retained record must be private");
	assert.equal(inspectHomebrewArchive(archive, { record }).inventorySha256, record.inventorySha256);
	assert.equal(homebrewArchiveUrl(version, target), `https://github.com/diffexai/diffex/releases/download/v${version}/${record.filename}`);
	const output = join(directory, "extracted with spaces");
	py("extract", archive, output);
	assert(!existsSync(join(output, "diffex/app/node_modules/@diffexai/diffex/lifecycle-ran")), "lifecycle script must not run");
	assert(existsSync(join(output, "diffex/runtime/lib/node_modules/npm/src/upstream.c")), "third-party source retained");
	const installedLock = JSON.parse(readFileSync(join(output, "diffex/app/package-lock.json"), "utf8"));
	assert.equal(installedLock.packages["node_modules/@diffexai/diffex"].resolved, lock.packages["node_modules/@diffexai/diffex"].resolved);
	assert(!readFileSync(join(output, "diffex/app/package-lock.json"), "utf8").includes(directory));
	assert(!existsSync(join(output, "diffex/runtime/lib/node_modules/npm/.npmrc")));
	assert.equal(digest(readFileSync(join(output, "diffex/runtime/SHASUMS256.txt.sig"))), pins.signatureSha256);
});

test("physical relocatable launcher preserves spaces, arguments, cwd, and symlink chains", () => {
	const root = join(directory, "extracted with spaces", "diffex");
	const moved = join(directory, "relocated tree with spaces");
	cpSync(root, moved, { recursive: true, verbatimSymlinks: true });
	const links = join(directory, "links with spaces");
	mkdirSync(links);
	symlinkSync(join(moved, "bin/diffex"), join(links, "second"));
	symlinkSync("second", join(links, "diffex"));
	const result = JSON.parse(execFileSync(join(links, "diffex"), ["one two", "--value", "quote'\""], { encoding: "utf8", cwd: directory }));
	assert.deepEqual(result, { args: ["one two", "--value", "quote'\""], cwd: realpathSync(directory) });
	assert.equal(readFileSync(join(moved, "bin/diffex"), "utf8"), HOMEBREW_LAUNCHER);
});

test("lock substitution changes only the retained CLI resolved/integrity fields", () => {
	const original = structuredClone(lock);
	const result = substituteHomebrewInstallLock({ installer, lock, version, tarball: join(directory, "reviewed.tgz"), tarballIntegrity: manifest.packages[0].integrity });
	const expected = structuredClone(original);
	expected.packages["node_modules/@diffexai/diffex"].resolved = `file:${join(directory, "reviewed.tgz")}`;
	expected.packages["node_modules/@diffexai/diffex"].integrity = manifest.packages[0].integrity;
	assert.deepEqual(result, expected);
	assert.deepEqual(lock, original);
	assert.throws(() => substituteHomebrewInstallLock({ installer: { ...installer, version: "9.9.9" }, lock, version, tarball: "x", tarballIntegrity: manifest.packages[0].integrity }));
});

test("retained archive hash/size/inventory/source disagreements are rejected", () => {
	for (const update of [{ size: record.size + 1 }, { sha256: "0".repeat(64) }, { inventorySha256: "0".repeat(64) }, { sourceCommit: "b".repeat(40) }, { npmVersion: "0.0.0" }])
		assert.throws(() => inspectHomebrewArchive(archive, { record: { ...record, ...update } }));
});

test("archive preparation refuses cross compilation, mutated retained inputs, and rebuilding", async () => {
	const options = { releaseDirectory: join(directory, "release"), outputDirectory: join(directory, "output"), manifest, runtimeDirectory, runtimePins: pins };
	await assert.rejects(prepareHomebrewArchive({ ...options, arch: process.arch === "arm64" ? "x64" : "arm64" }), /native CPU/);
	await assert.rejects(prepareHomebrewArchive(options), /already exist/);
	await assert.rejects(prepareHomebrewArchive({ ...options, outputDirectory: join(directory, "bad-source"), manifest: { ...manifest, packages: [{ ...manifest.packages[0], sha256: "0".repeat(64) }] } }), /checksum mismatch/);
});

test("retained archive/source reads reject linked files and untrusted directories", () => {
	const linked = join(directory, "linked-archive.tar.gz");
	symlinkSync(archive, linked);
	assert.throws(() => inspectHomebrewArchive(linked), { code: "ELOOP" });
	assert.throws(() => inspectHomebrewArchive("/etc/passwd"), /must be inside/);
	const release = join(directory, "linked-release-input");
	mkdirSync(release);
	symlinkSync(join(directory, "release", manifest.packages[0].filename), join(release, manifest.packages[0].filename));
	assert.throws(() => validateHomebrewSource(release, manifest), { code: "ELOOP" });
	for (const candidate of ["1.2.3\n", "../1.2.3", "1.2.3/../../other"])
		assert.throws(() => homebrewArchiveFilename(candidate, target));
});

test("archive output reservations refuse collisions without following links or damaging retained bytes", async () => {
	const options = { releaseDirectory: join(directory, "release"), manifest, runtimeDirectory, runtimePins: pins,
		fetcher: () => { throw new Error("Network forbidden"); } };
	const filename = homebrewArchiveFilename(version, target);
	const recordName = filename.replace(/\.tar\.gz$/, ".json");
	const sentinel = join(directory, "retained-sentinel");
	writeFileSync(sentinel, "must remain unchanged");
	for (const collision of [filename, recordName]) {
		const outputDirectory = join(directory, `collision-${collision}`);
		mkdirSync(outputDirectory);
		symlinkSync(sentinel, join(outputDirectory, collision));
		await assert.rejects(prepareHomebrewArchive({ ...options, outputDirectory }), { code: "EEXIST" });
		assert.equal(readFileSync(sentinel, "utf8"), "must remain unchanged");
		assert.equal(readFileSync(join(outputDirectory, collision), "utf8"), "must remain unchanged");
		assert(!existsSync(join(outputDirectory, collision === filename ? recordName : filename)), "remove only this invocation's incomplete reservation");
	}
	const failed = join(directory, "failed-reservations");
	await assert.rejects(prepareHomebrewArchive({ ...options, outputDirectory: failed,
		manifest: { ...manifest, packages: [{ ...manifest.packages[0], sha256: "0".repeat(64) }] } }), /checksum mismatch/);
	assert(!existsSync(join(failed, filename)));
	assert(!existsSync(join(failed, recordName)));
});

test("offline runtime cache refuses final and parent symlinks instead of fetching around them", async () => {
	const cache = join(directory, "linked-runtime");
	cpSync(runtimeDirectory, cache, { recursive: true });
	const input = join(cache, "release-key.asc");
	rmSync(input);
	symlinkSync(join(runtimeDirectory, "release-key.asc"), input);
	const options = { pins, fetcher: () => assert.fail("Invalid retained input must not fall back to network") };
	await assert.rejects(verifyHomebrewRuntime({ ...options, runtimeDirectory: cache }), { code: "ELOOP" });
	const parent = join(directory, "linked-runtime-parent");
	symlinkSync(runtimeDirectory, parent);
	await assert.rejects(verifyHomebrewRuntime({ ...options, runtimeDirectory: parent }), /symlink/);
});

test("a missing offline runtime input still uses the bounded pinned fetch path", async () => {
	const cache = join(directory, "partial-runtime");
	cpSync(runtimeDirectory, cache, { recursive: true });
	rmSync(join(cache, "release-key.asc"));
	const requested = [];
	const runtime = await verifyHomebrewRuntime({ runtimeDirectory: cache, pins, fetcher: async (url) => {
		requested.push(url);
		return new Response(readFileSync(join(runtimeDirectory, "release-key.asc")));
	} });
	assert.equal(runtime.identity.sha256, pins.platforms[target]);
	assert.deepEqual(requested, [`https://keys.openpgp.org/vks/v1/by-fingerprint/${pins.releaseKey.fingerprint}`]);
});

test("offline runtime verification rejects corrupt signed inputs and an unauthorized signer", async () => {
	const options = { runtimeDirectory, pins, fetcher: () => { throw new Error("Network forbidden"); } };
	assert.equal((await verifyHomebrewRuntime(options)).identity.sha256, pins.platforms[target]);
	await assert.rejects(verifyHomebrewRuntime({ ...options, pins: { ...pins, signatureSha256: "0".repeat(64) } }), /checksum mismatch/);
	await assert.rejects(verifyHomebrewRuntime({ ...options, pins: { ...pins, releaseKey: { ...pins.releaseKey, fingerprint: "A".repeat(40) } } }), /fingerprint mismatch/);
	const corrupted = join(directory, "corrupt-runtime");
	cpSync(runtimeDirectory, corrupted, { recursive: true });
	writeFileSync(join(corrupted, "SHASUMS256.txt"), "forged checksums\n");
	const changed = { ...pins, checksumsSha256: digest(readFileSync(join(corrupted, "SHASUMS256.txt"))) };
	await assert.rejects(verifyHomebrewRuntime({ ...options, runtimeDirectory: corrupted, pins: changed }), /Command failed/);
});

test("public runtime verification uses a private short GPG keyring under long isolated TMPDIRs", async () => {
	const original = process.env.TMPDIR;
	const long = join(directory, "isolated-home-and-temporary-directory-".repeat(5));
	mkdirSync(long);
	process.env.TMPDIR = long;
	try {
		const result = await verifyHomebrewRuntime({ runtimeDirectory, pins,
			fetcher: () => { throw new Error("Network forbidden"); } });
		assert.equal(result.identity.sha256, pins.platforms[target]);
	} finally {
		if (original === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = original;
	}
});

test("bounded runtime fetch rejects oversized authority responses before buffering", async () => {
	await assert.rejects(verifyHomebrewRuntime({ pins, fetcher: async () => new Response("x", { headers: { "content-length": String(MAX_HOMEBREW_BYTES + 1) } }) }), /byte limit/);
});

for (const [path, content, reason] of [
	["app/node_modules/@diffexai/diffex/dist/private.ts", "export const hidden = 1;", /prohibited source file/],
	["app/node_modules/@diffexai/diffex/dist/extra.js", "export const hidden = 1;", /inventory mismatch/],
	["runtime/lib/node_modules/npm/auth.json", '{"token":"fixture"}', /credential\/config/],
	["runtime/lib/node_modules/npm/.npmrc", "token=fixture", /credential\/config/],
	["runtime/lib/node_modules/npm/.env", "KEY=fixture", /credential\/config/],
	["runtime/lib/node_modules/npm/.cache/file", "cache", /credential\/config/],
	["runtime/lib/node_modules/npm/.github/workflows/private.yml", "fixture", /development record/],
	["runtime/lib/node_modules/npm/AGENTS.md", "private instructions", /repository instructions/],
	["app/unattributed.js", "private code", /unattributed application file/],
	["app/node_modules/@diffexai/diffex/node_modules/rogue/index.js", "private code", /unattributed application file/],
	["app/node_modules/foreign/package.json", '{"name":"foreign","version":"1.0.0"}', /absent from reviewed lock/],
	["app/node_modules/@diffexai/diffex/package.json", '{"name":"@diffexai/diffex","version":"9.9.9"}', /installed package identity/],
	["app/package-lock.json", '{"lockfileVersion":3,"packages":{}}', /differs from retained/],
]) test(`payload gate rejects ${path}`, () => {
	const root = join(directory, `bad-${digest(path).slice(0, 12)}`);
	cpSync(join(directory, "extracted with spaces/diffex"), root, { recursive: true, verbatimSymlinks: true });
	put(join(root, path), content);
	const result = spawnSync("python3", [checker, "prepare", root, `${root}.tar.gz`], { encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, reason);
});

test("safe inspection rejects traversal, duplicate paths, hardlinks, escaping links, and member-under-link before extraction", () => {
	// Python's writer is used only to construct deliberately invalid small archives.
	const script = join(directory, "unsafe-fixture.py");
	put(script, `import io, sys, tarfile\nwith tarfile.open(sys.argv[1], 'w:gz') as t:\n for name, kind, target in __import__('json').loads(sys.argv[2]):\n  i=tarfile.TarInfo(name)\n  if kind == 'link': i.type=tarfile.SYMTYPE; i.linkname=target\n  elif kind == 'hard': i.type=tarfile.LNKTYPE; i.linkname=target\n  else: i.size=1\n  t.addfile(i, io.BytesIO(b'x') if kind == 'file' else None)\n`);
	for (const members of [
		[["diffex/../escape", "file", ""]], [["/absolute", "file", ""]],
		[["diffex/file", "file", ""], ["diffex/file", "file", ""]],
		[["diffex/FILE", "file", ""], ["diffex/file", "file", ""]],
		[["diffex/link", "hard", "diffex/file"]], [["diffex/link", "link", "../../escape"]],
		[["diffex/link", "link", "/absolute"]], [["diffex/link", "link", "link"]],
		[["diffex/link", "link", "target"], ["diffex/link/member", "file", ""]],
	]) {
		const file = join(directory, "unsafe.tar.gz");
		execFileSync("python3", [script, file, JSON.stringify(members)]);
		const destination = join(directory, "must-not-be-extracted");
		const result = spawnSync("python3", [checker, "extract", file, destination], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert(!existsSync(destination), "must validate before writing extraction destination");
	}
});

test("deterministic archive output ignores filesystem traversal order, timestamps, and umask", () => {
	const root = join(directory, "extracted with spaces/diffex");
	const first = join(directory, "deterministic-first.tar.gz");
	const second = join(directory, "deterministic-second.tar.gz");
	py("prepare", root, first);
	chmodSync(join(root, "LICENSE"), 0o600);
	py("prepare", root, second);
	assert.deepEqual(readFileSync(first), readFileSync(second));
});
