import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./checkout-approved-release.mjs", import.meta.url));
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "diffex-approved-checkout-"));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
	const git = (...args) => execFileSync("git", args, { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--initial-branch=main");
	git("remote", "add", "origin", "https://github.com/diffexai/diffex.git");
	mkdirSync(join(directory, "packages/cli"), { recursive: true });
	writeFileSync(join(directory, "packages/cli/package.json"), '{"name":"@diffexai/diffex","version":"1.2.3"}');
	git("add", "packages/cli/package.json"); git("commit", "-m", "release");
	const release = git("rev-parse", "HEAD"); git("tag", "v1.2.3");
	writeFileSync(join(directory, "control.txt"), "trusted workflow control");
	git("add", "control.txt"); git("commit", "-m", "newer workflow control");
	const control = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", control);
	return { directory, git, release, control,
		run: (overrides = {}) => spawnSync(process.execPath, [script], { cwd: directory,
			env: { ...env, RELEASE_TAG: "v1.2.3", DIFFEX_SOURCE_COMMIT: release, ...overrides }, encoding: "utf8", timeout: 10_000 }),
		cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("recovery starts from trusted workflow control and checks out only the verified tagged main ancestor", () => {
	const f = fixture();
	try {
		const result = f.run();
		assert.equal(result.status, 0, result.stderr);
		assert.equal(f.git("rev-parse", "HEAD"), f.release);
		assert.equal(f.git("branch", "--show-current"), "");
		assert.equal(f.git("rev-parse", "refs/remotes/origin/main"), f.control);
		assert.equal(JSON.parse(readFileSync(join(f.directory, "packages/cli/package.json"), "utf8")).version, "1.2.3");
	} finally { f.cleanup(); }
});

test("invalid, divergent, unapproved and dirty recovery source cannot replace control code", () => {
	for (const setup of [
		(f) => ({ RELEASE_TAG: "refs/heads/attacker" }),
		(f) => ({ DIFFEX_SOURCE_COMMIT: "--detach" }),
		(f) => ({ DIFFEX_SOURCE_COMMIT: "b".repeat(40) }),
		(f) => { f.git("remote", "set-url", "origin", "https://github.com/other/diffex.git"); return {}; },
		(f) => { writeFileSync(join(f.directory, "unreviewed"), "dirty"); return {}; },
		(f) => {
			const unapproved = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "not on main");
			f.git("update-ref", "refs/tags/v1.2.3", unapproved);
			return { DIFFEX_SOURCE_COMMIT: unapproved };
		},
		(f) => { f.git("tag", "v1.2.4"); return { RELEASE_TAG: "v1.2.4", DIFFEX_SOURCE_COMMIT: f.control }; },
	]) {
		const f = fixture();
		try {
			const result = f.run(setup(f));
			assert.notEqual(result.status, 0);
			assert.equal(f.git("rev-parse", "HEAD"), f.control, "Rejected source changed the checkout");
		} finally { f.cleanup(); }
	}
});
