import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNpmArtifact } from "./release-registry.mjs";

const REGISTRY = "https://registry.npmjs.org";
const DISCOVERY = "https://api.diffex.ai/api/latest-version";
const PACKAGE = "@diffexai/diffex";
const stable = (value) => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateAcceptanceManifest(manifest, previous) {
	assert(stable(manifest?.version) && stable(previous), "Expected stable release and predecessor versions");
	const target = manifest.version.split(".").map(BigInt);
	const older = previous.split(".").map(BigInt);
	const difference = target.findIndex((part, index) => part !== older[index]);
	assert(difference !== -1 && target[difference] > older[difference], "Predecessor must be older than the release");
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.source?.repository, "diffexai/diffex");
	assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
	assert.equal(manifest.packages?.length, 1, "Acceptance supports the approved CLI-only inventory");
	const pkg = manifest.packages[0];
	assert.equal(pkg.name, PACKAGE);
	assert.equal(pkg.version, manifest.version);
	assert.match(pkg.sha256, /^[a-f0-9]{64}$/);
	assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
	assert(Number.isSafeInteger(pkg.size) && pkg.size > 0 && pkg.size <= 256 * 1024 * 1024);
	return pkg;
}

export async function verifyPublicDiscovery(version, request = fetch) {
	assert(stable(version), "Expected a stable release version");
	const response = await request(DISCOVERY, { redirect: "error", signal: AbortSignal.timeout(30000) });
	assert.equal(response.status, 200, "The intended release must be announced");
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
	const body = await response.json();
	assert.deepEqual(body, { version, packageName: PACKAGE }, "Discovery must match the intended release exactly");
	return { url: DISCOVERY, status: response.status, body, cacheControl: "no-store" };
}

export function verifyInstalledFiles(directory, inventory) {
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "distribution-files.json"), "utf8")), inventory);
	for (const file of inventory.files) {
		assert(typeof file.path === "string" && !isAbsolute(file.path));
		const path = join(directory, file.path);
		const local = relative(realpathSync(directory), realpathSync(path));
		assert(local && !local.startsWith("..") && !isAbsolute(local), "Installed file escapes the package");
		assert.equal(hash(readFileSync(path)), file.sha256, `Installed bytes differ: ${file.path}`);
	}
}

export async function acceptPublicRelease(manifest, previous, output) {
	const pkg = validateAcceptanceManifest(manifest, previous);
	const evidence = {
		startedAt: new Date().toISOString(),
		sourceCommit: manifest.source.commit,
		version: pkg.version,
		previousVersion: previous,
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		commands: [],
		managers: [],
		status: "failed",
		cleanup: false,
		limitations: [
			"Native runner tests do not receive provider credentials; live OAuth and inference require separate acceptance.",
			"The first release predecessor is the public bootstrap artifact, not a previously announced general release.",
		],
	};
	mkdirSync(output, { recursive: true });
	const temporary = mkdtempSync(join(tmpdir(), "diffex-public-acceptance-"));
	try {
		evidence.discovery = await verifyPublicDiscovery(pkg.version);
		evidence.artifact = await verifyNpmArtifact(pkg);
		const response = await fetch(evidence.artifact.tarball, {
			redirect: "error",
			signal: AbortSignal.timeout(30000),
		});
		assert.equal(response.status, 200);
		const chunks = [];
		let size = 0;
		assert(response.body, "The public tarball must have a body");
		for await (const chunk of response.body) {
			size += chunk.length;
			assert(size <= pkg.size, "Public tarball exceeds the reviewed size");
			chunks.push(chunk);
		}
		const bytes = Buffer.concat(chunks);
		assert.equal(bytes.length, pkg.size);
		assert.equal(hash(bytes), pkg.sha256);
		const archive = join(temporary, "approved.tgz");
		writeFileSync(archive, bytes);
		const member = (name) =>
			JSON.parse(
				execFileSync("tar", ["-xOf", archive, `package/${name}`], {
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
				}),
			);
		const inventory = member("distribution-files.json");
		assert.equal(inventory.sourceCommit, manifest.source.commit);
		assert.equal(member("release/distribution-manifest.json").source.commit, manifest.source.commit);
		assert.equal(member("package.json").version, pkg.version);
		const predecessor = await fetch(`${REGISTRY}/${encodeURIComponent(PACKAGE)}/${previous}`, {
			redirect: "error",
			signal: AbortSignal.timeout(30000),
		});
		assert.equal(predecessor.status, 200, "The recorded predecessor must exist publicly");
		const predecessorMetadata = await predecessor.json();
		assert.equal(predecessorMetadata.name, PACKAGE);
		assert.equal(predecessorMetadata.version, previous);
		assert.equal(predecessorMetadata.dist.tarball, `${REGISTRY}/${PACKAGE}/-/diffex-${previous}.tgz`);
		evidence.predecessor = {
			version: previous,
			tarball: predecessorMetadata.dist.tarball,
			integrity: predecessorMetadata.dist.integrity,
		};
		for (const manager of ["npm", "bun"]) {
			const directory = join(temporary, manager);
			for (const name of ["home", "config", "cache", "prefix", "agent", "project/.diffex", "temp"])
				mkdirSync(join(directory, name), { recursive: true });
			const prefix = join(directory, "prefix");
			const bun = join(directory, "bun");
			const bin = manager === "npm" ? join(prefix, "bin") : join(bun, "bin");
			const packageRoot =
				manager === "npm"
					? join(prefix, "lib/node_modules", PACKAGE)
					: join(bun, "install/global/node_modules", PACKAGE);
			const executable = join(bin, "diffex");
			const env = {
				PATH: `${bin}:${process.env.PATH}`,
				HOME: join(directory, "home"),
				XDG_CONFIG_HOME: join(directory, "config"),
				XDG_CACHE_HOME: join(directory, "cache"),
				LANG: "en_US.UTF-8",
				TERM: "xterm-256color",
				TMPDIR: join(directory, "temp"),
				npm_config_prefix: prefix,
				npm_config_cache: join(directory, "cache/npm"),
				npm_config_userconfig: join(directory, "empty.npmrc"),
				npm_config_globalconfig: join(directory, "empty-global.npmrc"),
				npm_config_registry: REGISTRY,
				npm_config_update_notifier: "false",
				npm_config_audit: "false",
				npm_config_fund: "false",
				BUN_INSTALL: bun,
				BUN_INSTALL_BIN: bin,
				BUN_INSTALL_GLOBAL_DIR: join(bun, "install/global"),
				BUN_INSTALL_CACHE_DIR: join(directory, "cache/bun"),
				DIFFEX_CODING_AGENT_DIR: join(directory, "agent"),
				DIFFEX_NO_LOCAL_LLM: "1",
			};
			const retained = join(env.DIFFEX_CODING_AGENT_DIR, "retained.txt");
			const projectData = join(directory, "project/.diffex/retained.txt");
			writeFileSync(retained, "retain user data");
			writeFileSync(projectData, "retain project data");
			const run = (command, args, extraEnv = {}) => {
				const item = { manager, command: command === executable ? "diffex" : command, args, exitCode: null };
				evidence.commands.push(item);
				try {
					const text = execFileSync(command, args, {
						cwd: join(directory, "project"),
						env: { ...env, ...extraEnv },
						encoding: "utf8",
						timeout: 180000,
						maxBuffer: 16 * 1024 * 1024,
					});
					item.exitCode = 0;
					return text.trim();
				} catch (error) {
					item.exitCode = error.status;
					throw error;
				}
			};
			const install = (version) =>
				run(manager, [
					"install",
					"-g",
					"--ignore-scripts",
					`${PACKAGE}@${version}`,
					...(manager === "npm" ? [`--registry=${REGISTRY}`] : []),
				]);
			const smoke = (version) => {
				assert.equal(run(executable, ["--version"]), version);
				assert.match(run(executable, ["--help"]), /Diffex/);
				assert(run(executable, ["--list-models"], { DIFFEX_OFFLINE: "1" }).length > 100);
			};
			install(previous);
			smoke(previous);
			const beforeVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
			// Empty manager caches prove the updater retrieves the new public artifact.
			env.npm_config_cache = join(directory, "cache/npm-upgrade");
			env.BUN_INSTALL_CACHE_DIR = join(directory, "cache/bun-upgrade");
			const updateOutput = run(executable, ["update", "--self"]);
			assert(updateOutput.includes(pkg.version));
			smoke(pkg.version);
			verifyInstalledFiles(packageRoot, inventory);
			const afterVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
			const remove = () => {
				run(manager, ["uninstall", "-g", ...(manager === "npm" ? ["--ignore-scripts"] : []), PACKAGE]);
				assert(!existsSync(executable) && !existsSync(packageRoot));
				assert.equal(readFileSync(retained, "utf8"), "retain user data");
				assert.equal(readFileSync(projectData, "utf8"), "retain project data");
			};
			remove();
			env.npm_config_cache = join(directory, "cache/npm-fresh");
			env.BUN_INSTALL_CACHE_DIR = join(directory, "cache/bun-fresh");
			install(pkg.version);
			smoke(pkg.version);
			verifyInstalledFiles(packageRoot, inventory);
			remove();
			evidence.managers.push({
				manager,
				managerVersion: run(manager, ["--version"]),
				beforeVersion,
				afterVersion,
				freshInstall: "passed",
				installedHashes: "passed",
				uninstall: "passed",
				userDataRetained: true,
				projectDataRetained: true,
			});
			console.log(`Public ${manager} lifecycle passed: ${beforeVersion} -> ${afterVersion}`);
		}
		await verifyPublicDiscovery(pkg.version);
		evidence.status = "passed";
	} finally {
		rmSync(temporary, { recursive: true, force: true });
		evidence.cleanup = !existsSync(temporary);
		evidence.finishedAt = new Date().toISOString();
		writeFileSync(join(output, "public-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	}
	return evidence;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [manifest, previous, output] = process.argv.slice(2);
	assert(
		manifest && previous && output,
		"Usage: public-release-acceptance.mjs MANIFEST PREVIOUS_VERSION EVIDENCE_DIRECTORY",
	);
	await acceptPublicRelease(JSON.parse(readFileSync(manifest, "utf8")), previous, resolve(output));
}
