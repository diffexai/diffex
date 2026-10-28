import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { assertContained, globalManagerLayout, isolatedEnvironment, resolveArtifactDirectory, verifyTarballs } from "../artifact-installation.mjs";

const PACKAGE = "@diffexai/diffex";
const REGISTRY = "https://registry.npmjs.org";
const MAX_BYTES = 256 * 1024 * 1024;
const TIMEOUT_MILLISECONDS = 600000;
const CLEANUP_GRACE_MILLISECONDS = 1000;
const hash = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

// Every subprocess owns a POSIX group. Successful npm hooks may leave background
// children too: terminate the entire group and reap the direct child before return.
async function runProcess(command, args, { cwd, env, budget, maximum = 16 * 1024 * 1024, limit = Infinity }) {
	const timeout = Math.min(budget.remaining(), limit);
	const text = await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const stdout = [];
		const stderr = [];
		let size = 0;
		let failure;
		let status = null;
		let signal = null;
		let closed = false;
		let stopping = false;
		let terminated = false;
		const finish = () => {
			if (!closed || !terminated) return;
			budget.signal.removeEventListener("abort", abort);
			if (failure) {
				Object.assign(failure, { status, signal, stderr: Buffer.concat(stderr).toString("utf8") });
				reject(failure);
			} else resolve(Buffer.concat(stdout).toString("utf8"));
		};
		const kill = (name) => {
			if (!child.pid) return false;
			try {
				process.kill(-child.pid, name);
				return true;
			} catch (error) {
				if (error.code !== "ESRCH") {
					failure ??= error;
					child.kill("SIGKILL");
				}
				return false;
			}
		};
		const stop = () => {
			if (stopping) return;
			stopping = true;
			clearTimeout(timer);
			if (kill("SIGTERM")) {
				setTimeout(() => {
					kill("SIGKILL");
					child.stdout.destroy();
					child.stderr.destroy();
					terminated = true;
					finish();
				}, CLEANUP_GRACE_MILLISECONDS);
			} else {
				terminated = true;
				finish();
			}
		};
		const abort = () => { failure ??= budget.signal.reason; stop(); };
		const timer = setTimeout(() => {
			failure ??= new Error(`${command} timed out within the shared global npm validation budget`);
			stop();
		}, timeout);
		budget.signal.addEventListener("abort", abort, { once: true });
		for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
			stream.on("data", (chunk) => {
				if (failure) return;
				size += chunk.length;
				if (size > maximum) {
					failure = new Error(`${command} output exceeds size limit`);
					stop();
				} else chunks.push(chunk);
			});
			stream.on("error", (error) => { failure ??= error; stop(); });
		}
		child.on("error", (error) => { failure ??= error; stop(); });
		child.on("exit", (code, name) => {
			status = code;
			signal = name;
			if (code !== 0) failure ??= new Error(`${command} exited with ${code ?? name}`);
			stop();
		});
		// close follows exit/reaping and drained (or explicitly destroyed) pipes.
		child.on("close", () => { closed = true; finish(); });
	});
	budget.remaining();
	return text;
}

async function download(url, request, maximum, budget) {
	const signal = AbortSignal.any([budget.signal, AbortSignal.timeout(Math.min(30000, budget.remaining()))]);
	const response = await request(url, { redirect: "error", signal });
	assert.equal(response.status, 200, `Registry request failed: ${url}`);
	assert(response.body, "Registry response has no body");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		budget.remaining();
		size += chunk.length;
		assert(size <= maximum, "Registry response exceeds size limit");
		chunks.push(chunk);
	}
	budget.remaining();
	return Buffer.concat(chunks);
}

async function latest(request, budget) {
	const metadata = JSON.parse(await download(`${REGISTRY}/${encodeURIComponent(PACKAGE)}/latest`, request, 1024 * 1024, budget));
	assert.equal(metadata.name, PACKAGE);
	assert.match(metadata.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
	assert.equal(metadata.dist?.tarball, `${REGISTRY}/${PACKAGE}/-/diffex-${metadata.version}.tgz`, "Noncanonical public tarball URL");
	assert.match(metadata.dist.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
	return { name: PACKAGE, version: metadata.version, tarball: metadata.dist.tarball, integrity: metadata.dist.integrity };
}

function verifyFiles(directory, inventory, budget) {
	assert(Array.isArray(inventory.files) && inventory.files.length > 0, "Missing byte inventory");
	assert.equal(new Set(inventory.files.map((file) => file.path)).size, inventory.files.length, "Duplicate inventory paths");
	assert.deepEqual(json(join(directory, "distribution-files.json")), inventory, "Installed inventory differs from checked tarball");
	for (const file of inventory.files) {
		budget.remaining();
		assert(typeof file.path === "string" && !isAbsolute(file.path) && !file.path.split(/[\\/]/).some((part) => ["", ".", ".."].includes(part)), "Invalid inventory path");
		assert.match(file.sha256, /^[a-f0-9]{64}$/);
		const path = join(directory, file.path);
		assertContained(path, directory);
		assert.equal(hash(readFileSync(path)), file.sha256, `Installed bytes differ: ${file.path}`);
	}
}

async function inspectArchive(archive, directory, identity, env, budget) {
	mkdirSync(directory);
	const options = { env, budget, limit: 30000, maximum: 64 * 1024 * 1024 };
	const paths = (await runProcess("tar", ["-tzf", archive], options)).trim().split("\n");
	assert(paths.every((path) => path.startsWith("package/") && !path.includes("\\") && !path.split("/").includes("..")), "Unsafe archive path");
	const entries = (await runProcess("tar", ["-tvzf", archive], options)).trim().split("\n");
	assert(entries.every((entry) => entry.startsWith("-") || entry.startsWith("d")), "Archive links or special files are not allowed");
	await runProcess("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", directory], options);
	const root = join(directory, "package");
	const manifest = json(join(root, "package.json"));
	assert.equal(manifest.name, identity.name);
	assert.equal(manifest.version, identity.version);
	const inventory = json(join(root, "distribution-files.json"));
	assert.match(inventory.sourceCommit, /^[a-f0-9]{40}$/);
	verifyFiles(root, inventory, budget);
	return { manifest, inventory };
}

export async function validateNpmGlobalInstallations(artifacts, commit, output, { request = fetch, timeoutMilliseconds = TIMEOUT_MILLISECONDS } = {}) {
	assert(Number.isSafeInteger(timeoutMilliseconds) && timeoutMilliseconds > 0 && timeoutMilliseconds <= TIMEOUT_MILLISECONDS, "Invalid global npm timeoutMilliseconds");
	assert(process.platform !== "win32", "Global npm validation requires POSIX process groups");
	const controller = new AbortController();
	const deadline = performance.now() + timeoutMilliseconds;
	const budget = { signal: controller.signal, remaining: () => {
		controller.signal.throwIfAborted();
		const milliseconds = Math.ceil(deadline - performance.now());
		assert(milliseconds > 0, "Global npm validation exhausted its shared time budget");
		return milliseconds;
	} };
	assert.match(commit, /^[a-f0-9]{40}$/);
	artifacts = resolveArtifactDirectory(artifacts);
	output = resolveArtifactDirectory(output);
	mkdirSync(output, { recursive: true });
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "diffex-npm-global-")));
	const evidence = {
		schemaVersion: 1, sourceCommit: commit, node: process.version, platform: process.platform, arch: process.arch,
		timeoutMilliseconds, cleanupGraceMilliseconds: CLEANUP_GRACE_MILLISECONDS, aborted: null,
		publicCommand: "npm i -g @diffexai/diffex", status: "failed", cleanup: false, entries: [], commands: [],
	};
	const terminate = () => { evidence.aborted = "SIGTERM"; controller.abort(new Error("Global npm validation aborted by SIGTERM")); };
	const interrupt = () => { evidence.aborted = "SIGINT"; controller.abort(new Error("Global npm validation aborted by SIGINT")); };
	process.on("SIGTERM", terminate);
	process.on("SIGINT", interrupt);
	try {
		const manifest = json(join(artifacts, "manifest.json"));
		assert.equal(manifest.schemaVersion, 1);
		assert.equal(manifest.source.commit, commit);
		assert.equal(manifest.packages.length, 1);
		const candidate = manifest.packages[0];
		assert.equal(candidate.name, PACKAGE);
		assert.equal(candidate.version, manifest.version);
		verifyTarballs(artifacts, [candidate], [candidate]);
		const published = await latest(request, budget);
		const publicBytes = await download(published.tarball, request, MAX_BYTES, budget);
		assert.equal(`sha512-${hash(publicBytes, "sha512", "base64")}`, published.integrity, "Public tarball SRI mismatch");
		const publicArchive = join(temporary, "public.tgz");
		writeFileSync(publicArchive, publicBytes);
		for (const [kind, identity, archive] of [
			["candidate", candidate, join(artifacts, candidate.filename)],
			["public", { ...published, sha256: hash(publicBytes) }, publicArchive],
		]) {
			const directory = join(temporary, kind);
			const env = isolatedEnvironment(directory);
			const cwd = join(directory, "project");
			const { bin, packageRoot, executable } = globalManagerLayout("npm", directory, env);
			env.PATH = `${bin}:${env.PATH}`;
			const entry = { kind, name: identity.name, version: identity.version, sha256: identity.sha256,
				integrity: identity.integrity, tarball: kind === "public" ? published.tarball : candidate.filename,
				status: "failed", scripts: "enabled", ignoreScripts: null, coldCache: false, installedInventory: "unchecked" };
			evidence.entries.push(entry);
			const run = async (command, args) => {
				const record = { kind, command, args, exitCode: null };
				evidence.commands.push(record);
				try {
					const text = await runProcess(command, args, { cwd, env, budget });
					record.exitCode = 0;
					return text.trim();
				} catch (error) {
					record.exitCode = error.status ?? null;
					record.signal = error.signal;
					record.stderr = String(error.stderr ?? "").slice(-16384);
					throw error;
				}
			};
			const checked = await inspectArchive(archive, join(directory, "checked"), identity, env, budget);
			entry.inventorySourceCommit = checked.inventory.sourceCommit;
			if (kind === "candidate") assert.equal(checked.inventory.sourceCommit, commit);
			entry.npmVersion = await run("npm", ["--version"]);
			assert(entry.npmVersion.length > 0, "Missing npm identity");
			entry.ignoreScripts = await run("npm", ["config", "get", "ignore-scripts"]);
			assert.equal(entry.ignoreScripts, "false", "Normal npm installation requires scripts enabled by default");
			assert(!existsSync(join(env.npm_config_cache, "_cacache")), "Installation must start with a cold package cache");
			entry.coldCache = true;
			if (kind === "public") assert.deepEqual(await latest(request, budget), published, "Public latest moved before installation");
			await run("npm", ["i", "-g", kind === "public" ? PACKAGE : archive]);
			assertContained(packageRoot, directory);
			assert.equal(json(join(packageRoot, "package.json")).name, identity.name);
			assert.equal(json(join(packageRoot, "package.json")).version, identity.version, "Installed latest moved from checked public version");
			verifyFiles(packageRoot, checked.inventory, budget);
			entry.installedInventory = "passed";
			const target = checked.manifest.bin?.diffex;
			assert(typeof target === "string" && !isAbsolute(target), "Missing global diffex executable");
			assertContained(join(packageRoot, target), packageRoot);
			assert.equal(realpathSync(executable), realpathSync(join(packageRoot, target)));
			entry.resolvedExecutable = realpathSync(executable);
			assert.equal(await run("diffex", ["--version"]), identity.version);
			assert.match(await run("diffex", ["--help"]), /Diffex/);
			assert((await run("diffex", ["--list-models"])).length > 100, "Missing offline models");
			verifyFiles(packageRoot, checked.inventory, budget);
			if (kind === "public") assert.deepEqual(await latest(request, budget), published, "Public latest moved during installation");
			entry.status = "passed";
		}
		budget.remaining();
		evidence.status = "passed";
	} catch (error) {
		evidence.error = error.message;
		throw error;
	} finally {
		try {
			rmSync(temporary, { recursive: true, force: true });
			evidence.cleanup = !existsSync(temporary);
			assert(evidence.cleanup, "Global installation temporary prefix survived cleanup");
		} catch (error) {
			evidence.status = "failed";
			throw error;
		} finally {
			process.off("SIGTERM", terminate);
			process.off("SIGINT", interrupt);
			writeFileSync(join(output, "npm-global-installation.json"), `${JSON.stringify(evidence, null, 2)}\n`);
		}
	}
	return evidence;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [artifacts, commit, output] = process.argv.slice(2);
	assert(artifacts && commit && output, "Usage: npm-global-install.mjs ARTIFACTS COMMIT OUTPUT");
	await validateNpmGlobalInstallations(artifacts, commit, output);
}
