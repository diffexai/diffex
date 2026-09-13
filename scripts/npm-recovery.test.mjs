import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findNpmRecoveryBackup } from "./npm-recovery.mjs";

test("npm recovery identifies the reported package backup across rename and cleanup errors", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex recovery "));
	try {
		const scope = join(root, "@diffexai");
		const backup = join(scope, ".diffex-Abcd1234");
		mkdirSync(backup, { recursive: true });
		for (const output of [
			`npm error code ENOTEMPTY\nnpm error dest ${backup}\n`,
			`npm error ENOTEMPTY: directory not empty, rename 'diffex' -> '${backup}'`,
			`npm error ENOTEMPTY: directory not empty, rmdir '${backup}/dist'`,
		])
			assert.equal(findNpmRecoveryBackup(scope, output), backup);
		assert.throws(() => findNpmRecoveryBackup(scope, "ENOTEMPTY at an unrelated path"));
		assert.throws(() => findNpmRecoveryBackup(scope, `ENOENT ${backup}`));
		const outside = join(root, ".diffex-Outside");
		mkdirSync(outside);
		symlinkSync(outside, join(scope, ".diffex-Link"));
		assert.throws(() => findNpmRecoveryBackup(scope, `ENOTEMPTY ${outside}`));
		assert.throws(() => findNpmRecoveryBackup(scope, `ENOTEMPTY ${join(scope, ".diffex-Link")}`));
		const other = join(scope, ".diffex-Other");
		mkdirSync(other);
		assert.throws(() => findNpmRecoveryBackup(scope, `ENOTEMPTY ${backup} ${other}`));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
