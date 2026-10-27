import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function resolveArtifactDirectory(value) {
	assert(typeof value === "string" && value.length > 0 && !value.includes("\0"), "Invalid artifact directory");
	const directory = resolve(value);
	for (const base of [process.cwd(), tmpdir(), homedir(), "/tmp"]) {
		const root = resolve(base);
		if (!directory.startsWith(root + sep)) continue;
		let current = root;
		for (const component of relative(root, directory).split(sep)) {
			current = join(current, component);
			const entry = lstatSync(current, { throwIfNoEntry: false });
			assert(!entry?.isSymbolicLink(), "Artifact directory must not traverse symlinks");
			assert(!entry || entry.isDirectory(), "Artifact directory contains a non-directory component");
		}
		return directory;
	}
	throw new Error("Artifact directory must be inside the workspace, home, or temporary directory");
}

export function assertContained(file, directory) {
	const local = relative(realpathSync(directory), realpathSync(file));
	assert(local === "" || (!local.startsWith("..") && !isAbsolute(local)), `Path escapes isolated consumer: ${file}`);
}

export function verifyTarballs(directory, records, packages) {
	directory = resolveArtifactDirectory(directory);
	assert.equal(records.length, packages.length, "Incomplete tarball inventory");
	assert.equal(new Set(records.map((pkg) => pkg.name)).size, packages.length, "Duplicate tarball identity");
	for (const pkg of packages) {
		const record = records.find((entry) => entry.name === pkg.name);
		assert(record && record.version === pkg.version, `Missing tarball: ${pkg.name}`);
		assert(typeof record.filename === "string" && basename(record.filename) === record.filename, "Invalid tarball filename");
		assert.equal(record.filename, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
		assert.equal(
			digest(readFileSync(join(directory, record.filename))),
			record.sha256,
			`Tarball checksum mismatch: ${pkg.name}`,
		);
	}
}

export function isolatedEnvironment(directory) {
	directory = resolveArtifactDirectory(directory);
	// Read literal allowlisted names: dynamic environment lookups can accidentally
	// admit credentials when this helper is reused by installation/lifecycle code.
	const env = Object.fromEntries(Object.entries({
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		COMSPEC: process.env.COMSPEC,
		PATHEXT: process.env.PATHEXT,
		LANG: process.env.LANG,
	}).filter(([, value]) => typeof value === "string"));
	for (const dir of ["home", "config", "cache", "prefix", "project", "agent", "temp"])
		mkdirSync(resolveArtifactDirectory(join(directory, dir)), { recursive: true });
	return {
		...env,
		HOME: join(directory, "home"),
		USERPROFILE: join(directory, "home"),
		XDG_CONFIG_HOME: join(directory, "config"),
		XDG_CACHE_HOME: join(directory, "cache"),
		npm_config_cache: join(directory, "cache", "npm"),
		npm_config_prefix: join(directory, "prefix"),
		npm_config_userconfig: join(directory, "empty.npmrc"),
		npm_config_globalconfig: join(directory, "empty-global.npmrc"),
		npm_config_registry: "https://registry.npmjs.org",
		npm_config_update_notifier: "false",
		BUN_INSTALL_CACHE_DIR: join(directory, "cache", "bun"),
		TMPDIR: join(directory, "temp"),
		TMP: join(directory, "temp"),
		TEMP: join(directory, "temp"),
		DIFFEX_CODING_AGENT_DIR: join(directory, "agent"),
		DIFFEX_NO_LOCAL_LLM: "1",
		DIFFEX_OFFLINE: "1",
		TERM: "xterm-256color",
	};
}

export function installConsumer(
	directory,
	manager,
	selected,
	records,
	tarballDirectory,
	cacheDirectory = join(directory, "cache"),
) {
	directory = resolveArtifactDirectory(directory);
	cacheDirectory = resolveArtifactDirectory(cacheDirectory);
	tarballDirectory = resolveArtifactDirectory(tarballDirectory);
	assert(manager === "npm" || manager === "bun", "Unsupported package manager");
	const command = manager === "npm" ? "npm" : "bun";
	assert(selected.every((pkg) => typeof pkg.name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)), "Invalid package name");
	mkdirSync(directory, { recursive: true });
	const env = isolatedEnvironment(directory);
	mkdirSync(cacheDirectory, { recursive: true });
	env.npm_config_cache = join(cacheDirectory, "npm");
	env.BUN_INSTALL_CACHE_DIR = join(cacheDirectory, "bun");
	writeFileSync(join(directory, ".npmrc"), "@diffexai:registry=http://127.0.0.1:9/\n");
	const dependencies = Object.fromEntries(
		selected.map((pkg) => [
			pkg.name,
			`file:${join(tarballDirectory, records.find((record) => record.name === pkg.name).filename)}`,
		]),
	);
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }),
	);
	execFileSync(
		command,
		manager === "npm"
			? ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
			: ["install", "--production", "--ignore-scripts", "--network-concurrency=8"],
		{ cwd: directory, env, stdio: "inherit", timeout: 600_000 },
	);
	for (const pkg of selected) {
		const installed = join(directory, "node_modules", pkg.name);
		assertContained(installed, directory);
		const info = readJson(join(installed, "package.json"));
		assert.equal(info.name, pkg.name);
		assert.equal(info.version, pkg.version);
		const record = records.find((entry) => entry.name === pkg.name);
		const inventory = JSON.parse(
			execFileSync("tar", ["-xOf", join(tarballDirectory, record.filename), "package/distribution-files.json"], {
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			}),
		);
		assert.deepEqual(
			readJson(join(installed, "distribution-files.json")),
			inventory,
			"Installed inventory differs from the checked tarball",
		);
		for (const file of inventory.files) {
			assert(typeof file.path === "string" && !isAbsolute(file.path) && !file.path.split(/[\\/]/).includes(".."), "Invalid inventory path");
			assertContained(join(installed, file.path), installed);
			assert.equal(
				digest(readFileSync(join(installed, file.path))),
				file.sha256,
				`Installed bytes differ: ${pkg.name}/${file.path}`,
			);
		}
	}
	return env;
}
