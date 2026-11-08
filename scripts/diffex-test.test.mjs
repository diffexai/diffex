import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./diffex-test.sh", import.meta.url));

test("source launcher runs from another directory and forwards arguments", (t) => {
	const root = mkdtempSync(join(tmpdir(), "diffex-launcher-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = spawnSync(launcher, ["--no-env", "--help"], {
		cwd: root,
		env: { ...process.env, DIFFEX_CODING_AGENT_DIR: join(root, "agent"), DIFFEX_OFFLINE: "1" },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Running without API keys\.\.\.\nDiffex - AI coding assistant/m);
	assert.match(result.stdout, /Usage:\n  diffex \[options\]/);
});
