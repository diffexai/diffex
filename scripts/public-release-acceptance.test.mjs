import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
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
