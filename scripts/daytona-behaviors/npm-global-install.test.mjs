import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { validateNpmGlobalInstallations } from "./npm-global-install.mjs";

const COMMIT = "a".repeat(40);
const PUBLIC_COMMIT = "b".repeat(40);
const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "@diffexai/diffex";
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function archive(root, version, commit, { tamper = false, hook = "", lockFault, lockedRanges = false } = {}) {
	const stage = join(root, version, "package");
	mkdirSync(stage, { recursive: true });
	// Reviewed local-only hook: write a package-local marker, reject inherited
	// credentials/config, and optionally corrupt a checked file for the failure test.
	// Local-only package identities model the two reviewed dependency hooks.
	// Their synthetic code exercises failures/isolation without registry access.
	const dependencies = {};
	const lockedPackages = {};
	for (const [name, dependencyVersion, scripts, contents] of [
		["@google/genai", "2.31.0", { preinstall: "echo 'preinstall: no-op'" }, {}],
		["protobufjs", "7.6.5", { postinstall: "node scripts/postinstall" }, { "scripts/postinstall.js": [
			"const assert = require('node:assert/strict');",
			"const fs = require('node:fs');",
			"for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'DAYTONA_API_KEY', 'OPENAI_API_KEY', 'NPM_CONFIG_IGNORE_SCRIPTS']) assert.equal(process.env[key], undefined);",
			"assert.notEqual(process.env.npm_config_ignore_scripts, 'true');",
			"fs.writeFileSync('lifecycle-marker', 'postinstall executed');",
			tamper ? "fs.appendFileSync(require('node:path').join(__dirname, '../../../cli.cjs'), '\\n// postinstall tampering\\n');" : "",
			hook,
		].join("\n") }],
	]) {
		const directory = join(root, version, name.replaceAll("/", "-"));
		for (const [path, bytes] of Object.entries({ "package.json": JSON.stringify({ name, version: dependencyVersion, scripts }), ...contents })) {
			mkdirSync(dirname(join(directory, "package", path)), { recursive: true });
			writeFileSync(join(directory, "package", path), bytes);
		}
		const archive = `${directory}.tgz`;
		execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
		dependencies[name] = lockedRanges ? `^${dependencyVersion}` : `file:${archive}`;
		lockedPackages[`node_modules/${name}`] = { version: dependencyVersion, resolved: `file:${archive}`,
			integrity: `sha512-${digest(readFileSync(archive), "sha512", "base64")}`, hasInstallScript: true };
	}
	const manifest = { name: PACKAGE, version, dependencies, bin: { diffex: "cli.cjs" } };
	const shrinkwrap = { name: PACKAGE, version, lockfileVersion: 3, packages: { "": { name: PACKAGE, version, dependencies }, ...lockedPackages } };
	if (lockFault === "name") shrinkwrap.name = "unreviewed";
	if (lockFault === "version") shrinkwrap.version = "1.0.0";
	if (lockFault === "root") shrinkwrap.packages[""].version = "1.0.0";
	if (lockFault === "dependencies") shrinkwrap.packages[""] = { ...shrinkwrap.packages[""], dependencies: {} };
	if (lockFault === "schema") shrinkwrap.lockfileVersion = 2;
	const files = {
		"package.json": JSON.stringify(manifest),
		...(lockFault === "missing" ? {} : { "npm-shrinkwrap.json": JSON.stringify(shrinkwrap) }),
		"cli.cjs": [
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"if (!fs.existsSync(path.join(path.dirname(require.resolve('protobufjs/package.json')), 'lifecycle-marker'))) throw new Error('postinstall did not execute');",
			`if (process.argv[2] === '--version') console.log('${version}');`,
			"else if (process.argv[2] === '--help') console.log('Diffex local fixture');",
			"else if (process.argv[2] === '--list-models') console.log('fixture-model '.repeat(12));",
			"else process.exit(1);",
		].join("\n"),
	};
	const inventory = { sourceCommit: commit, algorithm: "sha256", files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: digest(bytes) })) };
	for (const [path, bytes] of Object.entries({ ...files, "distribution-files.json": JSON.stringify(inventory) }))
		writeFileSync(join(stage, path), bytes, { mode: 0o755 });
	const filename = `diffexai-diffex-${version}.tgz`;
	const path = join(root, filename);
	execFileSync("tar", ["-czf", path, "-C", dirname(stage), "package"]);
	const bytes = readFileSync(path);
	return { name: PACKAGE, version, filename, sha256: digest(bytes), integrity: `sha512-${digest(bytes, "sha512", "base64")}`, bytes, path };
}

async function fixture(options, run) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "diffex-global-test-")));
	const original = { ...process.env };
	const listeners = ["SIGTERM", "SIGINT"].map((signal) => process.listenerCount(signal));
	const pidFile = join(root, "background.pid");
	const hookPidFile = join(root, "hook.pid");
	const trigger = join(root, "trigger-background");
	const marker = join(root, "late-marker");
	try {
		// Synthetic local background hook ignores TERM and writes only after the
		// test releases a barrier AFTER validation. SIGKILL must prevent that write.
		const background = [
			"const fs = require('node:fs');",
			"process.on('SIGTERM', () => {});",
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			`setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(marker)}, 'survived'); }, 10);`,
		].join("\n");
		const hook = options.background ? [
			"const { spawn } = require('node:child_process');",
			`fs.writeFileSync(${JSON.stringify(hookPidFile)}, String(process.pid));`,
			`spawn(process.execPath, ['-e', ${JSON.stringify(background)}], { stdio: 'ignore' }).unref();`,
			"const ready = setInterval(() => {",
			`  if (!fs.existsSync(${JSON.stringify(pidFile)})) return;`,
			"  clearInterval(ready);",
			options.background === "hang" ? "  process.on('SIGTERM', () => {}); setInterval(() => {}, 100);" : "",
			options.background === "fail" ? "  process.exit(23);" : "",
			options.background === "overflow" ? "  process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 'x')); setInterval(() => {}, 100);" : "",
			"}, 10);",
		].join("\n") : "";
		const hookFile = join(root, "synthetic-hook.cjs");
		writeFileSync(hookFile, `const fs = require('node:fs');\n${hook}`);
		const candidate = archive(root, "0.0.3", COMMIT, { tamper: options.tamper, hook, lockFault: options.lockFault, lockedRanges: options.lockedRanges });
		const published = archive(root, "0.4.0", PUBLIC_COMMIT);
		const { bytes: _bytes, path: _path, ...record } = candidate;
		writeFileSync(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, version: candidate.version, source: { commit: COMMIT }, packages: [record] }));
		const realNpm = realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
		const bin = join(root, "bin");
		mkdirSync(bin);
		// Candidate uses the real scoped loopback registry. Only public npm is
		// substituted with its local fixture archive; all other registry access is blocked.
		writeFileSync(join(bin, "npm"), [
			`#!${process.execPath}`,
			"const { execFileSync } = require('node:child_process');",
			"const fs = require('node:fs');",
			"const args = process.argv.slice(2);",
			"process.env.npm_config_registry = 'http://127.0.0.1:9'; process.env.npm_config_fetch_retries = '0';",
			options.ignoreScripts ? "if (args.join(' ') === 'config get ignore-scripts') { console.log('true'); process.exit(0); }" : "",
			options.background === "overflow" ? `if (args[0] === 'i') { execFileSync(process.execPath, [${JSON.stringify(hookFile)}], { stdio: 'inherit' }); process.exit(0); }` : "",
			`if (args.join(' ') === 'i -g ${PACKAGE}' && !fs.readFileSync(process.env.npm_config_userconfig, 'utf8').includes('@diffexai:registry=')) args[2] = ${JSON.stringify(options.wrongPublicVersion ? candidate.path : published.path)};`,
			options.skipLifecycle ? "if (args[0] === 'i') args.push('--ignore-scripts');" : "",
			options.stderrSecret ? "if (args[0] === 'i') { console.error('synthetic-private-value'); process.exit(23); }" : "",
			`try { execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(realNpm)}, ...args], { env: process.env, stdio: 'inherit' }); }`,
			"catch (error) { process.exit(error.status || 1); }",
			options.logFault ? [
				"if (args[0] === 'i') {",
				"const fs = require('node:fs'), path = require('node:path');",
				"const directory = path.join(process.env.npm_config_cache, '_logs');",
				"for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.log'))) {",
				"const file = path.join(directory, name); let text = fs.readFileSync(file, 'utf8');",
				options.logFault === "missing" ? "text = text.split('\\n').filter(line => !line.includes('info run protobufjs@7.6.5 postinstall {')).join('\\n');" : "",
				options.logFault === "failed" ? "text = text.replace(/(info run protobufjs@7.6.5 postinstall \\{ code: )0/, '$123');" : "",
				options.logFault === "command" ? "text = text.replace(/(info run protobufjs@7.6.5 postinstall .* )node scripts\\/postinstall/, '$1node changed');" : "",
				options.logFault === "version" ? "text = text.replaceAll('protobufjs@7.6.5', 'protobufjs@7.6.6');" : "",
				options.logFault === "extra" ? "text += '\\n999 info run unreviewed@1.0.0 install node_modules/unreviewed node hook.js\\n';" : "",
				options.logFault === "secret" ? "text += '\\n999 silly ignored synthetic-private-value\\n'; for (const name of ['auth.json', '.npmrc', '.netrc', '.env']) fs.writeFileSync(path.join(directory, name), 'synthetic-private-value');" : "",
				options.logFault === "duplicate" ? "text += '\\n999 info run protobufjs@7.6.5 postinstall node_modules/protobufjs node scripts/postinstall\\n';" : "",
				options.logFault === "oversized" ? "text += 'x'.repeat(4 * 1024 * 1024);" : "",
				"fs.writeFileSync(file, text); } }",
			].join("\n") : "",
		].join("\n"), { mode: 0o755 });
		process.env.PATH = `${bin}:${original.PATH}`;
		process.env.npm_config_ignore_scripts = "true";
		process.env.NPM_CONFIG_IGNORE_SCRIPTS = "true";
		process.env.npm_config_userconfig = "/private/credentials.npmrc";
		for (const key of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "DAYTONA_API_KEY", "OPENAI_API_KEY"])
			process.env[key] = "synthetic-private-value";
		let latestCalls = 0;
		const requests = [];
		const request = async (url, init) => {
			if (options.fetchSignal) return new Promise((resolve, reject) => {
				const timer = setTimeout(() => process.emit(options.fetchSignal), 20);
				init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
			});
			if (options.slowFetch) return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Fetch escaped shared deadline")), 1000);
				init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
			});
			assert.equal(init.redirect, "error");
			assert(init.signal instanceof AbortSignal);
			requests.push(url);
			if (url === `${REGISTRY}/${encodeURIComponent(PACKAGE)}/latest`) {
				latestCalls++;
				const version = options.moveAt && latestCalls >= options.moveAt ? "0.4.1" : published.version;
				return Response.json({ name: PACKAGE, version, dist: {
					tarball: options.untrustedUrl ?? `${REGISTRY}/${PACKAGE}/-/diffex-${version}.tgz`,
					integrity: options.badSri ? candidate.integrity : published.integrity,
				} });
			}
			assert.equal(url, `${REGISTRY}/${PACKAGE}/-/diffex-${published.version}.tgz`);
			if (options.oversized) return { status: 200, body: (async function* () { yield { length: 256 * 1024 * 1024 + 1 }; })() };
			return new Response(published.bytes, { status: options.redirect ? 302 : 200 });
		};
		const output = join(root, "evidence");
		await run({ root, candidate, published, request, output, requests, pidFile, hookPidFile, trigger, marker });
		const reportPath = join(output, "npm-global-installation.json");
		if (existsSync(reportPath)) {
			for (const entry of readJson(reportPath).entries) {
				if (entry.registryUrl) {
					assert.equal(entry.registryClosed, true);
					await assert.rejects(fetch(entry.registryUrl), "Candidate registry must not accept connections after success, failure or abort");
				}
			}
		}
		assert.deepEqual(["SIGTERM", "SIGINT"].map((signal) => process.listenerCount(signal)), listeners, "Validator must unregister signal handlers");
	} finally {
		for (const path of [pidFile, hookPidFile]) {
			if (!existsSync(path)) continue;
			try { process.kill(Number(readFileSync(path, "utf8")), "SIGKILL"); }
			catch (error) { if (error.code !== "ESRCH") throw error; }
		}
		process.env = original;
		rmSync(root, { recursive: true, force: true });
	}
}

function assertClean(report) {
	assert.equal(report.cleanup, true);
	for (const entry of report.entries) {
		if (entry.resolvedExecutable) assert(!existsSync(entry.resolvedExecutable), "Temporary global prefix survived cleanup");
	}
}

test("normal global npm runs local lifecycle hooks, resolves bare PATH, and independently verifies candidate and public inventories", { timeout: 30000 }, async () => {
	await fixture({}, async ({ root, candidate, published, request, output }) => {
		const report = await validateNpmGlobalInstallations(root, COMMIT, output, { request });
		assert.deepEqual(report, readJson(join(output, "npm-global-installation.json")));
		assert.equal(report.status, "passed");
		assert.equal(report.publicCommand, "npm i -g @diffexai/diffex");
		assert.equal(report.timeoutMilliseconds, 600000);
		assert.equal(report.cleanupGraceMilliseconds, 1000);
		assert.equal(report.aborted, null);
		assert.deepEqual(report.entries.map((entry) => [entry.kind, entry.version, entry.inventorySourceCommit]), [
			["candidate", "0.0.3", COMMIT], ["public", "0.4.0", PUBLIC_COMMIT],
		]);
		for (const entry of report.entries) {
			assert.equal(entry.scripts, "enabled");
			assert.equal(entry.ignoreScripts, "false");
			assert.equal(entry.coldCache, true);
			assert.equal(entry.installedInventory, "passed");
			assert.equal(entry.lifecycleExecution, "passed");
			assert.deepEqual(entry.lifecycleHooks, [
				{ packageId: "@google/genai@2.31.0", hook: "preinstall", exitCode: 0, signal: null },
				{ packageId: "protobufjs@7.6.5", hook: "postinstall", exitCode: 0, signal: null },
			]);
			assert.equal(entry.status, "passed");
		}
		assert.deepEqual(report.commands.filter((item) => item.args[0] === "i").map((item) => item.args), [
			["i", "-g", PACKAGE], ["i", "-g", PACKAGE],
		]);
		assert.equal(report.entries[0].shrinkwrap, "validated");
		assert.equal(report.entries[0].transport, "scoped-loopback-registry");
		assert(report.entries[0].archiveRequests > 0);
		assert.equal(report.entries[0].integrity, candidate.integrity);
		assert.equal(report.entries[1].transport, undefined, "Public path must not inherit candidate registry transport");
		assert.equal(report.entries[1].registryUrl, undefined);
		assert(report.commands.every((item) => item.exitCode === 0 && !item.args.some((arg) => arg.startsWith("--ignore-scripts"))));
		assert.deepEqual(report.commands.filter((item) => item.command === "diffex").map((item) => item.args), [
			["--version"], ["--help"], ["--list-models"], ["--version"], ["--help"], ["--list-models"],
		]);
		assert.equal(report.entries[1].integrity, published.integrity);
		assertClean(report);
	});
});

test("candidate registry metadata preserves its embedded shrinkwrap with semver dependencies and external registry blocked", { timeout: 30000 }, async () => {
	await fixture({ lockedRanges: true }, async ({ root, request, output }) => {
		const report = await validateNpmGlobalInstallations(root, COMMIT, output, { request });
		assert.equal(report.status, "passed");
		assert.equal(report.entries[0].shrinkwrap, "validated");
		assert(report.entries[0].archiveRequests > 0);
		assert.deepEqual(report.entries[0].lifecycleHooks.map((event) => event.packageId), ["@google/genai@2.31.0", "protobufjs@7.6.5"]);
		assertClean(report);
	});
});

test("global npm retains only reviewed hook metadata, not raw logs, auth files or credentials", { timeout: 30000 }, async () => {
	for (const options of [{ logFault: "secret" }, { stderrSecret: true }]) {
		await fixture(options, async ({ root, request, output }) => {
			if (options.stderrSecret) await assert.rejects(validateNpmGlobalInstallations(root, COMMIT, output, { request }), /exited with/);
			else await validateNpmGlobalInstallations(root, COMMIT, output, { request });
			assert.deepEqual(readdirSync(output), ["npm-global-installation.json"], "Never publish npm logs or auth/config files");
			const text = readFileSync(join(output, "npm-global-installation.json"), "utf8");
			assert(!text.includes("synthetic-private-value"), "Redact before the first report write");
			const report = JSON.parse(text);
			if (options.stderrSecret) assert.equal(report.commands.at(-1).stderr.trim(), "[REDACTED]");
			else assert(report.entries.every((entry) => entry.lifecycleHooks.length === 2));
			assertClean(report);
		});
	}
});

function assertStopped(path) {
	assert(existsSync(path), "Synthetic lifecycle descendant must have started");
	const pid = Number(readFileSync(path, "utf8"));
	try { process.kill(pid, 0); }
	catch (error) { if (error.code === "ESRCH") return; throw error; }
	try {
		const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
		// Linux init may retain an already terminated orphan as a zombie.
		assert.match(state, /^Z/, `Lifecycle process ${pid} is still running`);
	} catch (error) { if (error.status !== 1) throw error; }
}

for (const [mode, pattern] of [["hang", /timed out|shared time budget/], ["fail", /exited with/], ["overflow", /output exceeds size limit/], ["success", null]]) {
	test(`global npm terminates background lifecycle groups on ${mode} before cleanup`, { timeout: 15000 }, async () => {
		await fixture({ background: mode }, async ({ root, request, output, pidFile, hookPidFile, trigger, marker }) => {
			const started = Date.now();
			const validation = validateNpmGlobalInstallations(root, COMMIT, output, { request, timeoutMilliseconds: mode === "hang" ? 2500 : 10000 });
			if (pattern) await assert.rejects(validation, pattern);
			else await validation;
			const report = readJson(join(output, "npm-global-installation.json"));
			assert.equal(report.status, pattern ? "failed" : "passed");
			assertClean(report);
			assertStopped(pidFile);
			assertStopped(hookPidFile);
			writeFileSync(trigger, "validation already returned");
			await delay(100);
			assert(!existsSync(marker), "Killed lifecycle child must not write after validation/cleanup");
			if (mode === "hang") {
				assert(Date.now() - started < 5000, "Shared timeout plus cleanup grace must bound the whole validation");
				assert.equal(report.commands.at(-1).args[0], "i", "Timeout must exercise the actual local dependency hook");
			}
		});
	});
}

for (const signal of ["SIGTERM", "SIGINT"]) {
	test(`global npm handles ${signal} by terminating its active command group and persisting failure cleanup`, { timeout: 15000 }, async () => {
		await fixture({ background: "hang" }, async ({ root, published, output, pidFile, hookPidFile, trigger, marker }) => {
			const runner = join(root, "signal-runner.mjs");
			writeFileSync(runner, [
				`import { validateNpmGlobalInstallations } from ${JSON.stringify(new URL("./npm-global-install.mjs", import.meta.url).href)};`,
				"import { readFileSync } from 'node:fs';",
				`const metadata = ${JSON.stringify({ name: PACKAGE, version: published.version, dist: { tarball: `${REGISTRY}/${PACKAGE}/-/diffex-${published.version}.tgz`, integrity: published.integrity } })};`,
				`const request = async url => url.endsWith('/latest') ? Response.json(metadata) : new Response(readFileSync(${JSON.stringify(published.path)}));`,
				`await validateNpmGlobalInstallations(${JSON.stringify(root)}, ${JSON.stringify(COMMIT)}, ${JSON.stringify(output)}, { request });`,
			].join("\n"));
			const child = spawn(process.execPath, [runner], { detached: true, stdio: "ignore", env: process.env });
			const closed = once(child, "close");
			try {
				const deadline = Date.now() + 5000;
				while (!existsSync(pidFile) && Date.now() < deadline) await delay(10);
				assert(existsSync(pidFile), "Signal regression must reach the local lifecycle hook");
				process.kill(-child.pid, signal);
				const [status, exitSignal] = await closed;
				assert.equal(status, 1, "Handled signal should reject validation after finally, not kill Node");
				assert.equal(exitSignal, null);
				const report = readJson(join(output, "npm-global-installation.json"));
				assert.equal(report.status, "failed");
				assert.match(report.error, new RegExp(`aborted by ${signal}`));
				assert.equal(report.aborted, signal);
				assertClean(report);
				assertStopped(pidFile);
				assertStopped(hookPidFile);
				writeFileSync(trigger, "validator signal cleanup completed");
				await delay(100);
				assert(!existsSync(marker));
			} finally {
				if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
				await closed;
			}
		});
	});

	test(`global npm ${signal} abort cancels an active registry fetch and removes handlers`, { timeout: 3000 }, async () => {
		await fixture({ fetchSignal: signal }, async ({ root, request, output }) => {
			await assert.rejects(validateNpmGlobalInstallations(root, COMMIT, output, { request }), new RegExp(`aborted by ${signal}`));
			const report = readJson(join(output, "npm-global-installation.json"));
			assert.equal(report.status, "failed");
			assertClean(report);
			assert.deepEqual(report.commands, []);
			assert.equal(report.aborted, signal);
		});
	});
}

test("global npm shares its deadline with registry downloads and rejects invalid budgets before initialization", { timeout: 3000 }, async () => {
	await fixture({ slowFetch: true }, async ({ root, request, output }) => {
		for (const timeoutMilliseconds of [0, -1, NaN, Infinity, "600", null, 1.5, 600001]) {
			await assert.rejects(validateNpmGlobalInstallations(root, COMMIT, output, { request, timeoutMilliseconds }), /Invalid global npm timeoutMilliseconds/);
		}
		assert(!existsSync(output), "Invalid budgets must fail before creating evidence/prefixes");
		await assert.rejects(validateNpmGlobalInstallations(root, COMMIT, output, { request, timeoutMilliseconds: 50 }), /timeout|time budget/i);
		const report = readJson(join(output, "npm-global-installation.json"));
		assert.equal(report.status, "failed");
		assert.equal(report.timeoutMilliseconds, 50);
		assertClean(report);
		assert.deepEqual(report.commands, []);
	});
});

for (const [name, options, pattern] of [
	["untrusted tarball URL", { untrustedUrl: "https://attacker.invalid/package.tgz" }, /Noncanonical public tarball/],
	["registry redirect", { redirect: true }, /Registry request failed/],
	["tarball SRI mismatch", { badSri: true }, /SRI mismatch/],
	["oversized registry tarball", { oversized: true }, /exceeds size limit/],
	["hidden scripts-disabled config", { ignoreScripts: true }, /requires scripts enabled by default/],
	["lifecycle modification of inventoried bytes", { tamper: true }, /Installed bytes differ/],
	["latest movement before installation", { moveAt: 2 }, /latest moved before installation/],
	["latest movement after installation", { moveAt: 3 }, /latest moved during installation/],
	["installed public version differs from checked latest", { wrongPublicVersion: true }, /Installed latest moved/],
	["scripts enabled in config but hooks did not execute", { skipLifecycle: true }, /Missing or duplicate reviewed npm lifecycle execution/],
	["missing hook completion", { logFault: "missing" }, /Missing or duplicate reviewed npm lifecycle execution/],
	["failed hook completion", { logFault: "failed" }, /Reviewed npm lifecycle hook failed/],
	["changed hook command", { logFault: "command" }, /Reviewed npm lifecycle command changed/],
	["unreviewed hook version", { logFault: "version" }, /Unreviewed npm lifecycle/],
	["additional unreviewed hook", { logFault: "extra" }, /Unreviewed npm lifecycle/],
	["duplicate hook start", { logFault: "duplicate" }, /Missing or duplicate reviewed npm lifecycle execution|completion lacks a unique start/],
	["oversized lifecycle log", { logFault: "oversized" }, /Invalid or oversized npm debug log/],
	...["missing", "name", "version", "root", "dependencies", "schema"].map((lockFault) =>
		[`invalid candidate shrinkwrap ${lockFault}`, { lockFault }, /[Cc]andidate shrinkwrap/]),
]) {
	test(`global npm fails closed on ${name} and records positive cleanup`, { timeout: 30000 }, async () => {
		await fixture(options, async ({ root, request, output }) => {
			await assert.rejects(validateNpmGlobalInstallations(root, COMMIT, output, { request }), pattern);
			const report = readJson(join(output, "npm-global-installation.json"));
			assert.equal(report.status, "failed");
			assert.match(report.error, pattern);
			assertClean(report);
			if (options.ignoreScripts || options.badSri || options.untrustedUrl || options.redirect || options.oversized || options.lockFault)
				assert(!report.commands.some((item) => item.args[0] === "i"), "Rejected configuration must not execute installation");
			if (options.moveAt === 2)
				assert(!report.commands.some((item) => item.kind === "public" && item.args[0] === "i"));
		});
	});
}
