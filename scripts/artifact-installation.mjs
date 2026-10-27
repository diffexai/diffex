import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function assertContained(file, directory) {
	const local = relative(realpathSync(directory), realpathSync(file));
	assert(local === "" || (!local.startsWith("..") && !isAbsolute(local)), `Path escapes isolated consumer: ${file}`);
}

export function verifyTarballs(directory, records, packages) {
	assert.equal(records.length, packages.length, "Incomplete tarball inventory");
	assert.equal(new Set(records.map((pkg) => pkg.name)).size, packages.length, "Duplicate tarball identity");
	for (const pkg of packages) {
		const record = records.find((entry) => entry.name === pkg.name);
		assert(record && record.version === pkg.version, `Missing tarball: ${pkg.name}`);
		assert.equal(record.filename, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
		assert.equal(
			digest(readFileSync(join(directory, record.filename))),
			record.sha256,
			`Tarball checksum mismatch: ${pkg.name}`,
		);
	}
}

export function isolatedEnvironment(directory) {
	const env = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	for (const dir of ["home", "config", "cache", "prefix", "project", "agent", "temp"])
		mkdirSync(join(directory, dir), { recursive: true });
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
		manager,
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

