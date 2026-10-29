import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLifecycleRegistry } from "./npm-lifecycle-registry.mjs";
import { readHomebrewFile, resolveHomebrewFile } from "./homebrew-runtime.mjs";
import { releaseFilePath, resolveReleaseDirectory } from "./homebrew-release-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const homebrewMarker = { schemaVersion: 1, package: "@diffexai/diffex", formula: "diffexai/tap/diffex" };
const tools = ["sh", "bash", "dirname", "readlink", "uname", "cat", "env", "tmux", "python3", "rg", "fd", "git", "mkdir", "sed", "tr", "head", "tail", "stty", "sleep", "kill", "which", "tput", "clear", "date", "realpath", "cut", "sort", "wc", "find", "xargs", "ls", "cp", "rm"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyHomebrewRecord(archive, record, { platform = process.platform, arch = process.arch } = {}) {
	return validateHomebrewRecord(archive, record, readHomebrewFile(archive), platform, arch);
}

function validateHomebrewRecord(archive, record, bytes, platform, arch) {
	assert.equal(record.platform, `${platform}-${arch}`, "Archive must be tested on its native platform");
	assert.equal(record.filename, basename(archive), "Archive filename mismatch");
	assert.match(record.sourceCommit, /^[a-f0-9]{40}$/, "Missing source commit");
	assert.match(record.version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, "Missing candidate version");
	assert.equal(bytes.length, record.size, "Archive size mismatch");
	assert.equal(sha256(bytes), record.sha256, "Archive SHA256 mismatch");
	return record;
}

export function restrictedTools(directory, searchPath = process.env.PATH) {
	mkdirSync(directory, { recursive: true });
	for (const tool of tools) {
		const source = searchPath.split(delimiter).map((entry) => join(entry, tool)).find((entry) => existsSync(entry));
		if (source) symlinkSync(realpathSync(source), join(directory, tool));
	}
	for (const forbidden of ["node", "npm", "npx", "bun"]) assert(!existsSync(join(directory, forbidden)));
	return directory;
}

export function isolatedHomebrewEnvironment(root, path) {
	for (const name of ["home", "agent", "project", "temp"]) mkdirSync(join(root, name), { recursive: true });
	return { PATH: path, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "home/config"), XDG_CACHE_HOME: join(root, "home/cache"),
		TMPDIR: join(root, "temp"), DIFFEX_CODING_AGENT_DIR: join(root, "agent"),
		DIFFEX_NO_LOCAL_LLM: "1", DIFFEX_OFFLINE: "1", DIFFEX_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", LANG: "C.UTF-8",
		npm_config_userconfig: join(root, "home/.npmrc"), npm_config_globalconfig: join(root, "home/global.npmrc"),
		npm_config_cache: join(root, "home/npm-cache"), npm_config_audit: "false", npm_config_fund: "false",
		npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" };
}

export function linkHomebrewFixtureModules(payload, fixtureRoot) {
	const physicalPayload = realpathSync(payload);
	const cli = join(physicalPayload, "app/node_modules/@diffexai/diffex");
	const bundled = join(cli, "dist/node_modules/@diffexai");
	const scope = join(fixtureRoot, "node_modules/@diffexai");
	mkdirSync(scope, { recursive: true });
	const modules = [["diffex", cli], ...readdirSync(bundled).map((name) => [name, join(bundled, name)])];
	for (const [name, target] of modules) {
		assert.match(name, /^[a-z0-9][a-z0-9._-]*$/);
		const physical = realpathSync(target);
		assert(physical.startsWith(physicalPayload + sep), "Fixture module escapes the retained payload");
		assert.equal(JSON.parse(readFileSync(join(physical, "package.json"), "utf8")).name, `@diffexai/${name}`);
		symlinkSync(physical, join(scope, name), "dir");
	}
	assert(existsSync(join(scope, "diffex-ai/package.json")), "Missing bundled AI fixture SDK");
	assert(existsSync(join(scope, "diffex-tui/package.json")), "Missing bundled TUI fixture SDK");
}

export function payloadDigest(directory) {
	const root = realpathSync(directory);
	const entries = [];
	function visit(current) {
		assert(current === root || current.startsWith(root + sep), "Digest directory escapes its root");
		assert.equal(realpathSync(current), current, "Digest directory must not traverse links");
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = resolve(current, entry.name);
			assert(file.startsWith(root + sep), "Digest entry escapes its root");
			if (entry.isSymbolicLink()) {
				// Hash the link itself, not bytes from an arbitrary target.
				entries.push([relative(root, file), "symlink", readlinkSync(file)]);
				continue;
			}
			assert.equal(realpathSync(file), file, "Digest entry must not traverse links");
			const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const info = fstatSync(fd);
				if (info.isDirectory()) {
					entries.push([relative(root, file), info.mode & 0o777, "directory"]);
					visit(file);
				} else {
					assert(info.isFile(), "Digest requires regular files or directories");
					entries.push([relative(root, file), info.mode & 0o777, sha256(readFileSync(fd))]);
				}
			} finally { closeSync(fd); }
		}
	}
	visit(root);
	return sha256(JSON.stringify(entries));
}

function execute(executable, args, env, cwd, { timeout = 90_000, allowFailure = false } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(executable, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", forced;
		const deadline = setTimeout(() => {
			if (child.pid) {
				try { process.kill(-child.pid, "SIGTERM"); } catch { /* Process group already exited. */ }
				forced = setTimeout(() => {
					try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process group already exited. */ }
				}, 5_000);
				forced.unref();
			}
		}, timeout);
		deadline.unref();
		child.stdout.on("data", (bytes) => { stdout += bytes; });
		child.stderr.on("data", (bytes) => { stderr += bytes; });
		child.on("error", () => {
			clearTimeout(deadline);
			clearTimeout(forced);
			reject(new Error("Acceptance process could not start"));
		});
		child.on("close", (status, signal) => {
			clearTimeout(deadline);
			clearTimeout(forced);
			if (!allowFailure && (status !== 0 || signal)) reject(new Error("Acceptance process failed (output intentionally not published)"));
			else resolvePromise({ status, signal, stdout, stderr });
		});
	});
}

/** Real installed CLI/npm; registry inference and package bytes are local fixtures only. */
export async function exerciseHomebrewPayload(payload, root, record) {
	const env = isolatedHomebrewEnvironment(root, restrictedTools(join(root, "tools")));
	const executable = join(payload, "bin/diffex");
	const project = join(root, "project");
	const fixtureRoot = join(root, "external-fixture");
	mkdirSync(fixtureRoot);
	const before = payloadDigest(payload);
	const checks = [];
	for (const [name, args, expected] of [["help", ["--help"], /Usage/i], ["version", ["--version"], undefined], ["models", ["--list-models"], /\S/]]) {
		const result = await execute(executable, args, env, project);
		if (name === "version") assert.equal(result.stdout.trimEnd(), record.version, "version output mismatch");
		else assert.match(result.stdout, expected, `${name} output mismatch`);
		checks.push(name);
	}
	linkHomebrewFixtureModules(payload, fixtureRoot);
	const runtimeFixture = join(fixtureRoot, "runtime-operations.mjs");
	writeFileSync(runtimeFixture, readFileSync(join(here, "fixtures/homebrew-runtime-operations.mjs")));
	const runtimeResult = await execute(join(payload, "runtime/bin/node"), [runtimeFixture, payload], env, project);
	assert.match(runtimeResult.stdout, /homebrew-runtime-operations-ok/);
	assert.equal(payloadDigest(payload), before, "Runtime operations mutated the payload");
	checks.push("clipboard-keyring-binding-load-only", "photon-wasm-1px", "tui-render-native-helper-load", "session-html-export");
	const userState = [env.HOME, env.DIFFEX_CODING_AGENT_DIR, project];
	const userBefore = userState.map((directory) => payloadDigest(directory));
	for (const args of [["update"], ["update", "--self", "--force"]]) {
		const result = await execute(executable, args, env, project);
		assert.match(result.stdout, /brew upgrade diffexai\/tap\/diffex/);
	}
	assert.equal(payloadDigest(payload), before, "Self-update mutated Homebrew payload");
	assert.deepEqual(userState.map((directory) => payloadDigest(directory)), userBefore, "Self-update mutated user or project state");
	checks.push("owned-update-no-payload-user-project-mutation");
	const packageDirectory = join(root, "fixture/package");
	mkdirSync(packageDirectory, { recursive: true });
	const metadata = { name: "diffex-homebrew-fixture", version: "1.0.0", type: "module", diffex: { extensions: ["extension.mjs"] } };
	writeFileSync(join(packageDirectory, "package.json"), JSON.stringify(metadata));
	writeFileSync(join(packageDirectory, "extension.mjs"), 'export default function(diffex) { diffex.on("session_start", () => console.log("homebrew-extension-loaded")); }\n');
	const fixtureArchive = join(root, "fixture.tgz");
	const packed = spawnSync("tar", ["-czf", fixtureArchive, "-C", dirname(packageDirectory), "package"], { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
	assert.equal(packed.status, 0, "Could not pack local extension fixture");
	let downloads = 0;
	const registry = createLifecycleRegistry({ metadata, bytes: readFileSync(fixtureArchive), getMode: () => "normal", onArchive: () => { downloads++; } });
	await new Promise((ready) => registry.listen(0, "127.0.0.1", ready));
	try {
		env.npm_config_registry = `http://127.0.0.1:${registry.address().port}`;
		await execute(executable, ["install", "npm:diffex-homebrew-fixture@1.0.0"], env, project);
		assert(downloads > 0, "Bundled npm did not download the fixture");
		const fixture = join(fixtureRoot, "homebrew-behavior.mjs");
		writeFileSync(fixture, readFileSync(join(here, "daytona-behaviors/fixture.mjs")));
		try {
			env.DIFFEX_BEHAVIOR_RECORD = join(root, "events.jsonl");
			const result = await execute(executable, ["--no-skills", "--no-context-files", "--no-prompt-templates", "-e", fixture, "--model", "behavior/fixture", "--no-session", "-p", "BEHAVIOR_PRINT"], env, project);
			assert.match(result.stdout, /homebrew-extension-loaded/);
			assert.match(result.stdout, /behavior-print-ok/);
			assert(!readFileSync(env.DIFFEX_BEHAVIOR_RECORD, "utf8").includes('"type":"blocked-network"'));
		} finally { rmSync(fixture, { force: true }); }
		checks.push("bundled-npm-local-registry-extension", "faux-provider-print");
	} finally { await new Promise((closed) => registry.close(closed)); }
	assert.equal(payloadDigest(payload), before, "Extension installation mutated the payload");
	return { checks, executionPath: "allowlisted OS tools only; no system node/npm/npx/Bun", provider: "local faux provider; no live inference", npmRegistry: "loopback fixture; lifecycle scripts disabled",
		manualOutstanding: ["desktop clipboard interaction", "credential store read/write interaction", "macOS downloaded-archive quarantine and signing/notarization review"] };
}

export async function acceptHomebrewArchive(archive, recordFile, output) {
	archive = resolveHomebrewFile(archive);
	const archiveBytes = readHomebrewFile(archive);
	const record = validateHomebrewRecord(archive, JSON.parse(readHomebrewFile(recordFile, 64 * 1024).toString("utf8")), archiveBytes, process.platform, process.arch);
	output = resolveReleaseDirectory(output);
	mkdirSync(output, { recursive: true });
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "diffex-homebrew-acceptance-")));
	const repository = resolve(here, "..");
	assert(!realpathSync(temporary).startsWith(realpathSync(repository) + sep), "Acceptance must run outside repository");
	const report = { schemaVersion: 1, sourceCommit: record.sourceCommit, platform: record.platform, archiveSha256: record.sha256, status: "failed", cleanup: false, kind: "archive-not-brew-lifecycle" };
	try {
		// Extract exactly the bytes that were verified, not a reopened caller path.
		const retainedArchive = join(temporary, "candidate.tar.gz");
		writeFileSync(retainedArchive, archiveBytes, { flag: "wx" });
		const libexec = join(temporary, "cellar/libexec");
		const extracted = spawnSync("python3", [join(here, "homebrew-extract.py"), retainedArchive, libexec], { encoding: "utf8" });
		assert.equal(extracted.status, 0, "Candidate extraction failed safety checks");
		writeFileSync(join(libexec, ".diffex-homebrew.json"), JSON.stringify(homebrewMarker));
		Object.assign(report, await exerciseHomebrewPayload(join(libexec, "diffex"), temporary, record));
		report.status = "passed";
		return report;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
		report.cleanup = !existsSync(temporary);
		// Publish a fixed-schema summary only. No logs, environment, auth/config or raw failures.
		const fd = openSync(releaseFilePath(output, "homebrew-acceptance.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
		try {
			assert(fstatSync(fd).isFile(), "Evidence summary must be a regular file");
			ftruncateSync(fd, 0);
			writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
		} finally { closeSync(fd); }
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [archive, record, output] = process.argv.slice(2);
	assert(archive && record && output, "Usage: node scripts/homebrew-acceptance.mjs ARCHIVE RECORD OUTPUT");
	acceptHomebrewArchive(archive, record, output).catch(() => {
		console.error("Homebrew archive acceptance failed; see fixed-schema evidence summary");
		process.exitCode = 1;
	});
}
