import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliDistribution } from "./cli-distribution.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

test("only the CLI is public and its install manifest never fetches private Diffex packages", () => {
	const { manifest, bundled } = cliDistribution();
	assert.deepEqual(
		getPublicWorkspacePackages().map((pkg) => pkg.name),
		["@diffexai/diffex"],
	);
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
		assert(!Object.keys(manifest[field] ?? {}).some((name) => name.startsWith("@diffexai/")));
	assert.equal(manifest.imports["#evolution"], "./dist/vendor/evolution/index.js");
	assert.equal(manifest.imports["#harness-trace"], "./dist/vendor/harness-trace/index.js");
	assert.deepEqual(
		bundled.map((pkg) => pkg.manifest.name),
		[
			"@diffexai/diffex-agent-core",
			"@diffexai/diffex-ai",
			"@diffexai/diffex-client",
			"@diffexai/diffex-harness-state",
			"@diffexai/diffex-protocol",
			"@diffexai/diffex-telemetry",
			"@diffexai/diffex-tui",
		],
	);
	for (const pkg of bundled) assert.equal(pkg.manifest.private, true);
	for (const file of ["npm-shrinkwrap.json", "install-lock/package-lock.json"]) {
		const lock = JSON.parse(readFileSync(join("packages/coding-agent", file), "utf8"));
		for (const entry of Object.values(lock.packages)) {
			for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }))
				assert(!dependency.startsWith("@diffexai/") || dependency === "@diffexai/diffex");
			if (entry.resolved?.includes("/@diffexai/")) assert.match(entry.resolved, /\/@diffexai\/diffex\/-\/diffex-/);
		}
	}
});

test("an unreviewed private dependency cannot silently enter the public CLI tarball", () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-disclosure-"));
	try {
		const write = (path, value) => {
			mkdirSync(join(directory, path, ".."), { recursive: true });
			writeFileSync(join(directory, path), JSON.stringify(value));
		};
		write("docs/release/distribution-policy.json", {
			status: "approved",
			bundledWorkspaces: ["evolution", "harness-trace"],
		});
		write("packages/coding-agent/package.json", {
			name: "@diffexai/diffex",
			version: "0.2.1",
			dependencies: { "@diffexai/private-extra": "0.2.1" },
		});
		for (const [path, name] of [
			["evolution", "diffex-evolution"],
			["harness-trace", "diffex-harness-trace"],
			["private-extra", "private-extra"],
		])
			write(`packages/${path}/package.json`, { name: `@diffexai/${name}`, version: "0.2.1", private: true });
		assert.throws(() => cliDistribution(directory), /approved disclosure policy/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
