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
	const omittedFiles = new Set(Array.isArray(omit) ? omit : omit ? [omit] : []);
	const files = {
		...Object.fromEntries(distributionDocs.map((path) => [path, "Reviewed user guide"])),
		"README.md": "Diffex installation and usage",
		"package.json": JSON.stringify({ name: "@diffexai/diffex", version, license: "MIT" }),
		LICENSE: readFileSync(license),
		"THIRD-PARTY-NOTICES.txt": "Test fixture with no external bundled dependencies.\n",
		"distribution-components.json": JSON.stringify([{ name: "Diffex", license: "MIT" }]),
		"dist/index.js": "export const value = 1;\n",
		"dist/index.d.ts": "export declare const value: number;\n",
		"dist/AGENTS.md": readFileSync("AGENTS_release.md"),
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
			.filter(([name]) => !omittedFiles.has(name) && (name.startsWith("dist/") || (name.startsWith("native/") && name.endsWith(".node"))))
			.map(([name, data]) => ({ path: name, sha256: createHash("sha256").update(data).digest("hex") })),
	});
	for (const [name, data] of Object.entries(files)) {
		if (omittedFiles.has(name)) continue;
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
	});
	assert.equal(result.status, 0, result.stderr);
});

test("accepts the Radius removal explanation without restoring the integration", () => {
	const result = inspect({ "dist/removed.js": 'export const message = "Radius support has been removed.";' });
	assert.equal(result.status, 0, result.stderr);
});

for (const [path, content] of [
	["dist/node_modules/@diffexai/diffex-ai/dist/providers/radius.js", "export const provider = {};"],
	["dist/node_modules/@diffexai/diffex-ai/dist/providers/radius-config.d.ts", "export declare const gateway: string;"],
	["dist/node_modules/@diffexai/diffex-ai/dist/auth/oauth/radius.js", "export const login = () => {};"],
	["dist/core/radius.js", "export const provider = {};"],
	["dist/renamed.js", 'export const gateway = "https://radius.pi.dev";'],
	["dist/renamed.mjs", 'export const issuer = "https://radius.earendil.com";'],
	["dist/renamed.cjs", 'exports.key = process.env.RADIUS_API_KEY;'],
	["dist/bundle.node", Buffer.from('binary\0client_id=pi-gateway\0')],
]) {
	test(`rejects removed Radius integration in ${path}`, () => {
		const result = inspect({ [path]: content });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /removed Radius integration/);
	});
}

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
	["docs/usage.md", "Previously published user guide", /unapproved distribution documentation/],
	["docs/images/interactive-mode.png", Buffer.from("image fixture"), /unapproved distribution documentation/],
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
	["dist/AGENTS.md", "Private repository instructions", /prohibited repository instructions/],
	["AGENTS_release.md", readFileSync("AGENTS_release.md"), /unapproved distribution documentation/],
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
	const nested = fixture({ "dist/private.ts": "export const hidden = 1" }, ["README.md", "dist/AGENTS.md"]);
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

test("rejects the approved default instructions inside a nested archive", () => {
	const nested = fixture({}, "README.md");
	try {
		const result = inspect({ "dist/resource.bin": readFileSync(nested.archive) });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /prohibited repository instructions/);
	} finally {
		rmSync(nested.directory, { recursive: true, force: true });
	}
});

test("rejects a CLI artifact missing the default instructions", () => {
	const result = inspect({}, "dist/AGENTS.md");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /missing required default instructions/);
});

test("rejects a case variant of the approved default path", () => {
	const result = inspect({ "dist/agents.MD": readFileSync("AGENTS_release.md") }, "dist/AGENTS.md");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /prohibited repository instructions/);
});

test("rejects default instructions in a non-CLI package", () => {
	const { directory, archive } = fixture({
		"package.json": JSON.stringify({ name: "@diffexai/diffex-agent-core", version, license: "MIT" }),
	});
	try {
		const result = spawnSync("python3", [checker, archive, "--license", license], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /prohibited repository instructions/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects substituted package identity and license metadata", () => {
	for (const replacement of [
		{ name: "foreign", license: "MIT" },
		{ name: "@diffexai/diffex", license: "Apache-2.0" },
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

for (const guide of ["README.md"]) {
	test(`rejects a CLI artifact missing required user documentation ${guide}`, () => {
		const result = inspect({}, guide);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /missing required user documentation/);
	});
}
