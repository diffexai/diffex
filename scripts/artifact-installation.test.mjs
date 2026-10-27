import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { installConsumer, isolatedEnvironment, resolveArtifactDirectory, verifyTarballs } from "./artifact-installation.mjs";

test("artifact directories stay within trusted roots and reject symlink components", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-artifact-paths-"));
	try {
		assert.equal(resolveArtifactDirectory(join(root, "new", "consumer")), join(root, "new", "consumer"));
		assert.throws(() => resolveArtifactDirectory("/etc/diffex-artifacts"), /workspace, home, or temporary/);
		assert.throws(() => resolveArtifactDirectory(""), /Invalid artifact/);
		assert.throws(() => resolveArtifactDirectory("bad\0path"), /Invalid artifact/);
		const target = join(root, "target");
		mkdirSync(target);
		symlinkSync(target, join(root, "linked"));
		assert.throws(() => resolveArtifactDirectory(join(root, "linked", "consumer")), /symlinks/);
		symlinkSync(join(root, "missing"), join(root, "dangling"));
		assert.throws(() => resolveArtifactDirectory(join(root, "dangling", "consumer")), /symlinks/);
		writeFileSync(join(root, "file"), "not a directory");
		assert.throws(() => resolveArtifactDirectory(join(root, "file", "consumer")), /non-directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isolated installation environment copies literal non-secret allowlisted fields only", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-artifact-env-"));
	const original = { ...process.env };
	try {
		process.env.OPENAI_API_KEY = "synthetic-private-openai-value";
		process.env.DAYTONA_API_KEY = "synthetic-private-daytona-value";
		process.env.NODE_OPTIONS = "synthetic-private-node-options";
		const environment = isolatedEnvironment(root);
		assert.equal(environment.PATH, original.PATH);
		assert.equal(environment.OPENAI_API_KEY, undefined);
		assert.equal(environment.DAYTONA_API_KEY, undefined);
		assert.equal(environment.NODE_OPTIONS, undefined);
		assert.equal(environment.HOME, join(root, "home"));
	} finally {
		process.env = original;
		rmSync(root, { recursive: true, force: true });
	}
});

test("package manager selection is a fixed allowlist and invalid package paths fail before execution", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-artifact-install-"));
	try {
		assert.throws(() => installConsumer(join(root, "consumer"), "node --eval malicious", [], [], root), /Unsupported package manager/);
		assert.throws(() => installConsumer(join(root, "consumer"), "npm", [{ name: "../../outside" }], [], root), /Invalid package name/);
		const pkg = { name: "@diffexai/example", version: "1.0.0" };
		assert.throws(() => verifyTarballs(root, [{ ...pkg, filename: "../outside.tgz" }], [pkg]), /Invalid tarball filename/);
		assert.equal(resolveArtifactDirectory(resolve(root, "consumer")), join(root, "consumer"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
