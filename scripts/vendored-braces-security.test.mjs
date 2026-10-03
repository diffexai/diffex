import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const shxRequire = createRequire(require.resolve("shx/package.json"));
const shellRequire = createRequire(shxRequire.resolve("shelljs"));
const globRequire = createRequire(shellRequire.resolve("fast-glob"));
const matchRequire = createRequire(globRequire.resolve("micromatch"));
const braces = matchRequire("braces");
const glob = shellRequire("fast-glob");
const match = globRequire("micromatch");
const nested = (depth, open = "{", close = "}") => open.repeat(depth) + "x" + close.repeat(depth);

function directAst(depth) {
	let node = { type: "text", value: "x" };
	for (let i = 0; i < depth; i++) {
		const parent = { type: "paren", nodes: [node] };
		node.parent = parent;
		node = parent;
	}
	const root = { type: "root", nodes: [node] };
	node.parent = root;
	return root;
}

test("actual shx dependency resolves the transparent private patch", () => {
	const manifest = matchRequire("braces/package.json");
	assert.equal(manifest.name, "@diffex-cloud/braces");
	assert.equal(manifest.version, "3.0.3-diffex.1");
});

for (const [open, close] of [
	["{", "}"],
	["(", ")"],
	["{(", ")}"],
]) {
	test(`bounds combined nesting for ${open}`, () => {
		const boundary = open.length === 2 ? 50 : 100;
		for (const method of ["parse", "compile", "expand", "stringify"]) {
			assert.doesNotThrow(() => braces[method](nested(boundary, open, close)));
			assert.throws(() => braces[method](nested(boundary + 1, open, close)), /maximum depth/u);
		}
		assert.throws(() => braces(nested(4000), { maxDepth: Infinity }), /maximum depth/u);
	});
}

for (const method of ["compile", "expand", "stringify"]) {
	test(`protects caller-supplied ASTs in ${method}`, () => {
		assert.doesNotThrow(() => braces[method](directAst(100)));
		assert.throws(() => braces[method](directAst(4000)), /maximum depth/u);
		const cycle = { type: "root", nodes: [] };
		cycle.nodes.push(cycle);
		assert.throws(() => braces[method](cycle), /maximum depth/u);
		const array = [];
		array.push(array);
		assert.throws(
			() => braces[method]({ type: "root", nodes: [{ type: "text", value: array }] }),
			/AST values must be strings/u,
		);
	});
}

test("bounds cyclic parent traversal and recursive helper arrays", () => {
	const parent = { type: "paren", nodes: [] };
	parent.parent = parent;
	assert.throws(() => braces.expand(parent), /maximum depth/u);
	const utils = createRequire(matchRequire.resolve("braces"))("./lib/utils.js");
	let deep = ["x"];
	for (let i = 0; i < 4000; i++) deep = [deep];
	assert.throws(() => utils.flatten(deep), /maximum depth/u);
	const cycle = [];
	cycle.push(cycle);
	assert.throws(() => utils.flatten(cycle), /maximum depth/u);
});

test("validates range AST values before numeric coercion", () => {
	let step = ["1"];
	for (let i = 0; i < 4000; i++) step = [step];
	for (const method of ["compile", "expand", "stringify"]) {
		const range = {
			type: "root",
			nodes: [
				{
					type: "brace",
					nodes: ["1", "2", step].map((value) => ({ type: "text", value })),
					open: true,
					close: true,
					commas: 0,
					ranges: 1,
				},
			],
		};
		assert.throws(() => braces[method](range), /AST values must be strings/u);
	}
});

test("preserves alternatives, ranges, escaping, and options", () => {
	assert.deepEqual(braces.expand("a/{b,{c,d}}/{01..03..2}"), [
		"a/b/01",
		"a/b/03",
		"a/c/01",
		"a/c/03",
		"a/d/01",
		"a/d/03",
	]);
	assert.deepEqual(braces.expand("{a..e..2}"), ["a", "c", "e"]);
	assert.deepEqual(braces.expand("{-2..2}"), ["-2", "-1", "0", "1", "2"]);
	assert.deepEqual(braces.expand("{a,b}{c,d}"), ["ac", "ad", "bc", "bd"]);
	assert.deepEqual(braces("{a,b}"), ["(a|b)"]);
	assert.deepEqual(braces(["{a,a}", "{a,b}"], { expand: true, nodupes: true }), ["a", "b"]);
	assert.deepEqual(braces.expand("{,a}", { noempty: true }), ["a"]);
	for (const literal of [
		'"' + nested(150) + '"',
		"[" + nested(150) + "]",
		"\\{".repeat(150) + "x" + "\\}".repeat(150),
	])
		assert.doesNotThrow(() => braces(literal));
	assert.equal(braces.stringify(braces.parse("a/{b,c}/d")), "a/{b,c}/d");
	assert.throws(() => braces.expand("{1..2000}"), /range limit/u);
});

test("preserves installed glob consumers and actual build-tool CLI behavior", () => {
	assert.deepEqual(match(["a.ts", "b.js", "c.md"], ["*.{ts,js}"]), ["a.ts", "b.js"]);
	const directory = mkdtempSync(join(tmpdir(), "diffex-braces-"));
	try {
		for (const file of ["a.txt", "b.txt", ".hidden.txt", "skip.md"]) writeFileSync(join(directory, file), "fixture");
		assert.deepEqual(glob.sync(["*.{txt,md}"], { cwd: directory, dot: true }).sort(), [
			".hidden.txt",
			"a.txt",
			"b.txt",
			"skip.md",
		]);
		const output = join(directory, "out");
		mkdirSync(output);
		const copied = spawnSync(process.execPath, [require.resolve("shx/lib/cli.js"), "cp", "*.{txt,md}", output], {
			cwd: directory,
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.ifError(copied.error);
		assert.equal(copied.status, 0, copied.stderr);
		assert.deepEqual(readdirSync(output).sort(), ["a.txt", "b.txt", "skip.md"]);
		assert.throws(() => glob.sync([nested(4000)], { cwd: directory, dot: true }), /maximum depth/u);
		assert.deepEqual(match(["x"], [nested(4000)]), []);
		const rejected = spawnSync(process.execPath, [require.resolve("shx/lib/cli.js"), "ls", nested(4000)], {
			cwd: directory,
			encoding: "utf8",
			timeout: 10_000,
		});
		assert.ifError(rejected.error);
		assert.equal(rejected.signal, null);
		assert.equal(rejected.status, 2);
		assert.doesNotMatch(rejected.stderr, /Maximum call stack|RangeError/u);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
