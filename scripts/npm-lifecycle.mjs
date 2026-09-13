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
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isolatedEnvironment } from "./artifact-acceptance.mjs";
import { findNpmRecoveryBackup } from "./npm-recovery.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [archiveArgument, evidenceArgument] = process.argv.slice(2);
assert(archiveArgument && evidenceArgument, "Usage: npm-lifecycle.mjs REVIEWED_TARBALL EVIDENCE_DIRECTORY");
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
const server = createServer((request, reply) => {
	const path = decodeURIComponent(request.url);
	if (path === "/@diffexai/diffex") {
		const pkg = {
			...metadata,
			dist: {
				tarball: `http://127.0.0.1:${server.address().port}/diffex.tgz`,
				integrity: `sha512-${createHash("sha512")
					.update(mode === "corrupt" ? "wrong bytes" : bytes)
					.digest("base64")}`,
			},
		};
		reply.setHeader("content-type", "application/json");
		reply.end(
			JSON.stringify({
				name: metadata.name,
				"dist-tags": { latest: metadata.version },
				versions: { [metadata.version]: pkg },
			}),
		);
	} else if (path === "/diffex.tgz") {
		tarballRequests++;
		if (mode === "interrupt") {
			interrupt?.();
			return;
		}
		reply.end(bytes);
	} else {
		reply.writeHead(404).end();
	}
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));

async function command(command, args, extra = {}) {
	try {
		console.log(`Lifecycle: ${command} ${args.join(" ")}`);
		const result = await run(command, args, { ...options, ...extra });
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
				stdio: "ignore",
			});
			let interrupted = false;
			interrupt = () => {
				interrupted = true;
				process.kill(-child.pid, "SIGTERM");
			};
			const deadline = setTimeout(() => process.kill(-child.pid, "SIGKILL"), 30000);
			try {
				await new Promise((done, reject) => {
					child.on("close", done);
					child.on("error", reject);
				});
			} finally {
				clearTimeout(deadline);
			}
			assert(interrupted, "Interrupted update must reach the real npm archive download");
			evidence.commands.push({
				command: "diffex update --self --force",
				signal: "SIGTERM",
				boundary: "npm archive download",
			});
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
			const backup = findNpmRecoveryBackup(dirname(packageRoot), error.stderr);
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
	if (!process.argv.includes("--skip-bun")) {
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
