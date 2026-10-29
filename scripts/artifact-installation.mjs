import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
export const PNPM_VERSION = "10.28.2";
export const ACCEPTANCE_MANAGERS = ["npm", "pnpm", "bun"];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function resolveArtifactDirectory(value) {
	assert(typeof value === "string" && value.length > 0 && !value.includes("\0"), "Invalid artifact directory");
	const directory = resolve(value);
	const roots = [process.cwd(), tmpdir(), homedir(), "/tmp"].flatMap((base) =>
		existsSync(base) ? [resolve(base), realpathSync(base)] : [resolve(base)]);
	for (const root of new Set(roots)) {
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

export function isolatedEnvironment(directory, manager = "npm") {
	assert(ACCEPTANCE_MANAGERS.includes(manager), "Unsupported package manager");
	directory = resolveArtifactDirectory(directory);
	mkdirSync(directory, { recursive: true });
	// pnpm records absolute virtual-store paths; macOS /var and /private/var must not mix.
	directory = realpathSync(directory);
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
	for (const dir of ["home", "config", "cache", "prefix", "project", "agent", "temp", "pnpm/bin"])
		mkdirSync(resolveArtifactDirectory(join(directory, dir)), { recursive: true });
	writeFileSync(join(directory, "empty.npmrc"), "");
	writeFileSync(join(directory, "empty-global.npmrc"), "");
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
		...(manager === "pnpm" ? {
			PNPM_HOME: join(directory, "pnpm", "bin"),
			npm_config_global_bin_dir: join(directory, "pnpm", "bin"),
			npm_config_global_dir: join(directory, "pnpm", "global"),
			npm_config_store_dir: join(directory, "cache", "pnpm"),
			npm_config_manage_package_manager_versions: "false",
			npm_config_package_manager_strict: "false",
		} : {}),
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
	options = {},
) {
	assert(ACCEPTANCE_MANAGERS.includes(manager), "Unsupported package manager");
	assert(options !== null && typeof options === "object" && !Array.isArray(options), "Invalid installation options");
	assert(Object.keys(options).every((key) => ["lifecycleScripts", "timeoutMilliseconds"].includes(key)), "Unsupported installation option");
	const lifecycleScripts = options.lifecycleScripts === undefined ? "disabled" : options.lifecycleScripts;
	assert(["disabled", "enabled"].includes(lifecycleScripts), "Invalid lifecycle scripts mode");
	assert(lifecycleScripts === "disabled" || manager === "npm", "Lifecycle scripts opt-in is supported only for npm");
	const timeoutMilliseconds = options.timeoutMilliseconds === undefined ? 600_000 : options.timeoutMilliseconds;
	assert(Number.isSafeInteger(timeoutMilliseconds) && timeoutMilliseconds > 0 && timeoutMilliseconds <= 600_000, "Invalid installation timeoutMilliseconds");
	assert(options.timeoutMilliseconds === undefined || lifecycleScripts === "enabled", "Custom timeout requires script-enabled npm");
	assert(lifecycleScripts === "disabled" || process.platform !== "win32", "Script-enabled npm requires POSIX process groups");
	directory = resolveArtifactDirectory(directory);
	cacheDirectory = resolveArtifactDirectory(cacheDirectory);
	tarballDirectory = resolveArtifactDirectory(tarballDirectory);
	const command = manager;
	assert(selected.every((pkg) => typeof pkg.name === "string" && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)), "Invalid package name");
	mkdirSync(directory, { recursive: true });
	const env = isolatedEnvironment(directory, manager);
	mkdirSync(cacheDirectory, { recursive: true });
	env.npm_config_cache = join(cacheDirectory, "npm");
	env.BUN_INSTALL_CACHE_DIR = join(cacheDirectory, "bun");
	if (manager === "pnpm") {
		env.npm_config_store_dir = join(realpathSync(cacheDirectory), "pnpm");
		assert(!existsSync(env.npm_config_store_dir), "pnpm consumer acceptance requires an empty store");
		assertPnpmVersion(directory, env);
	}
	writeFileSync(join(directory, ".npmrc"), "@diffexai:registry=http://127.0.0.1:9/\n");
	const dependencies = Object.fromEntries(
		selected.map((pkg) => [
			pkg.name,
			`file:${join(tarballDirectory, records.find((record) => record.name === pkg.name).filename)}`,
		]),
	);
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies, pnpm: { overrides: dependencies } }),
	);
	if (manager === "npm") {
		const selectedRecords = selected.map((pkg) => records.find((record) => record.name === pkg.name));
		verifyTarballs(tarballDirectory, selectedRecords, selected);
		const packages = { "": { dependencies } };
		let shrinkwrapped = false;
		for (const pkg of selected) {
			const archive = dependencies[pkg.name].slice("file:".length);
			const archiveOptions = { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000 };
			const paths = execFileSync("tar", ["-tzf", archive], archiveOptions).trim().split("\n");
			if (!paths.includes("package/npm-shrinkwrap.json")) continue;
			assert.equal(paths.filter((path) => path === "package/npm-shrinkwrap.json").length, 1, "Duplicate candidate shrinkwrap");
			assert.equal(paths.filter((path) => path === "package/package.json").length, 1, "Duplicate candidate manifest");
			const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], archiveOptions));
			const lock = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/npm-shrinkwrap.json"], archiveOptions));
			assert.equal(manifest.name, pkg.name, "Candidate manifest name mismatch");
			assert.equal(manifest.version, pkg.version, "Candidate manifest version mismatch");
			assert.equal(lock.name, manifest.name, "Candidate shrinkwrap name mismatch");
			assert.equal(lock.version, manifest.version, "Candidate shrinkwrap version mismatch");
			assert.equal(lock.lockfileVersion, 3, "Candidate shrinkwrap must use lockfileVersion 3");
			assert(lock.packages && lock.packages[""], "Candidate shrinkwrap has no root entry");
			assert.equal(lock.packages[""].name, manifest.name, "Candidate shrinkwrap root name mismatch");
			assert.equal(lock.packages[""].version, manifest.version, "Candidate shrinkwrap root version mismatch");
			for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"])
				assert.deepEqual(lock.packages[""][field] ?? {}, manifest[field] ?? {}, `Candidate shrinkwrap ${field} mismatch`);
			const target = `node_modules/${pkg.name}`;
			packages[target] = {
				...lock.packages[""], resolved: dependencies[pkg.name],
				integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`,
				hasShrinkwrap: true,
			};
			for (const [path, entry] of Object.entries(lock.packages)) {
				if (!path) continue;
				assert(path.startsWith("node_modules/") && !path.includes("\\") && !path.split("/").some((part) => ["", ".", ".."].includes(part)), "Invalid candidate shrinkwrap path");
				assert(entry && !entry.link, "Candidate shrinkwrap must not contain links");
				packages[`${target}/${path}`] = entry;
			}
			shrinkwrapped = true;
		}
		// Local tarball manifests do not expose the registry's _hasShrinkwrap flag.
		// Seed it in the consumer lock, not in the immutable published artifact, so
		// npm inflates the reviewed graph instead of resolving transitive ranges.
		if (shrinkwrapped)
			writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, requires: true, packages }));
	}
	const args = manager === "npm"
		// Explicit false defeats npm's built-in config as well as inherited config;
		// only this audited npm consumer path may enable dependency lifecycle hooks.
		? ["install", "--omit=dev", lifecycleScripts === "enabled" ? "--ignore-scripts=false" : "--ignore-scripts", "--no-audit", "--no-fund"]
		: manager === "pnpm"
			? ["install", "--prod", "--ignore-scripts", "--no-frozen-lockfile"]
			: ["install", "--production", "--ignore-scripts", "--network-concurrency=8"];
	if (lifecycleScripts === "enabled") {
		// spawnSync reaps npm, including on timeout. Inherited stdio cannot keep
		// its pipes open; SIGKILL bounds a hook that ignores npm's termination.
		const result = spawnSync(command, args, {
			cwd: directory, env, stdio: "inherit", detached: true,
			timeout: timeoutMilliseconds, killSignal: "SIGKILL",
		});
		if (result.pid) {
			try {
				process.kill(-result.pid, "SIGTERM");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
				process.kill(-result.pid, "SIGKILL");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
		}
		if (result.error) throw result.error;
		assert.equal(result.status, 0, `npm installation exited with ${result.status ?? result.signal}`);
	} else {
		execFileSync(command, args, { cwd: directory, env, stdio: "inherit", timeout: 600_000 });
	}
	verifyInstalledConsumer(directory, selected, records, tarballDirectory);
	return env;
}

export function verifyInstalledConsumer(directory, selected, records, tarballDirectory) {
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
}

export function assertPnpmVersion(directory, env) {
	let version;
	const remedy = `Install it with: npm install --global --ignore-scripts pnpm@${PNPM_VERSION}`;
	try {
		version = execFileSync("pnpm", ["--version"], { cwd: directory, env, encoding: "utf8", timeout: 30000 }).trim();
	} catch (cause) {
		throw new Error(`Acceptance requires pnpm@${PNPM_VERSION} on PATH. ${remedy}`, { cause });
	}
	assert.equal(version, PNPM_VERSION, `Acceptance requires pnpm@${PNPM_VERSION}; found ${version}. ${remedy}`);
	return version;
}

export function globalManagerLayout(manager, directory, env) {
	assert(ACCEPTANCE_MANAGERS.includes(manager), "Unsupported package manager");
	const bin = manager === "npm" ? join(env.npm_config_prefix, "bin")
		: manager === "pnpm" ? env.PNPM_HOME : env.BUN_INSTALL_BIN;
	const modules = manager === "npm" ? join(env.npm_config_prefix, "lib/node_modules")
		: manager === "pnpm" ? execFileSync("pnpm", ["root", "--global"], {
			cwd: directory, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: "utf8", timeout: 30000,
		}).trim() : join(env.BUN_INSTALL_GLOBAL_DIR, "node_modules");
	assert(isAbsolute(modules), `Invalid ${manager} global module directory: ${modules}`);
	const local = relative(realpathSync(directory), modules);
	assert(local && !local.startsWith("..") && !isAbsolute(local), `${manager} global root escapes isolation`);
	return { bin, modules, packageRoot: join(modules, "@diffexai/diffex"), executable: join(bin, "diffex") };
}
