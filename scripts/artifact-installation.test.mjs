import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
