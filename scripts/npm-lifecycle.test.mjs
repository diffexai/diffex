import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acceptPnpmLifecycle } from "./npm-lifecycle.mjs";

// This fixture tests the acceptance harness, real pnpm, discovery injection and store behavior.
// It is not the production updater; retained candidate acceptance exercises that installed CLI.
const cli = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (process.argv.includes("--version")) console.log(metadata.version);
else if (process.argv.includes("--help")) console.log("Diffex fixture");
else if (process.argv.includes("update")) {
 const response = await fetch("https://api.diffex.ai/api/latest-version", { redirect: "manual" });
 const release = await response.json();
 if (release.packageName !== metadata.name) throw new Error("Foreign release identity");
 const child = spawn("pnpm", ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", release.packageName + "@" + release.version], { stdio: "inherit", env: process.env });
 process.exitCode = await new Promise((done, reject) => { child.on("close", done); child.on("error", reject); });
} else throw new Error("Unexpected fixture command");
`;

function fixture(directory, failing = false) {
	const metadata = { name: "@diffexai/diffex", version: "1.2.3", type: "module", bin: { diffex: "dist/cli.js" } };
	const files = { "package.json": JSON.stringify(metadata), "dist/cli.js": failing ? "#!/usr/bin/env node\nprocess.exit(41);\n" : cli, "dist/core/http-dispatcher.js": "export {};\n" };
	const inventory = { sourceCommit: "a".repeat(40), files: Object.entries(files).map(([path, value]) => ({ path, sha256: createHash("sha256").update(value).digest("hex") })) };
	for (const [path, value] of Object.entries({ ...files, "distribution-files.json": JSON.stringify(inventory) })) {
		mkdirSync(dirname(join(directory, "package", path)), { recursive: true });
		writeFileSync(join(directory, "package", path), value);
	}
	chmodSync(join(directory, "package/dist/cli.js"), 0o755);
	const archive = join(directory, "fixture.tgz");
	execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
	return { archive, metadata, inventory };
}

test("real pinned pnpm lifecycle uses isolated local tarballs, discovery fixtures, cold stores and offline cache reuse", { timeout: 180000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-pnpm-lifecycle-test-"));
	try {
		const { archive, metadata, inventory } = fixture(directory);
		const evidence = await acceptPnpmLifecycle(archive, metadata, inventory);
		assert.equal(evidence.status, "passed");
		assert.equal(evidence.cleanup, true);
		assert.equal(evidence.version, "10.28.2");
		assert(evidence.checks.some((check) => check.offlineCacheReuse === "passed"));
		assert(evidence.checks.some((check) => check.corruptIntegrityRejected));
		assert(evidence.tarballRequests >= 3);
		assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex").length, 64);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("pnpm lifecycle failures carry bounded manager-specific diagnostics and cleaned isolation evidence", { timeout: 30000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-pnpm-failure-test-"));
	try {
		const { archive, metadata, inventory } = fixture(directory, true);
		await assert.rejects(acceptPnpmLifecycle(archive, metadata, inventory), (error) => {
			assert.equal(error.pnpmEvidence.status, "failed");
			assert.equal(error.pnpmEvidence.cleanup, true);
			assert.equal(error.pnpmEvidence.manager, "pnpm");
			assert.equal(error.pnpmEvidence.commands.at(-1).exitCode, 41);
			assert.match(error.message, /pnpm lifecycle diagnostics/);
			return true;
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
