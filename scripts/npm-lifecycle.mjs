import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertPnpmVersion, globalManagerLayout, isolatedEnvironment } from "./artifact-installation.mjs";
import { verifyInstalledFiles } from "./public-release-acceptance.mjs";
import { createLifecycleRegistry } from "./npm-lifecycle-registry.mjs";
import { findNpmRecoveryDirectory } from "./npm-recovery.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function acceptLifecycle(archiveArgument, evidenceArgument, { skipBun = false, skipPnpm = false } = {}) {
	const archive = resolve(archiveArgument);
	const output = resolve(evidenceArgument);
	const bytes = readFileSync(archive);
	const metadata = JSON.parse((await run("tar", ["-xOf", archive, "package/package.json"])).stdout);
	assert.equal(metadata.name, "@diffexai/diffex");
	await run(
		"python3",
		[
			join(root, "scripts/check-distribution-payload.py"),
			archive,
			"--license",
			join(root, "LICENSE"),
			"--name",
			metadata.name,
			"--version",
			metadata.version,
		],
		{ maxBuffer: 20 * 1024 * 1024 },
	);
	const inventory = JSON.parse(
		(await run("tar", ["-xOf", archive, "package/distribution-files.json"], { maxBuffer: 10 * 1024 * 1024 })).stdout,
	);
	function verifyInstalled(directory) {
		assert.deepEqual(JSON.parse(readFileSync(join(directory, "distribution-files.json"), "utf8")), inventory);
		for (const file of inventory.files)
			assert.equal(
				createHash("sha256")
					.update(readFileSync(join(directory, file.path)))
					.digest("hex"),
				file.sha256,
				`Installed runtime bytes changed: ${file.path}`,
			);
	}
	const temporary = mkdtempSync(join(tmpdir(), "diffex npm lifecycle "));
	const env = isolatedEnvironment(temporary);
	delete env.DIFFEX_OFFLINE;
	env.npm_config_fetch_retries = "0";
	env.npm_config_audit = "false";
	env.npm_config_fund = "false";
	const prefix = env.npm_config_prefix;
	env.PATH = `${join(prefix, "bin")}:${env.PATH}`;
	const packageRoot = join(prefix, "lib/node_modules/@diffexai/diffex");
	const executable = join(prefix, "bin/diffex");
	const options = { cwd: join(temporary, "project"), env, timeout: 180000, maxBuffer: 10 * 1024 * 1024 };
	const events = join(temporary, "events.jsonl");
	const response = join(temporary, "response.json");
	env.DIFFEX_LIFECYCLE_EVENTS = events;
	env.DIFFEX_LIFECYCLE_RESPONSE = response;
	const evidence = {
		sourceCommit: "",
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		version: metadata.version,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		commands: [],
		checks: [],
		status: "failed",
		cleanup: false,
		limitation:
			"Real npm installs reviewed bytes; discovery and scoped registry use controlled fixtures. The predecessor changes only isolated installed version metadata. No public-to-public upgrade or real provider inference is claimed.",
	};
	let mode = "valid";
	let interrupt;
	let tarballRequests = 0;
	const server = createLifecycleRegistry({
		metadata,
		bytes,
		getMode: () => mode,
		onArchive: (archiveMode) => {
			tarballRequests++;
			if (archiveMode === "interrupt") interrupt?.();
		},
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));

	async function command(command, args, extra = {}) {
		try {
			console.log(`Lifecycle: ${command} ${args.join(" ")}`);
			const packageManagerOperation =
				(["npm", "bun"].includes(command) && args.includes("install")) || args.includes("--self");
			const result = await run(command, args, {
				...options,
				timeout: packageManagerOperation ? 600_000 : options.timeout,
				...extra,
			});
			evidence.commands.push({ command, args, exitCode: 0 });
			return result.stdout;
		} catch (error) {
			evidence.commands.push({ command, args, exitCode: error.code, signal: error.signal });
			throw error;
		}
	}
	function snapshot(directory) {
		const result = {};
		function visit(current, local = "") {
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const file = join(current, entry.name);
				const key = `${local}${entry.name}`;
				if (entry.isDirectory()) visit(file, `${key}/`);
				else
					result[key] = entry.isSymbolicLink()
						? readlinkSync(file)
						: createHash("sha256").update(readFileSync(file)).digest("hex");
			}
		}
		visit(directory);
		return createHash("sha256")
			.update(JSON.stringify(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))))
			.digest("hex");
	}
	function fixture(value) {
		writeFileSync(response, JSON.stringify(value));
		writeFileSync(events, "");
	}
	const valid = { status: 200, body: JSON.stringify({ packageName: metadata.name, version: metadata.version }) };
	const guard = join(temporary, "guard.mjs");
	const update = (force = false) =>
		command(process.execPath, ["--import", guard, executable, "update", "--self", ...(force ? ["--force"] : [])]);
	try {
		writeFileSync(env.npm_config_userconfig, `@diffexai:registry=http://127.0.0.1:${server.address().port}/\n`);
		evidence.npm = (await command("npm", ["--version"])).trim();
		await command("npm", ["install", "-g", "--ignore-scripts", "--registry=https://registry.npmjs.org", archive]);
		verifyInstalled(packageRoot);
		evidence.sourceCommit = JSON.parse(readFileSync(join(packageRoot, "distribution-files.json"), "utf8")).sourceCommit;
		assert.equal((await command("diffex", ["--version"])).trim(), metadata.version);
		assert((await command("diffex", ["--help"])).includes("diffex"));
		await command("diffex", ["--list-models"], { env: { ...env, DIFFEX_OFFLINE: "1" } });
		writeFileSync(
			guard,
			`import ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/core/http-dispatcher.js")).href)};\n${readFileSync(join(root, "scripts/fixtures/installed-update-guard.mjs"), "utf8")}`,
		);
		const retained = join(env.DIFFEX_CODING_AGENT_DIR, "lifecycle-retained.json");
		writeFileSync(retained, '{"retained":"session and settings fixture"}\n');
		const projectData = join(options.cwd, ".diffex");
		mkdirSync(projectData);
		writeFileSync(join(projectData, "retained.txt"), "project data");
		const before = snapshot(prefix);
		for (const invalid of [
			{ status: 200, body: "{" },
			{ status: 200, body: JSON.stringify({ packageName: "@foreign/cli", version: metadata.version }) },
			{ status: 200, body: JSON.stringify({ packageName: metadata.name, version: "1.2.3-beta.1" }) },
			{ status: 302, body: "{}", headers: { location: "https://foreign.invalid" } },
			{ status: 503, body: "{}" },
			{ status: 404, body: '{"error":"no_published_release"}' },
		]) {
			fixture(invalid);
			await assert.rejects(update(true));
			assert.deepEqual(snapshot(prefix), before);
			const recorded = readFileSync(events, "utf8");
			assert(!recorded.includes('"type":"process"'));
			evidence.checks.push({ invalid, installationUnchanged: true });
		}
		fixture(valid);
		await update();
		assert.deepEqual(snapshot(prefix), before);
		assert(!readFileSync(events, "utf8").includes('"type":"process"'));
		// Simulate an older installed client without publishing or changing reviewed candidate bytes.
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ ...metadata, version: "0.0.0" }));
		env.npm_config_cache = join(temporary, "cache-upgrade");
		await update();
		assert.equal((await command("diffex", ["--version"])).trim(), metadata.version);
		assert(readFileSync(events, "utf8").includes(`${metadata.name}@${metadata.version}`));
		assert(tarballRequests > 0, "Real npm must download the target tarball");
		evidence.checks.push({ upgrade: "0.0.0 metadata fixture to reviewed candidate", realNpm: true });
		for (const fault of ["corrupt", "interrupt"]) {
			mode = fault;
			env.npm_config_cache = join(temporary, `cache-${fault}`);
			fixture(valid);
			const stable = snapshot(prefix);
			if (fault === "corrupt") await assert.rejects(update(true), /integrity|checksum|EINTEGRITY/i);
			else {
				const child = spawn(process.execPath, ["--import", guard, executable, "update", "--self", "--force"], {
					...options,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				// Keep draining both pipes, retaining only the last 64 KiB per stream.
				const captured = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
				for (const name of ["stdout", "stderr"]) {
					child[name].on("data", (chunk) => {
						captured[name] = Buffer.concat([captured[name], chunk]).subarray(-64 * 1024);
					});
				}
				let interrupted = false;
				interrupt = () => {
					interrupted = true;
					process.kill(-child.pid, "SIGTERM");
				};
				const deadline = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 30000);
				let result;
				try {
					result = await new Promise((done, reject) => {
						child.on("close", (exitCode, signal) => done({ exitCode, signal }));
						child.on("error", reject);
					});
				} finally {
					clearTimeout(deadline);
					interrupt = undefined;
				}
				const diagnostic = {
					command: "diffex update --self --force",
					...result,
					boundary: "npm archive download",
					interrupted,
					stdout: captured.stdout.toString("utf8"),
					stderr: captured.stderr.toString("utf8"),
				};
				evidence.commands.push(diagnostic);
				assert(
					interrupted,
					`Interrupted update must reach the real npm archive download; child exited before boundary: ${JSON.stringify(diagnostic)}`,
				);
			}
			const installationUnchanged = snapshot(prefix) === stable;
			if (fault === "corrupt") assert(installationUnchanged, "Integrity failure mutated the prefix");
			mode = "valid";
			env.npm_config_cache = join(temporary, `cache-repair-${fault}`);
			const repairArgs = [
				"install",
				"-g",
				"--ignore-scripts",
				"--registry=https://registry.npmjs.org",
				`${metadata.name}@${metadata.version}`,
			];
			let movedBackup = false;
			try {
				await command("npm", repairArgs);
			} catch (error) {
				if (fault !== "interrupt" || !error.stderr?.includes("ENOTEMPTY")) throw error;
				const backup = findNpmRecoveryDirectory(dirname(packageRoot), error.stderr);
				renameSync(backup, join(temporary, "retained-npm-recovery-backup"));
				movedBackup = true;
				await command("npm", repairArgs);
			}
			assert.equal((await command("diffex", ["--version"])).trim(), metadata.version);
			verifyInstalled(packageRoot);
			evidence.checks.push({ fault, installationUnchanged, movedBackup, pinnedRepair: "passed" });
		}
		fixture(valid);
		await update(true);
		await command("npm", ["uninstall", "-g", "--ignore-scripts", metadata.name]);
		assert(!existsSync(executable));
		assert(!existsSync(packageRoot));
		assert.equal(readFileSync(retained, "utf8"), '{"retained":"session and settings fixture"}\n');
		assert.equal(readFileSync(join(projectData, "retained.txt"), "utf8"), "project data");
		evidence.checks.push({ uninstall: "passed", userDataRetained: true, projectDataRetained: true });
		if (!skipBun) {
			env.BUN_INSTALL = join(temporary, "bun");
			env.BUN_INSTALL_BIN = join(env.BUN_INSTALL, "bin");
			env.BUN_INSTALL_GLOBAL_DIR = join(env.BUN_INSTALL, "install/global");
			env.BUN_INSTALL_CACHE_DIR = join(temporary, "bun-cache");
			env.PATH = `${env.BUN_INSTALL_BIN}:${env.PATH}`;
			writeFileSync(
				join(env.XDG_CONFIG_HOME, ".bunfig.toml"),
				`[install.scopes]\ndiffexai = "http://127.0.0.1:${server.address().port}/"\n`,
			);
			evidence.bun = (await command("bun", ["--version"])).trim();
			await command("bun", ["install", "-g", "--ignore-scripts", archive]);
			assert.equal(realpathSync((await command("bun", ["pm", "bin", "-g"])).trim()), realpathSync(env.BUN_INSTALL_BIN));
			const bunPackage = join(env.BUN_INSTALL_GLOBAL_DIR, "node_modules/@diffexai/diffex");
			const bunExecutable = join(env.BUN_INSTALL_BIN, "diffex");
			verifyInstalled(bunPackage);
			assert.equal((await command("diffex", ["--version"])).trim(), metadata.version);
			assert((await command("diffex", ["--help"])).includes("diffex"));
			writeFileSync(
				guard,
				`import ${JSON.stringify(pathToFileURL(join(bunPackage, "dist/core/http-dispatcher.js")).href)};\n${readFileSync(join(root, "scripts/fixtures/installed-update-guard.mjs"), "utf8")}`,
			);
			fixture({ status: 200, body: JSON.stringify({ packageName: "@foreign/cli", version: metadata.version }) });
			const stable = snapshot(env.BUN_INSTALL_GLOBAL_DIR);
			await assert.rejects(
				command(process.execPath, ["--import", guard, bunExecutable, "update", "--self", "--force"]),
			);
			assert.equal(snapshot(env.BUN_INSTALL_GLOBAL_DIR), stable);
			fixture(valid);
			writeFileSync(join(bunPackage, "package.json"), JSON.stringify({ ...metadata, version: "0.0.0" }));
			await command(process.execPath, ["--import", guard, bunExecutable, "update", "--self"]);
			assert.equal((await command("diffex", ["--version"])).trim(), metadata.version);
			verifyInstalled(bunPackage);
			assert(readFileSync(events, "utf8").includes('"command":"bun"'));
			await command("bun", ["uninstall", "-g", metadata.name]);
			assert(!existsSync(bunExecutable));
			assert(!existsSync(bunPackage));
			assert.equal(readFileSync(retained, "utf8"), '{"retained":"session and settings fixture"}\n');
			assert.equal(readFileSync(join(projectData, "retained.txt"), "utf8"), "project data");
			evidence.checks.push({
				manager: "bun",
				install: "passed",
				upgrade: "metadata fixture to reviewed candidate",
				foreignIdentityRejected: true,
				uninstall: "passed",
				userDataRetained: true,
			});
		}
		if (!skipPnpm) {
			try {
				evidence.pnpm = await acceptPnpmLifecycle(archive, metadata, inventory);
			} catch (error) {
				evidence.pnpm = error.pnpmEvidence;
				throw error;
			}
		}
		evidence.status = "passed";
	} finally {
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
		rmSync(temporary, { recursive: true, force: true });
		evidence.cleanup = !existsSync(temporary);
		mkdirSync(output, { recursive: true });
		writeFileSync(join(output, "npm-lifecycle.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	}
	console.log(`npm lifecycle ${evidence.status}: ${metadata.version}`);
	return evidence;
}

// Real pnpm processes and archive bytes; only release discovery and the scoped registry are fixtures.
export async function acceptPnpmLifecycle(archive, metadata, inventory) {
	const temporary = mkdtempSync(join(tmpdir(), "diffex pnpm lifecycle "));
	const env = isolatedEnvironment(temporary, "pnpm");
	delete env.DIFFEX_OFFLINE;
	env.PATH = `${env.PNPM_HOME}:${env.PATH}`;
	env.npm_config_fetch_retries = "0";
	const options = { cwd: join(temporary, "project"), env, timeout: 180000, maxBuffer: 10 * 1024 * 1024 };
	const evidence = { manager: "pnpm", commands: [], checks: [], status: "failed", cleanup: false };
	const bytes = readFileSync(archive);
	let mode = "valid";
	let tarballRequests = 0;
	const server = createLifecycleRegistry({ metadata, bytes, getMode: () => mode, onArchive: () => tarballRequests++ });
	let failure;
	const command = async (name, args) => {
		const entry = { manager: "pnpm", command: name, args, exitCode: null };
		evidence.commands.push(entry);
		try {
			const result = await run(name, args, options);
			entry.exitCode = 0;
			return result.stdout.trim();
		} catch (error) {
			entry.exitCode = error.code;
			entry.signal = error.signal;
			entry.stdout = String(error.stdout ?? "").slice(-65536);
			entry.stderr = String(error.stderr ?? "").slice(-65536);
			throw error;
		}
	};
	try {
		await new Promise((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", done);
		});
		evidence.version = assertPnpmVersion(options.cwd, env);
		writeFileSync(env.npm_config_userconfig, `@diffexai:registry=http://127.0.0.1:${server.address().port}/\n`);
		const layout = globalManagerLayout("pnpm", temporary, env);
		const retained = join(env.DIFFEX_CODING_AGENT_DIR, "retained.txt");
		const projectData = join(options.cwd, ".diffex", "retained.txt");
		mkdirSync(dirname(projectData));
		writeFileSync(retained, "retain user data");
		writeFileSync(projectData, "retain project data");
		const store = (phase) => {
			// Keep the store identity in the global lockfile, but remove its contents and metadata cache.
			rmSync(env.npm_config_store_dir, { recursive: true, force: true });
			rmSync(join(env.XDG_CACHE_HOME, "pnpm"), { recursive: true, force: true });
			assert(!existsSync(env.npm_config_store_dir), `Expected empty pnpm store for ${phase}`);
			evidence.checks.push({ phase, emptyStore: true });
		};
		const verify = async () => {
			assert.equal(await command(layout.executable, ["--version"]), metadata.version);
			assert.match(await command(layout.executable, ["--help"]), /diffex/i);
			verifyInstalledFiles(layout.packageRoot, inventory);
		};
		const remove = async () => {
			await command("pnpm", ["remove", "--global", metadata.name]);
			assert(!existsSync(layout.executable) && !existsSync(layout.packageRoot));
			assert.equal(readFileSync(retained, "utf8"), "retain user data");
			assert.equal(readFileSync(projectData, "utf8"), "retain project data");
		};
		store("install");
		await command("pnpm", ["add", "--global", "--ignore-scripts", archive]);
		await verify();
		const guard = join(temporary, "guard.mjs");
		env.DIFFEX_LIFECYCLE_EVENTS = join(temporary, "events.jsonl");
		env.DIFFEX_LIFECYCLE_RESPONSE = join(temporary, "response.json");
		const fixture = (body) => {
			writeFileSync(env.DIFFEX_LIFECYCLE_RESPONSE, JSON.stringify({ status: 200, body: JSON.stringify(body) }));
			writeFileSync(env.DIFFEX_LIFECYCLE_EVENTS, "");
			writeFileSync(guard, `import ${JSON.stringify(pathToFileURL(join(layout.packageRoot, "dist/core/http-dispatcher.js")).href)};\n${readFileSync(join(root, "scripts/fixtures/installed-update-guard.mjs"), "utf8")}`);
		};
		// pnpm's global bin is a shell shim, not a JavaScript symlink.
		const cliEntrypoint = join(layout.packageRoot, metadata.bin.diffex);
		const update = () => command(process.execPath, ["--import", guard, cliEntrypoint, "update", "--self", "--force"]);
		fixture({ packageName: "@foreign/cli", version: metadata.version });
		await assert.rejects(update());
		const rejectedEvents = readFileSync(env.DIFFEX_LIFECYCLE_EVENTS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(rejectedEvents, [{ type: "discovery", url: "https://api.diffex.ai/api/latest-version", redirect: "manual" }]);
		verifyInstalledFiles(layout.packageRoot, inventory);
		evidence.checks.push({ foreignIdentityRejected: true, installationUnchanged: true });
		// Atomic replacement must not mutate pnpm's hard-linked content-addressed store.
		const versionFixture = join(layout.packageRoot, "package.json.fixture");
		writeFileSync(versionFixture, JSON.stringify({ ...metadata, version: "0.0.0" }));
		renameSync(versionFixture, join(layout.packageRoot, "package.json"));
		store("upgrade");
		fixture({ packageName: metadata.name, version: metadata.version });
		await command(process.execPath, ["--import", guard, cliEntrypoint, "update", "--self"]);
		await verify();
		assert(tarballRequests > 0, "pnpm must download reviewed target bytes using the empty upgrade store");
		assert(readFileSync(env.DIFFEX_LIFECYCLE_EVENTS, "utf8").includes('"command":"pnpm"'), "Updater did not select pnpm");
		evidence.checks.push({ upgrade: "metadata predecessor fixture", realPnpm: true, installedHashes: "passed" });
		mode = "corrupt";
		// Changing store-dir with an existing global lock needs a clean installation state.
		await remove();
		store("corrupt");
		await assert.rejects(command("pnpm", ["add", "--global", "--ignore-scripts", `${metadata.name}@${metadata.version}`]), (error) => {
			assert.match(`${error.stdout}\n${error.stderr}`, /ERR_PNPM_TARBALL_INTEGRITY|checksum/i);
			return true;
		});
		assert(!existsSync(layout.executable) && !existsSync(layout.packageRoot));
		evidence.checks.push({ corruptIntegrityRejected: true, executableAbsent: true });
		mode = "valid";
		store("repair");
		await command("pnpm", ["add", "--global", "--ignore-scripts", `${metadata.name}@${metadata.version}`]);
		await verify();
		await remove();
		const requests = tarballRequests;
		await command("pnpm", ["add", "--global", "--offline", "--ignore-scripts", `${metadata.name}@${metadata.version}`]);
		await verify();
		assert.equal(tarballRequests, requests, "Offline reinstall must use the populated pnpm store");
		await remove();
		evidence.checks.push({ uninstall: "passed", userDataRetained: true, projectDataRetained: true, offlineCacheReuse: "passed" });
		evidence.tarballRequests = tarballRequests;
		evidence.status = "passed";
		return evidence;
	} catch (error) {
		failure = error;
		error.pnpmEvidence = evidence;
		throw error;
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise((done) => server.close(done));
		rmSync(temporary, { recursive: true, force: true });
		evidence.cleanup = !existsSync(temporary);
		if (failure) failure.message += `\npnpm lifecycle diagnostics: ${JSON.stringify(evidence)}`;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [archive, output] = process.argv.slice(2);
	assert(archive && output, "Usage: npm-lifecycle.mjs REVIEWED_TARBALL EVIDENCE_DIRECTORY");
	await acceptLifecycle(archive, output, {
		skipBun: process.argv.includes("--skip-bun"), skipPnpm: process.argv.includes("--skip-pnpm"),
	});
}
