import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findNpmRecoveryDirectory } from "./npm-recovery.mjs";

test("npm recovery identifies only the affected CLI installation or backup across rename and cleanup errors", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex recovery "));
	try {
		const scope = join(root, "@diffexai");
		const backup = join(scope, ".diffex-Abcd1234");
		mkdirSync(backup, { recursive: true });
		const installed = join(scope, "diffex");
		mkdirSync(installed);
		for (const output of [
			`npm error code ENOTEMPTY\nnpm error dest ${backup}\n`,
			`npm error ENOTEMPTY: directory not empty, rename '${installed}' -> '${backup}'`,
			`npm error ENOTEMPTY: directory not empty, rmdir '${backup}/dist'`,
		])
			assert.equal(findNpmRecoveryDirectory(scope, output), backup);
		assert.equal(
			findNpmRecoveryDirectory(
				scope,
				`npm error ENOTEMPTY: directory not empty, rmdir '${installed}/node_modules/@mistralai/mistralai/esm/models/components'`,
			),
			installed,
		);
		assert.throws(() => findNpmRecoveryDirectory(scope, "ENOTEMPTY at an unrelated path"));
		assert.throws(() => findNpmRecoveryDirectory(scope, `ENOENT ${backup}`));
		const outside = join(root, ".diffex-Outside");
		mkdirSync(outside);
		symlinkSync(outside, join(scope, ".diffex-Link"));
		assert.throws(() => findNpmRecoveryDirectory(scope, `ENOTEMPTY ${outside}`));
		assert.throws(() => findNpmRecoveryDirectory(scope, `ENOTEMPTY ${join(scope, ".diffex-Link")}`));
		const other = join(scope, ".diffex-Other");
		mkdirSync(other);
		assert.throws(() => findNpmRecoveryDirectory(scope, `ENOTEMPTY ${backup} ${other}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
