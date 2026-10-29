import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, mock, test } from "node:test";
import { readHomebrewFile, readRuntimePins, resolveHomebrewFile, runtimePinsFile } from "./homebrew-runtime.mjs";

const directory = mkdtempSync(join(tmpdir(), "diffex-homebrew-runtime-test-"));
after(() => rmSync(directory, { recursive: true, force: true }));

test("Homebrew file paths retain workspace, home, temporary, canonical, and spaced paths", () => {
	for (const root of [process.cwd(), homedir(), tmpdir(), "/tmp"]) {
		assert.equal(resolveHomebrewFile(join(root, "manifest.json")), join(realpathSync(root), "manifest.json"));
	}
	const spaced = join(directory, "retained files with spaces");
	mkdirSync(spaced);
	const file = join(spaced, "runtime pins.json");
	writeFileSync(file, "fixture");
	assert.equal(readHomebrewFile(file).toString(), "fixture");
	assert.equal(readHomebrewFile(realpathSync(file)).toString(), "fixture");
	assert.deepEqual(readHomebrewFile("LICENSE"), readFileSync(resolve("LICENSE")));
	assert.equal(readRuntimePins().schemaVersion, 1);
});

test("module-owned runtime pins remain readable from an external cwd with isolated HOME", () => {
	const cwd = join(directory, "external-publication-fixture");
	const home = join(directory, "isolated-home");
	const temporary = join(home, "tmp");
	mkdirSync(cwd);
	mkdirSync(temporary, { recursive: true });
	const custom = join(cwd, "custom-pins.json");
	const linked = join(cwd, "linked-pins.json");
	writeFileSync(custom, readFileSync(runtimePinsFile));
	symlinkSync(custom, linked);
	const script = join(cwd, "read-pins.mjs");
	writeFileSync(script, `import assert from "node:assert/strict";
import { readRuntimePins } from ${JSON.stringify(new URL("./homebrew-runtime.mjs", import.meta.url).href)};
const pins = readRuntimePins();
assert.deepEqual(readRuntimePins(process.argv[2]), pins);
assert.throws(() => readRuntimePins(process.argv[3]), { code: "ELOOP" });
assert.throws(() => readRuntimePins("/etc/passwd"), /must be inside/);
process.stdout.write(JSON.stringify(pins));
`);
	const output = execFileSync(process.execPath, [script, "custom-pins.json", "linked-pins.json"], { cwd, encoding: "utf8", env: {
		...process.env, HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
	} });
	assert.deepEqual(JSON.parse(output), readRuntimePins());
});

test("Homebrew file paths reject untrusted roots, control characters, and parent links", () => {
	for (const file of ["/etc/passwd", "/usr/local/manifest.json", "/tmp/../etc/passwd", join(directory, "bad\n.json"), join(directory, "bad\\file.json"), "", ".", ".."])
		assert.throws(() => resolveHomebrewFile(file));
	const linked = join(directory, "linked-parent");
	symlinkSync(directory, linked);
	assert.throws(() => resolveHomebrewFile(join(linked, "manifest.json")), /symlink/);
});

test("retained reads reject symlinks, empty/oversized files, directories, and FIFOs without blocking", () => {
	const file = join(directory, "regular.json");
	writeFileSync(file, "retained bytes");
	const link = join(directory, "linked.json");
	symlinkSync(file, link);
	assert.throws(() => readHomebrewFile(link), { code: "ELOOP" });
	assert.throws(() => readHomebrewFile(link, 1024, { optional: true }), { code: "ELOOP" });
	assert.throws(() => readHomebrewFile(file, 1), /Invalid regular retained file/);
	assert.throws(() => readHomebrewFile(directory), /Invalid regular retained file/);
	const empty = join(directory, "empty.json");
	writeFileSync(empty, "");
	assert.throws(() => readHomebrewFile(empty), /Invalid regular retained file/);
	const fifo = join(directory, "fifo.json");
	execFileSync("mkfifo", [fifo]);
	assert.throws(() => readHomebrewFile(fifo), /Invalid regular retained file/);
	assert.equal(readHomebrewFile(join(directory, "missing.json"), 1024, { optional: true }), undefined);
	assert.throws(() => readHomebrewFile(join(directory, "missing.json")), { code: "ENOENT" });
});

test("retained reads inspect and read the same descriptor even when its pathname is replaced", () => {
	const file = join(directory, "race.json");
	const saved = join(directory, "original.json");
	const other = join(directory, "other.json");
	writeFileSync(file, "original retained bytes");
	writeFileSync(other, "replacement bytes must not be read");
	const fstat = fs.fstatSync;
	const spy = mock.method(fs, "fstatSync", (descriptor) => {
		renameSync(file, saved);
		symlinkSync(other, file);
		return fstat(descriptor);
	});
	syncBuiltinESMExports();
	try {
		assert.equal(readHomebrewFile(file).toString(), "original retained bytes");
		assert.equal(spy.mock.callCount(), 1);
	} finally {
		spy.mock.restore();
		syncBuiltinESMExports();
	}
});

test("retained reads bound concurrent growth to the inspected size plus one byte", () => {
	const file = join(directory, "growing.json");
	writeFileSync(file, "small");
	const fstat = fs.fstatSync;
	const spy = mock.method(fs, "fstatSync", (descriptor) => {
		const stat = fstat(descriptor);
		writeFileSync(file, "this file grew after the descriptor was inspected");
		return stat;
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => readHomebrewFile(file), /size changed while reading/);
	} finally {
		spy.mock.restore();
		syncBuiltinESMExports();
	}
});
