import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acceptHomebrewArchive, exerciseHomebrewPayload, isolatedHomebrewEnvironment, linkHomebrewFixtureModules, payloadDigest, restrictedTools, sha256, verifyHomebrewRecord } from "./homebrew-acceptance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(operation) {
	const root = mkdtempSync(join(tmpdir(), "homebrew acceptance fixture "));
	return Promise.resolve().then(() => operation(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}
function recordFor(archive) {
	const bytes = readFileSync(archive);
	return { platform: `${process.platform}-${process.arch}`, filename: "candidate.tar.gz", sourceCommit: "a".repeat(40), version: "0.0.1", size: bytes.length, sha256: sha256(bytes) };
}

test("retained record rejects wrong bytes, size, filename, commit and nonnative platform", () => fixture((root) => {
	const archive = join(root, "candidate.tar.gz");
	writeFileSync(archive, "retained candidate");
	const record = recordFor(archive);
	assert.equal(verifyHomebrewRecord(archive, record), record);
	for (const change of [{ sha256: "0".repeat(64) }, { size: 0 }, { filename: "other.tar.gz" }, { sourceCommit: "short" }, { platform: "not-native" }]) {
		assert.throws(() => verifyHomebrewRecord(archive, { ...record, ...change }));
	}
}));

test("execution environment inherits neither credentials nor system runtimes", () => fixture((root) => {
	const path = restrictedTools(join(root, "tools"));
	const env = isolatedHomebrewEnvironment(root, path);
	assert.deepEqual(readdirSync(path).filter((entry) => /^(?:node|npm|npx|bun)$/.test(entry)), []);
	assert.equal(env.PATH, path);
	assert.equal(env.DIFFEX_OFFLINE, "1");
	assert.equal(env.DIFFEX_SKIP_VERSION_CHECK, "1");
	for (const name of ["DAYTONA_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "NODE_PATH", "NPM_TOKEN", "BUN_INSTALL"]) assert.equal(env[name], undefined);
	const result = spawnSync(join(path, "sh"), ["-c", "command -v node || command -v npm || command -v bun"], { env, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.equal(result.stdout, "");
}));

test("external fixtures resolve CLI and bundled AI/TUI with no separate registry packages or workspace fallback", () => fixture((root) => {
	const payload = join(root, "payload");
	const cli = join(payload, "app/node_modules/@diffexai/diffex");
	const bundled = join(cli, "dist/node_modules/@diffexai");
	for (const [name, directory] of [["diffex", cli], ["diffex-ai", join(bundled, "diffex-ai")], ["diffex-tui", join(bundled, "diffex-tui")]]) {
		mkdirSync(join(directory, "dist"), { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@diffexai/${name}`, type: "module", exports: "./dist/index.js" }));
		writeFileSync(join(directory, "dist/index.js"), `export const identity = ${JSON.stringify(name)};\n`);
	}
	const tui = join(bundled, "diffex-tui");
	const native = join(tui, "native/darwin/prebuilds/darwin-arm64");
	mkdirSync(native, { recursive: true });
	writeFileSync(join(native, "darwin-modifiers.node"), "native-path-fixture-only");
	assert.deepEqual(readdirSync(join(payload, "app/node_modules/@diffexai")), ["diffex"]);
	const before = payloadDigest(payload);
	const external = join(root, "external");
	linkHomebrewFixtureModules(payload, external);
	assert.equal(realpathSync(join(external, "node_modules/@diffexai/diffex-ai")), realpathSync(join(bundled, "diffex-ai")));
	const script = join(external, "resolution.mjs");
	writeFileSync(script, `import assert from 'node:assert/strict';
import { identity as cli } from '@diffexai/diffex';
import { identity as ai } from '@diffexai/diffex-ai';
import { identity as tui } from '@diffexai/diffex-tui';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
assert.deepEqual([cli, ai, tui], ['diffex', 'diffex-ai', 'diffex-tui']);
const require = createRequire(import.meta.url);
const tuiRoot = dirname(dirname(require.resolve('@diffexai/diffex-tui')));
assert.equal(tuiRoot, realpathSync(process.argv[2]));
assert.equal(readFileSync(join(tuiRoot, 'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node'), 'utf8'), 'native-path-fixture-only');
console.log('bundled-only-resolution-ok');
`);
	const env = isolatedHomebrewEnvironment(root, restrictedTools(join(root, "tools")));
	const result = spawnSync(process.execPath, [script, tui], { cwd: join(root, "project"), env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /bundled-only-resolution-ok/);
	assert.equal(payloadDigest(payload), before, "External resolution changed the candidate");
}));

test("extractor rejects traversal, credential configuration and links escaping payload", () => fixture((root) => {
	const generator = join(root, "fixture.py");
	writeFileSync(generator, `import io, sys, tarfile\nwith tarfile.open(sys.argv[1], 'w:gz') as archive:\n item = tarfile.TarInfo(sys.argv[2])\n if sys.argv[3] == 'link':\n  item.type = tarfile.SYMTYPE\n  item.linkname = '/etc/passwd'\n else:\n  item.size = 1\n archive.addfile(item, io.BytesIO(b'x') if item.isfile() else None)\n`);
	let index = 0;
	for (const [name, type, safe] of [["diffex/bin/file", "file", true], ["diffex/../../escape", "file", false], ["diffex/.npmrc", "file", false], ["diffex/app/auth.json", "file", false], ["diffex/link", "link", false]]) {
		const archive = join(root, `archive-${index}.tgz`);
		assert.equal(spawnSync("python3", [generator, archive, name, type]).status, 0);
		const result = spawnSync("python3", [join(here, "homebrew-extract.py"), archive, join(root, `extracted-${index++}`)], { encoding: "utf8" });
		assert.equal(result.status, safe ? 0 : 1, result.stderr);
	}
	assert(!existsSync(join(root, "escape")));
}));

test("record reads reject symlinked archives and evidence rejects symlinked directories", () => fixture(async (root) => {
	const archive = join(root, "candidate.tar.gz");
	writeFileSync(archive, "candidate");
	const alias = join(root, "alias.tar.gz");
	symlinkSync(archive, alias);
	assert.throws(() => verifyHomebrewRecord(alias, { ...recordFor(archive), filename: "alias.tar.gz" }));
	const record = join(root, "candidate.json");
	writeFileSync(record, JSON.stringify(recordFor(archive)));
	const target = join(root, "outside");
	mkdirSync(target);
	const output = join(root, "evidence");
	symlinkSync(target, output, "dir");
	await assert.rejects(acceptHomebrewArchive(archive, record, output), /symlink/);
	assert.deepEqual(readdirSync(target), []);
}));

test("payload digest hashes link text without reading linked files and rejects special files", () => fixture((root) => {
	const payload = join(root, "payload");
	mkdirSync(payload);
	const external = join(root, "external");
	writeFileSync(external, "first");
	symlinkSync(external, join(payload, "link"));
	const before = payloadDigest(payload);
	writeFileSync(external, "changed external bytes");
	assert.equal(payloadDigest(payload), before);
	if (process.platform !== "win32") {
		assert.equal(spawnSync("mkfifo", [join(payload, "fifo")]).status, 0);
		assert.throws(() => payloadDigest(payload), /regular files/);
	}
}));

test("candidate version is compared literally, including build metadata plus signs", () => fixture(async (root) => {
	const payload = join(root, "payload");
	mkdirSync(join(payload, "bin"), { recursive: true });
	writeFileSync(join(payload, "bin/diffex"), '#!/bin/sh\nif [ "$1" = "--help" ]; then echo Usage; else echo 1.2.333build.1; fi\n', { mode: 0o755 });
	await assert.rejects(exerciseHomebrewPayload(payload, root, { version: "1.2.3+build.1" }), /version output mismatch/);
}));

test("runtime fixture anchors payload and SDK state before invoking model/auth APIs", () => fixture((temporary) => {
	const root = realpathSync(temporary);
	const external = join(root, "external-fixture");
	const payload = join(root, "cellar/libexec/diffex");
	mkdirSync(join(payload, "app/node_modules/@diffexai/diffex"), { recursive: true });
	mkdirSync(external);
	for (const [name, source] of [["diffex", 'export const ModelRuntime = { create: async (options) => { console.log(JSON.stringify(options)); throw new Error("sdk-reached"); } }; export const SessionManager = {};'], ["diffex-tui", 'export class Text {}']]) {
		const directory = join(external, "node_modules/@diffexai", name);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@diffexai/${name}`, type: "module", exports: "./index.js" }));
		writeFileSync(join(directory, "index.js"), source);
	}
	const script = join(external, "runtime-operations.mjs");
	writeFileSync(script, readFileSync(join(here, "fixtures/homebrew-runtime-operations.mjs")));
	const env = isolatedHomebrewEnvironment(root, restrictedTools(join(root, "tools")));
	const run = (argument, environment = env) => spawnSync(process.execPath, [script, argument], { cwd: join(root, "project"), env: environment, encoding: "utf8" });
	for (const result of [run(root), run(payload, { ...env, DIFFEX_CODING_AGENT_DIR: root })]) {
		assert.notEqual(result.status, 0);
		assert.equal(result.stdout, "");
		assert(!result.stderr.includes("sdk-reached"));
	}
	const result = run(payload);
	assert.match(result.stderr, /sdk-reached/);
	assert.deepEqual(JSON.parse(result.stdout), { authPath: join(root, "agent/runtime-fixture/auth.json"), modelsPath: join(root, "agent/runtime-fixture/models.json"), refreshOnCreate: false });
}));

test("failed installed CLI writes only fixed-schema evidence and does not publish auth or raw output", () => fixture(async (root) => {
	const bin = join(root, "source/diffex/bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "diffex"), "#!/bin/sh\necho credential-canary-never-publish >&2\nexit 23\n", { mode: 0o755 });
	const archive = join(root, "candidate.tar.gz");
	assert.equal(spawnSync("tar", ["-czf", archive, "-C", join(root, "source"), "diffex"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).status, 0);
	const record = join(root, "candidate.json");
	writeFileSync(record, JSON.stringify(recordFor(archive)));
	const output = join(root, "evidence");
	await assert.rejects(acceptHomebrewArchive(archive, record, output), /Acceptance process failed/);
	assert.deepEqual(readdirSync(output), ["homebrew-acceptance.json"]);
	const text = readFileSync(join(output, "homebrew-acceptance.json"), "utf8");
	assert(!text.includes("credential-canary"));
	const report = JSON.parse(text);
	assert.equal(report.status, "failed");
	assert.equal(report.cleanup, true);
	assert.equal(report.kind, "archive-not-brew-lifecycle");
}));
