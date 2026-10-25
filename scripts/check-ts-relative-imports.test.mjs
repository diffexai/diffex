import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-ts-relative-imports.mjs", import.meta.url));

function runFixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "diffex-relative-imports-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const scratch = join(root, "scratch");
	mkdirSync(scratch);
	for (const [file, content] of Object.entries(files)) {
		const path = join(root, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	const result = spawnSync(process.execPath, [script], {
		cwd: root,
		env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.stdout, "");
	assert.deepEqual(readdirSync(scratch), [], "native client and temporary project must be cleaned up");
	return result;
}

test("reports every AST import form with decoded specifiers and exact UTF-16 locations", (t) => {
	const result = runFixture(t, {
		// Excluded files still need inspection: the check must not use repository tsconfigs.
		"tsconfig.json": JSON.stringify({ files: [], exclude: ["**/*"] }),
		"a.ts": [
			'import value from "./default.js";',
			'import "../side-effect.js?raw";',
			'import type { Value } from "./types.js#types";',
			'export { value } from "../named.js?raw#fragment";',
			'export * from "./star.js";',
			'export * as ns from "./namespace.js";',
			'export type { Value } from "./export-type.js";',
			'const promise = import("./dynamic.js");',
			'const template = import(`../template.js#fragment`);',
			'type T = import("./import-type.js").Value;',
			'type Module = typeof import("../typeof.js?raw");',
			"const multiline = import(",
			"  /* before specifier */",
			'  "./multiline.js?raw",',
			'  { with: { type: "json" } },',
			");",
			"import {",
			"  other,",
			"} from /* trivia */",
			'  "../multiline-static.js";',
			'type Multiline = import(',
			'  /* trivia */ "./multiline-type.js"',
			").Value;",
			String.raw`import "\u002e/escaped\x2ejs?raw";`,
			String.raw`export * from ".\u002e/escaped-export.js";`,
			String.raw`const escaped = import("./dynamic\u002ejs");`,
			String.raw`type Escaped = import("./type\x2ejs").Value;`,
			'const emoji = "😀"; import("./unicode.js");',
		].join("\r\n"),
		"nested/b.ts": 'export { x } from "./nested.js";\n',
	});
	assert.equal(result.status, 1, result.stderr);
	assert.equal(
		result.stderr,
		[
			"Relative .js imports are not allowed in non-declaration .ts files:",
			"  a.ts:1:19: ./default.js",
			"  a.ts:2:8: ../side-effect.js?raw",
			"  a.ts:3:28: ./types.js#types",
			"  a.ts:4:23: ../named.js?raw#fragment",
			"  a.ts:5:15: ./star.js",
			"  a.ts:6:21: ./namespace.js",
			"  a.ts:7:28: ./export-type.js",
			"  a.ts:8:24: ./dynamic.js",
			"  a.ts:9:25: ../template.js#fragment",
			"  a.ts:10:17: ./import-type.js",
			"  a.ts:11:29: ../typeof.js?raw",
			"  a.ts:14:3: ./multiline.js?raw",
			"  a.ts:20:3: ../multiline-static.js",
			"  a.ts:22:16: ./multiline-type.js",
			"  a.ts:24:8: ./escaped.js?raw",
			"  a.ts:25:15: ../escaped-export.js",
			"  a.ts:26:24: ./dynamic.js",
			"  a.ts:27:23: ./type.js",
			"  a.ts:28:28: ./unicode.js",
			"  nested/b.ts:1:19: ./nested.js",
			"",
		].join("\n"),
	);
});

test("ignores comments, string contents, non-relative/non-js specifiers and excluded files", (t) => {
	const forbidden = 'import "./ignored.js";\n';
	const result = runFixture(t, {
		"src/clean.ts": [
			'// import "./comment.js";',
			'/* export * from "../comment.js"; import("./comment.js"); */',
			'/** @type {import("./jsdoc.js").Value} */',
			String.raw`const text = 'import "./string.js";';`,
			'const template = `export * from "./string.js";`;',
			'const ordinary = "./ordinary.js";',
			'import "package.js";',
			'import "/absolute.js";',
			'import "./source.ts";',
			'import "../extensionless";',
			'import "./other.mjs";',
			'import "./other.jsx";',
			'import "./other.js.map";',
			'import "./other.json?raw";',
			'export * from "package.js#fragment";',
			'import("https://example.com/remote.js");',
			'import(`./${name}.js`);',
			'import("./" + name + ".js");',
			'require("./require.js");',
			'object.import("./method.js");',
			'type T = import("./types.ts").Value;',
			'import type { Ignored } from "./ignored.d.ts";',
		].join("\n"),
		"src/ignored.d.ts": forbidden,
		"node_modules/pkg/index.ts": forbidden,
		"src/node_modules/pkg/index.ts": forbidden,
		".git/ignored.ts": forbidden,
		"coverage/ignored.ts": forbidden,
		"dist/ignored.ts": forbidden,
		"src/dist/ignored.ts": forbidden,
		"ignored.js": forbidden,
		"ignored.tsx": forbidden,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
});

test("an empty source tree passes without creating a native project", (t) => {
	const result = runFixture(t, { "only.d.ts": 'export * from "./ignored.js";' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
});
