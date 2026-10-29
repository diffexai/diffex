import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isolatedEnvironment, resolveArtifactDirectory } from "./artifact-installation.mjs";
import { digest, HOMEBREW_PLATFORMS, MAX_HOMEBREW_BYTES, readRuntimePins, verifyHomebrewRuntime } from "./homebrew-runtime.mjs";
import { integrity } from "./release-registry.mjs";

const checker = fileURLToPath(new URL("./check-homebrew-payload.py", import.meta.url));
const strictChecker = fileURLToPath(new URL("./check-distribution-payload.py", import.meta.url));
const license = fileURLToPath(new URL("../LICENSE", import.meta.url));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
	? Object.fromEntries(Object.entries(item).sort(([a], [b]) => ordered(a, b))) : item);

export const HOMEBREW_LAUNCHER = `#!/bin/sh
set -eu
# Resolve the physical launcher, including a Homebrew opt/bin symlink chain.
launcher=$0
case "$launcher" in /*) ;; *) launcher=$PWD/$launcher ;; esac
links=0
while [ -L "$launcher" ]; do
  links=$((links + 1))
  [ "$links" -le 128 ] || { echo 'diffex: launcher symlink loop' >&2; exit 1; }
  directory=$(CDPATH= cd -P -- "$(dirname -- "$launcher")" && pwd)
  target=$(readlink -- "$launcher")
  case "$target" in /*) launcher=$target ;; *) launcher=$directory/$target ;; esac
done
root=$(CDPATH= cd -P -- "$(dirname -- "$launcher")/.." && pwd)
exec "$root/runtime/bin/node" "$root/app/node_modules/@diffexai/diffex/dist/cli.js" "$@"
`;

function python(args) {
	return JSON.parse(execFileSync("python3", [checker, ...args, "--license", license], {
		encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 600_000,
	}));
}

export function homebrewArchiveFilename(version, platform) {
	assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
	assert(HOMEBREW_PLATFORMS.includes(platform), "Unsupported Homebrew archive platform");
	return `diffex-${version}-${platform}.tar.gz`;
}

export function homebrewArchiveUrl(version, platform) {
	return `https://github.com/diffexai/diffex/releases/download/v${version}/${homebrewArchiveFilename(version, platform)}`;
}

function regularBytes(file, limit = MAX_HOMEBREW_BYTES) {
	const stat = lstatSync(file);
	assert(stat.isFile() && stat.size > 0 && stat.size <= limit, `Invalid regular retained file: ${basename(file)}`);
	return readFileSync(file);
}

// The caller supplies readReleaseArtifacts(...)'s retained manifest. Keeping this
// module independent of release-artifacts prevents a release/packaging import cycle.
export function validateHomebrewSource(releaseDirectory, manifest) {
	assert.equal(manifest?.schemaVersion, 1, "A verified retained release manifest is required");
	homebrewArchiveFilename(manifest.version, `${process.platform}-${process.arch}`);
	assert.equal(manifest.source?.repository, "diffexai/diffex");
	assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
	assert(Array.isArray(manifest.packages) && manifest.packages.length === 1, "Expected the retained CLI-only release inventory");
	const artifact = manifest.packages[0];
	assert.equal(artifact.name, "@diffexai/diffex");
	assert.equal(artifact.version, manifest.version);
	assert.equal(artifact.filename, `diffexai-diffex-${manifest.version}.tgz`);
	const bytes = regularBytes(join(releaseDirectory, artifact.filename));
	assert.equal(bytes.length, artifact.size, "Retained CLI tarball size mismatch");
	assert.equal(digest(bytes), artifact.sha256, "Retained CLI tarball checksum mismatch");
	assert.equal(integrity(bytes), artifact.integrity, "Retained CLI tarball integrity mismatch");
	python(["validate", join(releaseDirectory, artifact.filename), "--root", "package"]);
	const inspected = JSON.parse(execFileSync("python3", [strictChecker, join(releaseDirectory, artifact.filename),
		"--license", license, "--name", artifact.name, "--version", manifest.version], {
		encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
	}));
	return { artifact, payloadIdentity: digest(Buffer.from(canonical(inspected.payloadFiles))) };
}

export function substituteHomebrewInstallLock({ installer, lock, version, tarball, tarballIntegrity }) {
	assert.equal(installer.name, "@diffexai/diffex-coding-agent-install");
	assert.equal(installer.version, version);
	assert.equal(installer.private, true);
	assert.deepEqual(installer.dependencies, { "@diffexai/diffex": version });
	assert.equal(lock.lockfileVersion, 3);
	assert.equal(lock.name, installer.name);
	assert.equal(lock.version, version);
	assert.deepEqual(lock.packages?.[""]?.dependencies, installer.dependencies);
	const cli = lock.packages["node_modules/@diffexai/diffex"];
	assert.equal(cli?.version, version);
	assert.equal(cli.resolved, `https://registry.npmjs.org/@diffexai/diffex/-/diffex-${version}.tgz`);
	assert.match(tarballIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
	const substituted = structuredClone(lock);
	// No graph regeneration, overrides, range changes, or package.json edits.
	substituted.packages["node_modules/@diffexai/diffex"].resolved = `file:${resolve(tarball)}`;
	substituted.packages["node_modules/@diffexai/diffex"].integrity = tarballIntegrity;
	return substituted;
}

function removeDevelopmentRecords(directory) {
	// Upstream registry packages sometimes ship their repository workflow/editor
	// records. These are never runtime or legal inputs. Credentials are NOT pruned:
	// the payload gate rejects them, so they cannot be silently hidden by packaging.
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if ([".github", ".vscode", ".idea", ".git", ".hg", ".svn", "__pycache__", ".DS_Store"].includes(entry.name))
			rmSync(path, { recursive: true, force: true });
		else if (entry.isDirectory()) removeDevelopmentRecords(path);
	}
}

function componentLegalFiles(directory, prefix) {
	return readdirSync(directory).filter((name) => /^(?:licen[sc]e|copying|notice|third-party-notices)(?:[.-]|$)/i.test(name))
		.filter((name) => lstatSync(join(directory, name)).isFile())
		.sort().map((name) => ({ path: `${prefix}/${name}`, sha256: digest(readFileSync(join(directory, name))) }));
}

function npmComponents(directory, prefix) {
	const components = [];
	const visit = (modules, local) => {
		if (!existsSync(modules)) return;
		for (const entry of readdirSync(modules, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (entry.name.startsWith("@")) { visit(join(modules, entry.name), `${local}/${entry.name}`); continue; }
			const path = join(modules, entry.name);
			const file = join(path, "package.json");
			if (!existsSync(file)) continue;
			const info = JSON.parse(regularBytes(file, 1024 * 1024));
			const payloadPath = `${local}/${entry.name}`;
			components.push({ name: info.name, version: info.version, license: info.license ?? "SEE RETAINED UPSTREAM LEGAL FILES",
				path: payloadPath, legalFiles: componentLegalFiles(path, payloadPath), distribution: "Bundled in the signed official Node.js npm runtime archive" });
			visit(join(path, "node_modules"), `${payloadPath}/node_modules`);
		}
	};
	visit(join(directory, "node_modules"), `${prefix}/node_modules`);
	return components;
}

function installedPackages(app, lock, platform, arch) {
	const result = [];
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (!path) continue;
		assert(/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path) && !path.split("/").some((part) => [".", ".."].includes(part)), "Invalid install-lock package path");
		assert(!entry.link && !entry.dev && !entry.devOptional && !entry.extraneous, "Non-production install-lock entry");
		const supported = [["os", platform], ["cpu", arch], ["libc", "glibc"]].every(([key, value]) => {
			const values = entry[key] === undefined ? [] : Array.isArray(entry[key]) ? entry[key] : [entry[key]];
			return !values.includes(`!${value}`) && (!values.some((v) => !v.startsWith("!")) || values.includes(value) || values.includes("any"));
		});
		const file = join(app, path, "package.json");
		if (!supported) {
			assert(!existsSync(file), `Unsupported package installed: ${path}`);
			continue;
		}
		const info = JSON.parse(regularBytes(file, 1024 * 1024));
		assert.equal(info.name, path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length));
		assert.equal(info.version, entry.version, `Installed production identity mismatch: ${path}`);
		result.push({ path, name: info.name, version: info.version, integrity: entry.integrity });
	}
	return result.sort((a, b) => ordered(a.path, b.path));
}

export function inspectHomebrewArchive(archive, { record } = {}) {
	const bytes = regularBytes(archive);
	const inspected = python(["inspect", resolve(archive)]);
	if (record) {
		assert.equal(basename(archive), homebrewArchiveFilename(record.version, record.platform));
		for (const key of ["version", "sourceCommit", "platform", "nodeVersion", "npmVersion", "inventorySha256"])
			assert.equal(inspected[key], record[key], `Homebrew retained ${key} mismatch`);
		assert.equal(bytes.length, record.size, "Homebrew retained archive size mismatch");
		assert.equal(digest(bytes), record.sha256, "Homebrew retained archive checksum mismatch");
		assert.equal(record.osBaseline, record.platform.startsWith("darwin-") ? "macos-15" : "ubuntu-24.04");
	}
	return inspected;
}

export async function prepareHomebrewArchive({
	releaseDirectory, outputDirectory, manifest,
	platform = process.platform, arch = process.arch, runtimeDirectory, runtimePins = readRuntimePins(), fetcher = fetch,
}) {
	assert.equal(platform, process.platform, "Homebrew archive requires native OS preparation");
	assert.equal(arch, process.arch, "Homebrew archive requires native CPU preparation");
	const target = `${platform}-${arch}`;
	const filename = homebrewArchiveFilename(manifest?.version, target);
	releaseDirectory = realpathSync(releaseDirectory);
	outputDirectory = resolveArtifactDirectory(outputDirectory);
	mkdirSync(outputDirectory, { recursive: true });
	outputDirectory = realpathSync(outputDirectory);
	const output = join(outputDirectory, filename);
	const recordFile = join(outputDirectory, filename.replace(/\.tar\.gz$/, ".json"));
	assert(!existsSync(output) && !existsSync(recordFile), "Retained Homebrew outputs already exist; do not rebuild them");
	const source = validateHomebrewSource(releaseDirectory, manifest);
	const runtime = await verifyHomebrewRuntime({ platform, arch, runtimeDirectory, pins: runtimePins, fetcher });
	const work = mkdtempSync(join(realpathSync(tmpdir()), "diffex-homebrew-"));
	try {
		const retained = join(work, source.artifact.filename);
		cpSync(join(releaseDirectory, source.artifact.filename), retained);
		assert.equal(digest(regularBytes(retained)), source.artifact.sha256, "Retained CLI changed while preparing archive");
		python(["extract", retained, join(work, "candidate"), "--root", "package"]);
		const candidate = join(work, "candidate/package");
		const inventory = JSON.parse(readFileSync(join(candidate, "distribution-files.json"), "utf8"));
		assert.equal(inventory.sourceCommit, manifest.source.commit, "Retained CLI source commit mismatch");
		const installer = JSON.parse(readFileSync(join(candidate, "release/install-package.json"), "utf8"));
		const lock = JSON.parse(readFileSync(join(candidate, "release/install-package-lock.json"), "utf8"));
		const installLock = substituteHomebrewInstallLock({ installer, lock, version: manifest.version, tarball: retained, tarballIntegrity: source.artifact.integrity });
		const runtimeArchive = join(work, runtime.identity.filename);
		writeFileSync(runtimeArchive, runtime.archive);
		python(["extract", runtimeArchive, join(work, "upstream"), "--root", runtime.identity.filename.slice(0, -7)]);
		const upstream = join(work, "upstream", runtime.identity.filename.slice(0, -7));
		const root = join(work, "diffex");
		const runtimeRoot = join(root, "runtime");
		mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
		mkdirSync(join(runtimeRoot, "lib/node_modules"), { recursive: true });
		for (const path of ["bin/node", "lib/node_modules/npm", "LICENSE"])
			cpSync(join(upstream, path), join(runtimeRoot, path), { recursive: true, verbatimSymlinks: true });
		for (const [name, bytes] of Object.entries(runtime.proof)) writeFileSync(join(runtimeRoot, name), bytes);
		const node = join(runtimeRoot, "bin/node");
		const npmCli = join(runtimeRoot, "lib/node_modules/npm/bin/npm-cli.js");
		runtime.identity.nodeSha256 = digest(regularBytes(node));
		assert.equal(runtime.identity.nodeSha256, digest(regularBytes(join(upstream, "bin/node"))), "Official Node binary bytes changed");
		// Official Node's npm tarball includes an empty .npmrc placeholder. Do not
		// distribute even empty config files; unexpected nonempty bytes fail closed.
		const npmConfig = join(runtimeRoot, "lib/node_modules/npm/.npmrc");
		if (existsSync(npmConfig)) {
			assert(lstatSync(npmConfig).isFile() && lstatSync(npmConfig).size === 0, "Unexpected official npm configuration");
			rmSync(npmConfig);
		}
		const env = isolatedEnvironment(join(work, "isolation"));
		env.PATH = `${dirname(node)}:${env.PATH ?? "/usr/bin:/bin"}`;
		const options = { env, encoding: "utf8", timeout: 600_000, maxBuffer: 32 * 1024 * 1024 };
		assert.equal(execFileSync(node, ["--version"], options).trim(), `v${runtimePins.nodeVersion}`, "Retained Node version mismatch");
		assert.equal(execFileSync(node, [npmCli, "--version"], options).trim(), runtimePins.npmVersion, "Retained private npm version mismatch");
		const app = join(root, "app");
		mkdirSync(app);
		writeFileSync(join(app, "package.json"), json(installer));
		writeFileSync(join(app, "package-lock.json"), json(installLock));
		execFileSync(node, [npmCli, "ci", "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { ...options, cwd: app, stdio: "inherit" });
		assert(isDeepStrictEqual(JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8")), installLock), "npm changed the reviewed install lock");
		// Retain registry identities, not temporary absolute file/workspace paths.
		const retainedLock = structuredClone(lock);
		retainedLock.packages["node_modules/@diffexai/diffex"].integrity = source.artifact.integrity;
		writeFileSync(join(app, "package-lock.json"), json(retainedLock));
		rmSync(join(app, "node_modules/.package-lock.json"), { force: true });
		removeDevelopmentRecords(join(app, "node_modules"));
		removeDevelopmentRecords(join(runtimeRoot, "lib/node_modules/npm"));
		const packages = installedPackages(app, retainedLock, platform, arch);
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin/diffex"), HOMEBREW_LAUNCHER, { mode: 0o755 });
		cpSync(license, join(root, "LICENSE"));
		const components = [
			{ name: "@diffexai/diffex", version: manifest.version, notice: "app/node_modules/@diffexai/diffex/THIRD-PARTY-NOTICES.txt" },
			{ name: "node", version: runtimePins.nodeVersion, notice: "runtime/LICENSE" },
			{ name: "npm", version: runtimePins.npmVersion, notice: "runtime/lib/node_modules/npm/LICENSE" },
			...packages.filter((pkg) => pkg.name !== "@diffexai/diffex").map((pkg) => {
				const info = JSON.parse(readFileSync(join(app, pkg.path, "package.json"), "utf8"));
				return { ...pkg, license: info.license ?? "SEE RETAINED UPSTREAM LEGAL FILES", legalFiles: componentLegalFiles(join(app, pkg.path), `app/${pkg.path}`),
					distribution: "Production npm dependency; upstream legal/source files retained in app." };
			}),
			...npmComponents(join(runtimeRoot, "lib/node_modules/npm"), "runtime/lib/node_modules/npm"),
		];
		for (const component of components)
			if (component.notice) component.noticeSha256 = digest(regularBytes(join(root, component.notice)));
		writeFileSync(join(root, "distribution-components.json"), json(components));
		writeFileSync(join(root, "THIRD-PARTY-NOTICES.txt"), "Diffex self-contained Homebrew distribution\n\nDiffex: MIT; see LICENSE and app/node_modules/@diffexai/diffex/THIRD-PARTY-NOTICES.txt.\nNode.js and bundled components: see runtime/LICENSE.\nnpm and its bundled dependencies: see runtime/lib/node_modules/npm/LICENSE and retained upstream notices.\nProduction application dependency legal/source files are retained in app/node_modules.\nSee distribution-components.json for exact identities.\nRedistribution approval is required before publication.\n");
		writeFileSync(join(root, "distribution.json"), json({
			schemaVersion: 1, product: "@diffexai/diffex", version: manifest.version,
			sourceCommit: manifest.source.commit, source: manifest.source, platform: target,
			runtime: runtime.identity, archiveUrl: homebrewArchiveUrl(manifest.version, target),
			application: source.artifact, payloadIdentity: source.payloadIdentity,
			installLockSha256: digest(readFileSync(join(candidate, "release/install-package-lock.json"))), packages,
		}));
		const staged = join(work, filename);
		const inspection = python(["prepare", root, staged]);
		const bytes = regularBytes(staged);
		const record = {
			platform: target, filename, size: bytes.length, sha256: digest(bytes), inventorySha256: inspection.inventorySha256,
			osBaseline: platform === "darwin" ? "macos-15" : "ubuntu-24.04", version: manifest.version,
			sourceCommit: manifest.source.commit, nodeVersion: runtimePins.nodeVersion, npmVersion: runtimePins.npmVersion,
		};
		inspectHomebrewArchive(staged, { record });
		writeFileSync(output, bytes, { flag: "wx" });
		writeFileSync(recordFile, json(record), { flag: "wx" });
		return record;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
