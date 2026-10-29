import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ACCEPTANCE_MANAGERS, assertPnpmVersion, globalManagerLayout, installConsumer, isolatedEnvironment, PNPM_VERSION, resolveArtifactDirectory, verifyInstalledConsumer, verifyTarballs } from "./artifact-installation.mjs";

test("artifact directories stay within trusted roots and reject symlink components", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-artifact-paths-"));
	try {
		assert.equal(resolveArtifactDirectory(join(root, "new", "consumer")), join(root, "new", "consumer"));
		assert.throws(() => resolveArtifactDirectory("/etc/diffex-artifacts"), /workspace, home, or temporary/);
		assert.throws(() => resolveArtifactDirectory(""), /Invalid artifact/);
		assert.throws(() => resolveArtifactDirectory("bad\0path"), /Invalid artifact/);
		const target = join(root, "target");
		mkdirSync(target);
		symlinkSync(target, join(root, "linked"));
		assert.throws(() => resolveArtifactDirectory(join(root, "linked", "consumer")), /symlinks/);
		symlinkSync(join(root, "missing"), join(root, "dangling"));
		assert.throws(() => resolveArtifactDirectory(join(root, "dangling", "consumer")), /symlinks/);
		writeFileSync(join(root, "file"), "not a directory");
		assert.throws(() => resolveArtifactDirectory(join(root, "file", "consumer")), /non-directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("canonical OS temporary-root aliases stay trusted without allowing arbitrary private paths", () => {
	if (!existsSync("/tmp")) return;
	const root = mkdtempSync(join("/tmp", "diffex-artifact-canonical-"));
	try {
		const canonical = realpathSync(root);
		assert.equal(resolveArtifactDirectory(join(canonical, "new-consumer")), join(canonical, "new-consumer"));
		const target = join(canonical, "target");
		mkdirSync(target);
		symlinkSync(target, join(canonical, "linked"));
		assert.throws(() => resolveArtifactDirectory(join(canonical, "linked", "consumer")), /symlinks/);
		assert.throws(() => resolveArtifactDirectory("/private/unapproved-diffex-artifacts"), /workspace, home, or temporary/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("isolated installation environment copies literal non-secret allowlisted fields only", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-artifact-env-"));
	const original = { ...process.env };
	try {
		process.env.OPENAI_API_KEY = "synthetic-private-openai-value";
		process.env.DAYTONA_API_KEY = "synthetic-private-daytona-value";
		process.env.NODE_OPTIONS = "synthetic-private-node-options";
		process.env.NPM_TOKEN = "synthetic-private-npm-token";
		process.env.npm_config_userconfig = "/private/credential.npmrc";
		process.env.npm_config_store_dir = "/private/warm-store";
		process.env.PNPM_HOME = "/private/pnpm-home";
		process.env.XDG_DATA_HOME = "/private/data";
		process.env.COREPACK_NPM_TOKEN = "synthetic-private-corepack-token";
		process.env.npm_config_registry = "https://private.invalid";
		process.env.npm_config_ignore_scripts = "true";
		process.env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
		const environment = isolatedEnvironment(root);
		assert.equal(environment.PATH, original.PATH);
		assert.equal(environment.OPENAI_API_KEY, undefined);
		assert.equal(environment.DAYTONA_API_KEY, undefined);
		assert.equal(environment.NODE_OPTIONS, undefined);
		assert.equal(environment.npm_config_ignore_scripts, undefined);
		assert.equal(environment.NPM_CONFIG_IGNORE_SCRIPTS, undefined);
		assert.equal(environment.HOME, join(realpathSync(root), "home"));
		assert.equal(environment.NPM_TOKEN, undefined);
		assert.equal(environment.COREPACK_NPM_TOKEN, undefined);
		assert.equal(environment.XDG_DATA_HOME, undefined);
		assert.equal(environment.PNPM_HOME, undefined);
		const pnpm = isolatedEnvironment(root, "pnpm");
		assert.equal(pnpm.PNPM_HOME, join(realpathSync(root), "pnpm/bin"));
		assert.equal(pnpm.npm_config_store_dir, join(realpathSync(root), "cache/pnpm"));
		assert.equal(pnpm.npm_config_registry, "https://registry.npmjs.org");
		assert.equal(readFileSync(pnpm.npm_config_userconfig, "utf8"), "");
		assert.equal(readFileSync(pnpm.npm_config_globalconfig, "utf8"), "");
		assert(!existsSync(pnpm.npm_config_store_dir));
		assert.throws(() => assertPnpmVersion(root, { ...pnpm, PATH: root }), /npm install --global --ignore-scripts pnpm@10\.28\.2/);
	} finally {
		process.env = original;
		rmSync(root, { recursive: true, force: true });
	}
});

test("real pnpm installs dependency-first local tarballs with private-scope registry blocked and inventories checked", { timeout: 30000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-pnpm-consumer-"));
	try {
		assert.deepEqual(ACCEPTANCE_MANAGERS, ["npm", "pnpm", "bun"]);
		const packages = [
			{ name: "diffex-transitive-fixture", version: "1.2.3", main: "index.cjs" },
			{ name: "@diffexai/dependency", version: "1.2.3" },
			{ name: "@diffexai/diffex", version: "1.2.3", bin: { diffex: "dist/cli.js" }, dependencies: {
				"@diffexai/dependency": "1.2.3",
				"diffex-transitive-fixture": `file:${join(root, "diffex-transitive-fixture-1.2.3.tgz")}`,
			} },
		];
		const records = packages.map((pkg) => {
			const stage = join(root, pkg.name.split("/").pop());
			mkdirSync(join(stage, "package"), { recursive: true });
			const files = { "package.json": JSON.stringify(pkg), "index.js": "export const fixture = true;\n", "index.cjs": "module.exports = { fixture: 'non-hoisted transitive dependency' };\n", "dist/cli.js": "#!/usr/bin/env node\nconsole.log('fixture');\n" };
			const inventory = { files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") })) };
			for (const [path, bytes] of Object.entries({ ...files, "distribution-files.json": JSON.stringify(inventory) })) {
				mkdirSync(dirname(join(stage, "package", path)), { recursive: true });
				writeFileSync(join(stage, "package", path), bytes, { mode: 0o755 });
			}
			const filename = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
			execFileSync("tar", ["-czf", join(root, filename), "-C", stage, "package"]);
			return { ...pkg, filename, sha256: createHash("sha256").update(readFileSync(join(root, filename))).digest("hex") };
		});
		verifyTarballs(root, records, packages);
		const consumer = join(root, "consumer");
		const selected = packages.filter((pkg) => pkg.name !== "diffex-transitive-fixture");
		const env = installConsumer(consumer, "pnpm", selected, records, root);
		assert.equal(assertPnpmVersion(consumer, env), PNPM_VERSION);
		const lexicalPackageRoot = join(consumer, "node_modules/@diffexai/diffex");
		const packageRoot = realpathSync(lexicalPackageRoot);
		assert.match(packageRoot, /[\\/]\.pnpm[\\/]/);
		assert(!existsSync(join(consumer, "node_modules/diffex-transitive-fixture")), "Transitive fixture must not be hoisted to the consumer root");
		assert.throws(() => createRequire(join(lexicalPackageRoot, "package.json"))("diffex-transitive-fixture"), { code: "MODULE_NOT_FOUND" });
		const cliRequire = createRequire(join(packageRoot, "package.json"));
		assert.deepEqual(cliRequire("diffex-transitive-fixture"), { fixture: "non-hoisted transitive dependency" });
		const validator = join(root, "validate.py");
		writeFileSync(validator, [
			"import importlib.util, json, sys",
			"spec = importlib.util.spec_from_file_location('verifier', sys.argv[1])",
			"module = importlib.util.module_from_spec(spec)",
			"spec.loader.exec_module(module)",
			"executable, consumer = module.installed_executable(sys.argv[2])",
			"print(json.dumps([executable, str(consumer)]))",
		].join("\n"));
		const terminal = JSON.parse(execFileSync("python3", [validator,
			fileURLToPath(new URL("./verify-candidate-artifacts.py", import.meta.url)),
			join(consumer, "node_modules/.bin/diffex")], { encoding: "utf8", env, cwd: consumer }));
		assert.deepEqual(terminal, [realpathSync(join(consumer, "node_modules/@diffexai/diffex/dist/cli.js")), realpathSync(consumer)]);
		const layout = globalManagerLayout("pnpm", consumer, env);
		assert.equal(layout.bin, env.PNPM_HOME);
		assert.match(layout.modules, /[\\/]pnpm[\\/]global[\\/]5[\\/]node_modules$/);
		writeFileSync(join(consumer, "node_modules/@diffexai/diffex/index.js"), "tampered");
		assert.throws(() => verifyInstalledConsumer(consumer, selected, records, root), /Installed bytes differ/);
		assert.throws(() => globalManagerLayout("unknown", consumer, env), /Unsupported/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("only opted-in npm runs the audited local dependency postinstall and preserves installed inventories", { timeout: 60000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-lifecycle-consumer-"));
	const original = { ...process.env };
	try {
		// This local fixture is the entire lifecycle audit: it only writes a marker
		// beside its own package files and reports isolation state, never credentials.
		const postinstall = [
			"const { writeFileSync } = require('node:fs');",
			"writeFileSync('postinstall-marker.json', JSON.stringify({",
			"  scriptsDisabled: process.env.npm_config_ignore_scripts === 'true',",
			"  home: process.env.HOME,",
			"  userconfig: process.env.npm_config_userconfig,",
			"  inheritedUppercaseIgnoreScripts: Object.hasOwn(process.env, 'NPM_CONFIG_IGNORE_SCRIPTS'),",
			"  inheritedCredentials: ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'OPENAI_API_KEY', 'DAYTONA_API_KEY', 'COREPACK_NPM_TOKEN'].some(key => Object.hasOwn(process.env, key)),",
			"}));",
		].join("\n");
		const packages = [
			{ name: "@diffexai/lifecycle-fixture", version: "1.2.3", scripts: { postinstall: "node postinstall.cjs" } },
			{ name: "@diffexai/diffex", version: "1.2.3", dependencies: { "@diffexai/lifecycle-fixture": "1.2.3" } },
		];
		const records = packages.map((pkg) => {
			const stage = join(root, pkg.name.split("/").pop(), "package");
			mkdirSync(stage, { recursive: true });
			const files = { "package.json": JSON.stringify(pkg), "postinstall.cjs": postinstall };
			const inventory = { files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") })) };
			for (const [path, bytes] of Object.entries({ ...files, "distribution-files.json": JSON.stringify(inventory) })) {
				writeFileSync(join(stage, path), bytes);
			}
			const filename = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
			execFileSync("tar", ["-czf", join(root, filename), "-C", dirname(stage), "package"]);
			return { ...pkg, filename, sha256: createHash("sha256").update(readFileSync(join(root, filename))).digest("hex") };
		});
		verifyTarballs(root, records, packages);
		process.env.npm_config_ignore_scripts = "true";
		process.env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
		process.env.npm_config_userconfig = "/private/credential.npmrc";
		for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "OPENAI_API_KEY", "DAYTONA_API_KEY", "COREPACK_NPM_TOKEN"])
			process.env[key] = "synthetic-private-credential";
		for (const [manager, enabled] of [["npm", false], ["npm", true], ["pnpm", false], ["bun", false]]) {
			const consumer = join(root, `${manager}-${enabled ? "enabled" : "default"}`);
			const env = enabled
				? installConsumer(consumer, manager, packages, records, root, join(consumer, "cache"), { lifecycleScripts: "enabled" })
				: installConsumer(consumer, manager, packages, records, root);
			const installed = join(consumer, "node_modules", packages[0].name);
			const marker = join(installed, "postinstall-marker.json");
			assert.equal(existsSync(marker), enabled, `${manager} dependency lifecycle execution must match the opt-in`);
			assert.equal(env.npm_config_ignore_scripts, undefined);
			assert.equal(env.NPM_CONFIG_IGNORE_SCRIPTS, undefined);
			if (enabled) {
				assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
					scriptsDisabled: false,
					home: env.HOME,
					userconfig: env.npm_config_userconfig,
					inheritedUppercaseIgnoreScripts: false,
					inheritedCredentials: false,
				});
				writeFileSync(join(installed, "postinstall.cjs"), "tampered");
				assert.throws(() => verifyInstalledConsumer(consumer, packages, records, root), /Installed bytes differ/);
				writeFileSync(join(installed, "postinstall.cjs"), postinstall);
			}
			verifyInstalledConsumer(consumer, packages, records, root);
		}
		verifyTarballs(root, records, packages);
	} finally {
		process.env = original;
		rmSync(root, { recursive: true, force: true });
	}
});

test("npm seeds the reviewed shrinkwrap graph instead of resolving a newer transitive version", { timeout: 30000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-seeded-consumer-"));
	let server;
	try {
		const pack = (manifest, extra = {}) => {
			const stage = join(root, `stage-${manifest.name.replaceAll("/", "-")}-${manifest.version}`, "package");
			mkdirSync(stage, { recursive: true });
			const files = { "package.json": JSON.stringify(manifest), ...extra };
			const inventory = { files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") })) };
			for (const [path, bytes] of Object.entries({ ...files, "distribution-files.json": JSON.stringify(inventory) })) writeFileSync(join(stage, path), bytes);
			const filename = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
			execFileSync("tar", ["-czf", join(root, filename), "-C", dirname(stage), "package"]);
			const bytes = readFileSync(join(root, filename));
			return { ...manifest, filename, sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
		};
		const reviewed = pack({ name: "@fixture/reviewed", version: "1.0.0", scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('hook-ran', '')\"" } });
		const newer = pack({ name: "@fixture/reviewed", version: "1.1.0" });
		writeFileSync(join(root, "registry.cjs"), [
			"const fs = require('node:fs'), http = require('node:http');",
			`const reviewed = ${JSON.stringify(reviewed)}, newer = ${JSON.stringify(newer)};`,
			"const server = http.createServer((req, res) => {",
			"  const base = 'http://127.0.0.1:' + server.address().port;",
			"  const entry = [reviewed, newer].find(pkg => req.url === '/' + pkg.filename);",
			"  if (entry) return res.end(fs.readFileSync(entry.filename));",
			"  if (decodeURIComponent(req.url) !== '/@fixture/reviewed') return res.writeHead(404).end();",
			"  res.setHeader('content-type', 'application/json');",
			"  res.end(JSON.stringify({name: newer.name, 'dist-tags': {latest: newer.version}, versions: Object.fromEntries([reviewed, newer].map(pkg => [pkg.version, {...pkg, dist: {tarball: base + '/' + pkg.filename, integrity: pkg.integrity}}]))}));",
			"});",
			"server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
		].join("\n"));
		server = spawn(process.execPath, [join(root, "registry.cjs")], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
		const [ready] = await once(server.stdout, "data");
		const registry = `http://127.0.0.1:${Number(ready.toString().trim())}`;
		const manifest = { name: "@diffexai/diffex", version: "1.2.3", dependencies: { "@fixture/reviewed": "^1.0.0" } };
		const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: {
			"": structuredClone(manifest),
			"node_modules/@fixture/reviewed": { version: reviewed.version, resolved: `${registry}/${reviewed.filename}`, integrity: reviewed.integrity, hasInstallScript: true },
		} };
		const record = pack(manifest, { "npm-shrinkwrap.json": JSON.stringify(lock) });
		const unseeded = join(root, "unseeded");
		const env = isolatedEnvironment(unseeded);
		writeFileSync(join(unseeded, "package.json"), JSON.stringify({ private: true, dependencies: { [manifest.name]: `file:${join(root, record.filename)}` } }));
		execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`], { cwd: unseeded, env, stdio: "inherit", timeout: 10000 });
		const unseededRequire = createRequire(join(unseeded, "node_modules", manifest.name, "package.json"));
		assert.equal(unseededRequire("@fixture/reviewed/package.json").version, newer.version, "Unseeded local tarball installation must demonstrate actual resolver drift");
		const consumer = join(root, "seeded");
		installConsumer(consumer, "npm", [manifest], [record], root);
		const target = join(consumer, "node_modules", manifest.name);
		const reviewedRoot = join(target, "node_modules/@fixture/reviewed");
		assert.equal(JSON.parse(readFileSync(join(reviewedRoot, "package.json"), "utf8")).version, reviewed.version);
		assert(!existsSync(join(reviewedRoot, "hook-ran")), "Scripts-disabled proof must not run the reviewed fixture hook");
		const installedLock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
		assert.equal(installedLock.packages[`node_modules/${manifest.name}`].hasShrinkwrap, true);
		assert.equal(installedLock.packages[`node_modules/${manifest.name}`].integrity, record.integrity);
		assert.equal(installedLock.packages[`node_modules/${manifest.name}/node_modules/@fixture/reviewed`].version, reviewed.version);
		assert.equal(installedLock.packages[""].dependencies[manifest.name], `file:${join(root, record.filename)}`);
		// A verified archive is not sufficient if its shrinkwrap describes a different manifest.
		lock.packages[""].dependencies = { "@fixture/reviewed": "^2.0.0" };
		const invalid = pack(manifest, { "npm-shrinkwrap.json": JSON.stringify(lock) });
		assert.throws(() => installConsumer(join(root, "invalid"), "npm", [manifest], [invalid], root), /shrinkwrap dependencies mismatch/);
		assert.throws(() => installConsumer(join(root, "tampered"), "npm", [manifest], [{ ...invalid, sha256: "0".repeat(64) }], root), /Tarball checksum mismatch/);
	} finally {
		if (server) {
			const closed = once(server, "close");
			server.kill("SIGKILL");
			await closed;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

for (const mode of ["success", "failure", "timeout"]) {
	test(`script-enabled npm synchronously stops background lifecycle groups on ${mode} before returning`, { timeout: 15000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), "diffex-lifecycle-group-"));
		const pidFiles = [join(root, "background.pid"), join(root, "hook.pid")];
		const trigger = join(root, "trigger");
		const marker = join(root, "late-write");
		try {
			const background = [
				"const fs = require('node:fs');",
				"process.on('SIGTERM', () => {});",
				`fs.writeFileSync(${JSON.stringify(pidFiles[0])}, String(process.pid));`,
				`setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(marker)}, 'survived'); }, 10);`,
			].join("\n");
			const hook = [
				"const fs = require('node:fs'), assert = require('node:assert/strict');",
				"for (const name of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'OPENAI_API_KEY', 'DAYTONA_API_KEY']) assert.equal(process.env[name], undefined);",
				`fs.writeFileSync(${JSON.stringify(pidFiles[1])}, String(process.pid));`,
				`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(background)}], { stdio: 'ignore' }).unref();`,
				"const ready = setInterval(() => {",
				`if (!fs.existsSync(${JSON.stringify(pidFiles[0])})) return;`,
				"clearInterval(ready);",
				mode === "failure" ? "process.exit(23);" : "",
				mode === "timeout" ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);" : "",
				"}, 10);",
			].join("\n");
			const pkg = { name: "@diffexai/diffex", version: "1.2.3", scripts: { postinstall: "node hook.cjs" } };
			const files = { "package.json": JSON.stringify(pkg), "hook.cjs": hook };
			const inventory = { files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") })) };
			const stage = join(root, "package");
			mkdirSync(stage);
			for (const [path, bytes] of Object.entries({ ...files, "distribution-files.json": JSON.stringify(inventory) })) writeFileSync(join(stage, path), bytes);
			const filename = "diffexai-diffex-1.2.3.tgz";
			execFileSync("tar", ["-czf", join(root, filename), "-C", root, "package"]);
			const record = { ...pkg, filename, sha256: createHash("sha256").update(readFileSync(join(root, filename))).digest("hex") };
			const consumer = join(root, "consumer");
			const started = Date.now();
			const install = () => installConsumer(consumer, "npm", [pkg], [record], root, join(root, "cache"), {
				lifecycleScripts: "enabled", timeoutMilliseconds: mode === "timeout" ? 2000 : 10000,
			});
			if (mode === "success") install();
			else assert.throws(install, mode === "timeout" ? /ETIMEDOUT/ : /npm installation exited with/);
			assert(Date.now() - started < 12000, "Installation and group cleanup must remain bounded");
			for (const file of pidFiles) {
				assert(existsSync(file), "Regression must reach the actual lifecycle hook and its descendant");
				const pid = Number(readFileSync(file, "utf8"));
				try {
					process.kill(pid, 0);
					let state;
					try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
					catch (error) { if (error.status !== 1) throw error; }
					if (state) assert(state.startsWith("Z") || (process.platform === "darwin" && state.includes("E")), `Lifecycle process must be terminated or exiting, not running: ${state}`);
				} catch (error) { if (error.code !== "ESRCH") throw error; }
			}
			writeFileSync(trigger, "installation already returned");
			await delay(100);
			assert(!existsSync(marker), "No lifecycle descendant may write after synchronous return");
		} finally {
			for (const file of pidFiles) {
				if (!existsSync(file)) continue;
				try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); }
				catch (error) { if (error.code !== "ESRCH") throw error; }
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("lifecycle modes reject invalid options and unsupported managers before creating or executing a consumer", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-lifecycle-modes-"));
	try {
		const consumer = join(root, "consumer");
		for (const lifecycleScripts of [true, false, null, "enable", "", 1]) {
			assert.throws(() => installConsumer(consumer, "npm", [], [], root, join(root, "cache"), { lifecycleScripts }), /Invalid lifecycle scripts mode/);
		}
		for (const options of [null, true, "enabled", []]) {
			assert.throws(() => installConsumer(consumer, "npm", [], [], root, join(root, "cache"), options), /Invalid installation options/);
		}
		assert.throws(() => installConsumer(consumer, "npm", [], [], root, join(root, "cache"), { ignoreScripts: false }), /Unsupported installation option/);
		for (const manager of ["pnpm", "bun"]) {
			assert.throws(() => installConsumer(consumer, manager, [], [], root, join(root, "cache"), { lifecycleScripts: "enabled" }), /supported only for npm/);
		}
		for (const timeoutMilliseconds of [0, -1, NaN, Infinity, "600", null, 1.5, 600001]) {
			assert.throws(() => installConsumer(consumer, "npm", [], [], root, join(root, "cache"), { lifecycleScripts: "enabled", timeoutMilliseconds }), /Invalid installation timeoutMilliseconds/);
		}
		assert.throws(() => installConsumer(consumer, "npm", [], [], root, join(root, "cache"), { timeoutMilliseconds: 100 }), /Custom timeout requires script-enabled npm/);
		assert(!existsSync(consumer), "Rejected options must not create a consumer or execute its package manager");
		assert(!existsSync(join(root, "cache")), "Rejected options must not initialize caches");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package manager selection is a fixed allowlist and invalid package paths fail before execution", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-artifact-install-"));
	try {
		assert.throws(() => installConsumer(join(root, "consumer"), "node --eval malicious", [], [], root), /Unsupported package manager/);
		assert.throws(() => installConsumer(join(root, "consumer"), "npm", [{ name: "../../outside" }], [], root), /Invalid package name/);
		const pkg = { name: "@diffexai/example", version: "1.0.0" };
		assert.throws(() => verifyTarballs(root, [{ ...pkg, filename: "../outside.tgz" }], [pkg]), /Invalid tarball filename/);
		assert.equal(resolveArtifactDirectory(resolve(root, "consumer")), join(root, "consumer"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
