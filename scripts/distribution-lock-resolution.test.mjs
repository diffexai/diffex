import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { distributionExternalPackages, resolveExternalDependency } from "./distribution-lock-resolution.mjs";

function fixture() {
	const manifest = { name: "@diffexai/diffex", dependencies: { sdk: "2.0.0", marked: "3.0.0" } };
	const workspaces = new Map([
		[
			manifest.name,
			{
				lockPath: "packages/coding-agent",
				packageJson: { dependencies: { "@diffexai/diffex-ai": "1.0.0", "@diffexai/diffex-tui": "1.0.0" } },
			},
		],
		["@diffexai/diffex-ai", { lockPath: "packages/ai", packageJson: { dependencies: { sdk: "2.0.0" } } }],
		["@diffexai/diffex-tui", { lockPath: "packages/tui", packageJson: { dependencies: { marked: "3.0.0" } } }],
		["@diffexai/diffex-evolution", { lockPath: "packages/evolution", packageJson: {} }],
		["@diffexai/diffex-harness-trace", { lockPath: "packages/harness-trace", packageJson: {} }],
	]);
	const lockPackages = {
		"node_modules/sdk": { version: "1.0.0" },
		"packages/ai/node_modules/sdk": {
			version: "2.0.0",
			dependencies: { shared: "2.0.0" },
			optionalDependencies: { native: "1.0.0" },
		},
		"packages/ai/node_modules/shared": { version: "2.0.0", dependencies: { sdk: "2.0.0" } },
		"packages/ai/node_modules/native": {
			version: "1.0.0",
			optional: true,
			os: ["darwin"],
			cpu: ["arm64"],
			integrity: "native-integrity",
		},
		"packages/tui/node_modules/marked": { version: "3.0.0", dependencies: { shared: "1.0.0" } },
		"node_modules/shared": { version: "1.0.0" },
	};
	return { manifest, workspaces, lockPackages, copyEntry: (entry) => ({ ...entry }) };
}

test("relocates workspace-local direct, transitive, optional and conflicting nested versions", () => {
	const input = fixture();
	const original = JSON.stringify(input.lockPackages);
	const packages = distributionExternalPackages(input);
	assert.equal(packages["node_modules/sdk"].version, "2.0.0");
	assert.equal(packages["node_modules/marked"].version, "3.0.0");
	const sdkShared = resolveExternalDependency(packages, "shared", "node_modules/sdk");
	const markedShared = resolveExternalDependency(packages, "shared", "node_modules/marked");
	assert.equal(packages[sdkShared].version, "2.0.0");
	assert.equal(packages[markedShared].version, "1.0.0");
	assert.equal(resolveExternalDependency(packages, "sdk", sdkShared), "node_modules/sdk");
	const native = resolveExternalDependency(packages, "native", "node_modules/sdk");
	assert.deepEqual(packages[native], input.lockPackages["packages/ai/node_modules/native"]);
	assert.ok(Object.keys(packages).every((path) => path.startsWith("node_modules/")));
	assert.equal(JSON.stringify(input.lockPackages), original);
	assert.deepEqual(distributionExternalPackages(input), packages);
});

test("both generators emit deterministic deployable locks in an isolated fixture", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-lock-resolution-"));
	try {
		const input = fixture();
		input.manifest.version = "1.0.0";
		for (const [name, version] of [
			["@google/genai", "2.31.0"],
			["protobufjs", "7.6.5"],
		]) {
			input.manifest.dependencies[name] = version;
			input.workspaces.get(input.manifest.name).packageJson.dependencies[name] = version;
			input.lockPackages[`node_modules/${name}`] = { version, hasInstallScript: true };
		}
		mkdirSync(join(root, "scripts"));
		for (const file of [
			"generate-coding-agent-shrinkwrap.mjs",
			"generate-coding-agent-install-lock.mjs",
			"distribution-lock-resolution.mjs",
		]) {
			copyFileSync(new URL(file, import.meta.url), join(root, "scripts", file));
		}
		writeFileSync(
			join(root, "scripts/cli-distribution.mjs"),
			`export function cliDistribution() { return { manifest: ${JSON.stringify(input.manifest)} }; }\n`,
		);
		for (const [name, workspace] of input.workspaces) {
			const manifest = { name, version: "1.0.0", ...workspace.packageJson };
			mkdirSync(join(root, workspace.lockPath), { recursive: true });
			writeFileSync(join(root, workspace.lockPath, "package.json"), JSON.stringify(manifest));
			input.lockPackages[workspace.lockPath] = manifest;
		}
		writeFileSync(
			join(root, "package-lock.json"),
			JSON.stringify({ lockfileVersion: 3, packages: input.lockPackages }),
		);
		for (const generator of ["generate-coding-agent-shrinkwrap.mjs", "generate-coding-agent-install-lock.mjs"]) {
			for (const args of [[], ["--check"]]) {
				const result = spawnSync(process.execPath, [join(root, "scripts", generator), ...args], {
					encoding: "utf8",
				});
				assert.equal(result.status, 0, result.stderr);
			}
		}
		const shrinkwrap = JSON.parse(readFileSync(join(root, "packages/coding-agent/npm-shrinkwrap.json"), "utf8"));
		const install = JSON.parse(
			readFileSync(join(root, "packages/coding-agent/install-lock/package-lock.json"), "utf8"),
		);
		for (const lock of [shrinkwrap, install]) {
			assert.ok(Object.keys(lock.packages).every((path) => !path || path.startsWith("node_modules/")));
			assert.equal(lock.packages["node_modules/sdk"].version, "2.0.0");
			assert.equal(lock.packages["node_modules/marked"].version, "3.0.0");
		}
		for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
			if (path) assert.deepEqual(install.packages[path], entry);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lookup follows Node ancestors and never falls back to an unrelated unique entry", () => {
	assert.throws(
		() =>
			resolveExternalDependency({ "packages/other/node_modules/only": { version: "1.0.0" } }, "only", "packages/ai"),
		/Cannot resolve/,
	);
	const packages = {
		"node_modules/@scope/pkg/node_modules/dep": { version: "2.0.0" },
		"node_modules/@scope/pkg/node_modules/node_modules/dep": { version: "wrong" },
	};
	assert.equal(
		resolveExternalDependency(packages, "dep", "node_modules/@scope/pkg/node_modules/child"),
		"node_modules/@scope/pkg/node_modules/dep",
	);
});

test("rejects an exact direct or transitive version mismatch", () => {
	const direct = fixture();
	direct.lockPackages["packages/ai/node_modules/sdk"].version = "1.0.0";
	assert.throws(() => distributionExternalPackages(direct), /sdk@2.0.0 resolves to 1.0.0/);
	const transitive = fixture();
	transitive.lockPackages["packages/ai/node_modules/shared"].version = "9.0.0";
	assert.throws(() => distributionExternalPackages(transitive), /shared@2.0.0 resolves to 9.0.0/);
});

test("rejects flattened workspace resolutions with different transitive graphs", () => {
	const input = fixture();
	input.workspaces.get("@diffexai/diffex-tui").packageJson.dependencies.sdk = "2.0.0";
	input.lockPackages["packages/tui/node_modules/sdk"] = structuredClone(
		input.lockPackages["packages/ai/node_modules/sdk"],
	);
	assert.throws(() => distributionExternalPackages(input), /Conflicting workspace resolutions/);
});

test("preserves deeper scoped overrides and optional dependency spec precedence", () => {
	const input = fixture();
	input.lockPackages["packages/ai/node_modules/sdk"].dependencies["@scope/leaf"] = "1.0.0";
	input.lockPackages["packages/ai/node_modules/sdk"].optionalDependencies["@scope/leaf"] = "2.0.0";
	input.lockPackages["packages/ai/node_modules/sdk/node_modules/@scope/leaf"] = { version: "2.0.0", optional: true };
	const packages = distributionExternalPackages(input);
	const leaf = resolveExternalDependency(packages, "@scope/leaf", "node_modules/sdk");
	assert.equal(packages[leaf].version, "2.0.0");
	assert.equal(packages[leaf].optional, true);
});
