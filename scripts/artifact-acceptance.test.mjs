import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertContained,
	candidateInstallationOptions,
	declaredEntrypoints,
	isolatedEnvironment,
	operations,
	packageClosure,
	verifyTarballs,
} from "./artifact-acceptance.mjs";
import { cliDistribution } from "./cli-distribution.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

test("native candidate consumers explicitly enable npm hooks and keep pnpm and Bun disabled", () => {
	assert.deepEqual(candidateInstallationOptions("npm"), { lifecycleScripts: "enabled" });
	for (const manager of ["pnpm", "bun"])
		assert.deepEqual(candidateInstallationOptions(manager), { lifecycleScripts: "disabled" });
	assert.throws(() => candidateInstallationOptions("unknown"), /Unsupported package manager/);
});

test("every public package has an operation and a dependency-first local closure", () => {
	const packages = getPublicWorkspacePackages().map((pkg) => cliDistribution().manifest);
	assert.equal(packages.length, 1);
	for (const pkg of packages) {
		assert(operations[pkg.name]);
		const closure = packageClosure(pkg.name, packages);
		assert.equal(closure.at(-1).name, pkg.name);
		for (const [index, dependency] of closure.entries()) {
			for (const name of Object.keys(dependency.dependencies ?? {}).filter((name) => name.startsWith("@diffexai/"))) {
				assert(closure.findIndex((entry) => entry.name === name) < index);
			}
		}
	}
	assert.throws(() => packageClosure("@diffexai/missing", packages), /Missing local/);
	assert.throws(
		() => packageClosure("@diffexai/a", [{ name: "@diffexai/a", dependencies: { "@diffexai/a": "*" } }]),
		/cycle/,
	);
});

test("changed archive bytes, duplicate identities and missing packages fail before installation", () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex checksums "));
	try {
		const pkg = { name: "@diffexai/example", version: "1.0.0" };
		const bytes = Buffer.from("final archive bytes");
		const record = {
			...pkg,
			filename: "diffexai-example-1.0.0.tgz",
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
		writeFileSync(join(directory, record.filename), bytes);
		verifyTarballs(directory, [record], [pkg]);
		assert.throws(() => verifyTarballs(directory, [], [pkg]), /Incomplete/);
		assert.throws(() => verifyTarballs(directory, [record, record], [pkg, pkg]), /Duplicate/);
		writeFileSync(join(directory, record.filename), Buffer.concat([bytes, Buffer.from("tampered")]));
		assert.throws(() => verifyTarballs(directory, [record], [pkg]), /checksum mismatch/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("declared exports include patterns and reject missing declarations and escaping links", () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex exports "));
	try {
		const consumer = join(directory, "consumer");
		mkdirSync(join(consumer, "dist"), { recursive: true });
		writeFileSync(join(consumer, "dist/a.js"), "export const value = 1;");
		const pkg = { name: "@diffexai/example", exports: { "./*": { import: "./dist/*.js", types: "./dist/*.d.ts" } } };
		assert.throws(() => declaredEntrypoints(pkg, consumer), /Empty export/);
		writeFileSync(join(consumer, "dist/a.d.ts"), "export declare const value: number;");
		assert.deepEqual(declaredEntrypoints(pkg, consumer), ["@diffexai/example/a"]);
		writeFileSync(join(directory, "outside.js"), "");
		symlinkSync(join(directory, "outside.js"), join(consumer, "escape.js"));
		assert.throws(() => assertContained(join(consumer, "escape.js"), consumer), /escapes isolated/);
		const env = isolatedEnvironment(consumer);
		assert.equal(env.NODE_PATH, undefined);
		assert.equal(env.NODE_OPTIONS, undefined);
		assert.equal(env.HOME, join(realpathSync(consumer), "home"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
