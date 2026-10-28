import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ACCEPTANCE_MANAGERS, PNPM_VERSION } from "./artifact-installation.mjs";
import {
	installPublicPackage,
	validateAcceptanceManifest,
	verifyInstalledFiles,
	verifyPublicDiscovery,
} from "./public-release-acceptance.mjs";

const manifest = {
	schemaVersion: 1,
	version: "0.2.2",
	source: { repository: "diffexai/diffex", commit: "a".repeat(40) },
	packages: [
		{
			name: "@diffexai/diffex",
			version: "0.2.2",
			size: 1,
			sha256: "b".repeat(64),
			integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
		},
	],
};

test("native and public acceptance provision the same exact pnpm release without dropping npm or Bun", () => {
	assert.deepEqual(ACCEPTANCE_MANAGERS, ["npm", "pnpm", "bun"]);
	assert.equal(PNPM_VERSION, "10.28.2");
	for (const name of ["native-artifact-acceptance.yml", "artifact-acceptance.yml"]) {
		const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
		assert(workflow.includes(`npm install -g npm@11.16.0 pnpm@${PNPM_VERSION} --ignore-scripts`));
		assert(workflow.includes("bun-version: '1.3.11'"));
		assert(workflow.includes("persist-credentials: false"));
	}
	const publicWorkflow = readFileSync(new URL("../.github/workflows/artifact-acceptance.yml", import.meta.url), "utf8");
	assert(publicWorkflow.includes("/scripts/artifact-installation.mjs"), "Sparse public tools must include isolated pnpm support");
});

test("public npm initial and fresh installs require scripts enabled by default without overriding configuration", () => {
	const commands = [];
	const run = (command, args) => {
		commands.push({ command, args });
		return args[0] === "config" ? "false" : "installed";
	};
	for (const version of ["0.2.1", manifest.version]) {
		assert.deepEqual(installPublicPackage("npm", version, run), {
			version, lifecycleScripts: "enabled", ignoreScripts: "false",
		});
	}
	assert.deepEqual(commands, ["0.2.1", manifest.version].flatMap((version) => [
		{ command: "npm", args: ["config", "get", "ignore-scripts"] },
		{ command: "npm", args: ["install", "-g", `@diffexai/diffex@${version}`, "--registry=https://registry.npmjs.org"] },
	]));
	for (const ignoreScripts of ["true", "", "undefined"]) {
		const rejected = [];
		assert.throws(() => installPublicPackage("npm", manifest.version, (command, args) => {
			rejected.push({ command, args });
			return ignoreScripts;
		}), /requires scripts enabled by default/);
		assert.deepEqual(rejected, [{ command: "npm", args: ["config", "get", "ignore-scripts"] }]);
	}
});

test("public pnpm and Bun installs retain explicit scripts-disabled behavior and evidence", () => {
	for (const manager of ["pnpm", "bun"]) {
		const commands = [];
		assert.deepEqual(installPublicPackage(manager, manifest.version, (command, args) => {
			commands.push({ command, args });
		}), { version: manifest.version, lifecycleScripts: "disabled", ignoreScripts: null });
		assert.deepEqual(commands, [{ command: manager, args: ["install", "-g", "--ignore-scripts", `@diffexai/diffex@${manifest.version}`] }]);
	}
	const unexpected = () => assert.fail("Invalid install must not execute a command");
	assert.throws(() => installPublicPackage("unknown", manifest.version, unexpected), /Unsupported package manager/);
	assert.throws(() => installPublicPackage("npm", "latest", unexpected), /stable installation version/);
});

test("public acceptance rejects unreviewed identities and non-upgrades before installation", () => {
	assert.equal(validateAcceptanceManifest(manifest, "0.2.1"), manifest.packages[0]);
	for (const previous of ["0.2.2", "0.3.0", "0.2.1-beta.1", "--force", "0.2.1\n"])
		assert.throws(() => validateAcceptanceManifest(manifest, previous));
	for (const invalid of [
		{ ...manifest, source: { ...manifest.source, commit: "main" } },
		{ ...manifest, source: { ...manifest.source, repository: "foreign/cli" } },
		{ ...manifest, schemaVersion: 2 },
		{ ...manifest, version: "0.2.2-beta.1" },
		{ ...manifest, packages: [] },
		{ ...manifest, packages: [...manifest.packages, ...manifest.packages] },
		...Object.entries({
			name: "@foreign/cli",
			version: "0.2.3",
			sha256: "invalid",
			integrity: "sha512-invalid",
			size: 0,
		}).map(([key, value]) => ({ ...manifest, packages: [{ ...manifest.packages[0], [key]: value }] })),
	])
		assert.throws(() => validateAcceptanceManifest(invalid, "0.2.1"));
});

test("public acceptance requires the exact announced version with no-store JSON", async () => {
	const valid = { version: "0.2.2", packageName: "@diffexai/diffex" };
	const headers = { "content-type": "application/json", "cache-control": "no-store" };
	const response = await verifyPublicDiscovery("0.2.2", async (url, init) => {
		assert.equal(url, "https://api.diffex.ai/api/latest-version");
		assert.equal(init.redirect, "error");
		return new Response(JSON.stringify(valid), { headers });
	});
	assert.deepEqual(response.body, valid);
	for (const [status, body, extraHeaders] of [
		[404, { error: "no_published_release" }, {}],
		[503, { error: "release_unavailable" }, {}],
		[302, valid, { location: "https://foreign.invalid" }],
		[200, { ...valid, version: "0.2.1" }, {}],
		[200, { ...valid, packageName: "@foreign/cli" }, {}],
		[200, { ...valid, internal: true }, {}],
		[200, valid, { "cache-control": "max-age=60" }],
		[200, valid, { "content-type": "text/html" }],
	])
		await assert.rejects(
			verifyPublicDiscovery(
				"0.2.2",
				async () => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extraHeaders } }),
			),
		);
});

test("installed acceptance catches file changes, replaced inventories, and escaping links", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-public-files-"));
	try {
		const directory = join(root, "package");
		mkdirSync(directory);
		writeFileSync(join(root, "outside.js"), "runtime");
		const inventory = {
			files: [{ path: "runtime.js", sha256: createHash("sha256").update("runtime").digest("hex") }],
		};
		writeFileSync(join(directory, "distribution-files.json"), JSON.stringify(inventory));
		writeFileSync(join(directory, "runtime.js"), "runtime");
		verifyInstalledFiles(directory, inventory);
		writeFileSync(join(directory, "runtime.js"), "tampered");
		assert.throws(() => verifyInstalledFiles(directory, inventory));
		rmSync(join(directory, "runtime.js"));
		symlinkSync(join(root, "outside.js"), join(directory, "runtime.js"));
		assert.throws(() => verifyInstalledFiles(directory, inventory), /escapes/);
		writeFileSync(join(directory, "distribution-files.json"), JSON.stringify({ files: [] }));
		assert.throws(() => verifyInstalledFiles(directory, inventory));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
