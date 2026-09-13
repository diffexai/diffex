import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import { distributionDocs } from "./cli-distribution.mjs";
import { createDistributionManifest } from "./release-distribution-manifest.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const checker = resolve("scripts/check-distribution-payload.py");
const license = resolve("LICENSE");
const version = getPublicWorkspacePackages()[0].version;

function fixture(extra, omit) {
	const directory = mkdtempSync(join(tmpdir(), "diffex-payload-test-"));
	const files = {
		...Object.fromEntries(distributionDocs.map((path) => [path, "Reviewed user guide"])),
		"README.md": "Diffex installation and usage",
		"package.json": JSON.stringify({ name: "@diffexai/diffex", version, license: "Apache-2.0" }),
		LICENSE: readFileSync(license),
		"THIRD-PARTY-NOTICES.txt": "Test fixture with no external bundled dependencies.\n",
		"distribution-components.json": JSON.stringify([{ name: "Diffex", license: "Apache-2.0 AND MIT" }]),
		"dist/index.js": "export const value = 1;\n",
		"dist/index.d.ts": "export declare const value: number;\n",
		"release/distribution-manifest.json": JSON.stringify(
			createDistributionManifest({
				packages: getPublicWorkspacePackages(),
				sourceCommit: "a".repeat(40),
				policy: { status: "approved", publicHosting: "npmjs", channels: { npmjs: "enable", standalone: "defer" } },
			}),
		),
		"release/install-package.json": readFileSync("packages/coding-agent/install-lock/package.json"),
		"release/install-package-lock.json": readFileSync("packages/coding-agent/install-lock/package-lock.json"),
		...extra,
	};
	files["distribution-files.json"] = JSON.stringify({
		sourceCommit: "a".repeat(40),
		algorithm: "sha256",
		files: Object.entries(files)
			.filter(([name]) => name.startsWith("dist/") || (name.startsWith("native/") && name.endsWith(".node")))
			.map(([name, data]) => ({ path: name, sha256: createHash("sha256").update(data).digest("hex") })),
	});
	for (const [name, data] of Object.entries(files)) {
		if (name === omit) continue;
		const file = join(directory, "package", name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, data);
	}
	const archive = join(directory, "payload.tgz");
	execFileSync("tar", ["-czf", archive, "-C", directory, "package"], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
	return { directory, archive };
}

function inspect(extra = {}, omit) {
	const { directory, archive } = fixture(extra, omit);
	try {
		return spawnSync(
			"python3",
			[checker, archive, "--license", license, "--name", "@diffexai/diffex", "--version", version],
			{ encoding: "utf8" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("accepts a tarball with readable JavaScript, declarations, and complete notices", () => {
	const result = inspect({
		"native/darwin/prebuilds/darwin-arm64/helper.node": Buffer.from("native fixture"),
		"dist/vendor/evolution/index.js": "export const value = 1;",
		"dist/vendor/harness-trace/index.d.ts": "export declare const value: number;",
		"docs/usage.md": "Diffex loads AGENTS.md from the user's project.\n",
	});
	assert.equal(result.status, 0, result.stderr);
});

for (const notice of [
	"LICENSE",
	"THIRD-PARTY-NOTICES.txt",
	"distribution-components.json",
	"distribution-files.json",
]) {
	test(`rejects a tarball missing ${notice}`, () => {
		const result = inspect({}, notice);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing required notice/);
	});
}

test("rejects a separate NOTICE file because attribution is consolidated", () => {
	const result = inspect({ NOTICE: "Duplicate project attribution" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /separate NOTICE file/);
});

for (const [name, content, reason] of [
	["docs/development.md", "Private build instructions", /unapproved distribution documentation/],
	["docs/new-internal-audit.md", "Private evidence", /unapproved distribution documentation/],
	["dist/internal-handoff.txt", "Private handoff", /unapproved distribution documentation/],
	["dist/node_modules/@diffexai/diffex-ai/docs/audit.md", "Private audit", /unapproved distribution documentation/],
	["dist/implementation.ts", "export const value = 1", /prohibited source file/],
	["dist/renamed.js", "export interface Hidden {", /TypeScript implementation content/],
	["dist/native.c", "int main() {}", /prohibited source file/],
	["dist/code.js", "//# sourceMappingURL=data:application/json;base64,e30=", /embedded source map/],
	["dist/renamed.json", '{"version":3,"sourcesContent":["private code"]}', /embedded source map/],
	["dist/runtime.node", Buffer.from("binary\0//# sourceMappingURL=private.map\0"), /embedded source map/],
	["dist/vendor/evals/index.js", "export const hidden = 1", /unapproved vendored workspace/],
	["dist/vendor/evolution/dist/index.js", "export const hidden = 1", /duplicated or malformed/],
	["examples/example.ts", "export const value = 1", /prohibited source or private path/],
	["AGENTS.md", "Private repository instructions", /prohibited repository instructions/],
	["docs/agents.MD", "Private repository instructions", /prohibited repository instructions/],
	[
		"dist/node_modules/@diffexai/diffex-ai/AGENTS.md",
		"Private repository instructions",
		/prohibited repository instructions/,
	],
]) {
	test(`rejects prohibited content in ${name}`, () => {
		const result = inspect({ [name]: content });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, reason);
	});
}

test("inspects a nested archive even when renamed to a binary resource", () => {
	const nested = fixture({ "dist/private.ts": "export const hidden = 1" }, "README.md");
	try {
		const result = inspect({ "dist/resource.bin": readFileSync(nested.archive) });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /prohibited source file/);
	} finally {
		rmSync(nested.directory, { recursive: true, force: true });
	}
});

test("rejects repository instructions inside a nested archive", () => {
	const nested = fixture({ "docs/AGENTS.md": "Private repository instructions" }, "README.md");
	try {
		const result = inspect({ "dist/resource.bin": readFileSync(nested.archive) });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /prohibited repository instructions/);
	} finally {
		rmSync(nested.directory, { recursive: true, force: true });
	}
});

test("rejects substituted package identity and license metadata", () => {
	for (const replacement of [
		{ name: "foreign", license: "Apache-2.0" },
		{ name: "@diffexai/diffex", license: "MIT" },
	]) {
		const result = inspect({ "package.json": JSON.stringify({ version, ...replacement }) });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /package name mismatch|package license must/);
	}
});

for (const name of [
	"release/distribution-manifest.json",
	"release/install-package.json",
	"release/install-package-lock.json",
]) {
	test(`rejects missing or substituted ${name}`, () => {
		const missing = inspect({}, name);
		assert.notEqual(missing.status, 0);
		assert.match(missing.stderr, /missing required release metadata/);
		const substituted = inspect({ [name]: JSON.stringify({ version: "9.9.9" }) });
		assert.notEqual(substituted.status, 0);
		assert.match(substituted.stderr, /identity mismatch/);
	});
}

test("rejects duplicate members before interpreting package metadata", () => {
	const { directory } = fixture({});
	try {
		const archive = join(directory, "duplicate.tar");
		execFileSync("tar", ["-cf", archive, "-C", directory, "package", "package/package.json"], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		const result = spawnSync("python3", [checker, archive, "--license", license], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /duplicate archive path/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

for (const guide of ["README.md", "docs/installation.md"]) {
	test(`rejects a CLI artifact missing required user documentation ${guide}`, () => {
		const result = inspect({}, guide);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing required user documentation/);
	});
}
