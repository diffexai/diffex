import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { assertPackageVersion, targetVersion } from "./release-source.mjs";

const release = fileURLToPath(new URL("./release.mjs", import.meta.url));
const source = fileURLToPath(new URL("./release-source.mjs", import.meta.url));
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "diffex-source-test-"));
	const cwd = join(root, "checkout");
	const remote = join(root, "origin.git");
	mkdirSync(cwd);
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	};
	const git = (...args) =>
		execFileSync(realGit, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--bare", "--initial-branch=main", remote);
	git("init", "--initial-branch=main");
	git("remote", "add", "origin", remote);
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, version: "9.9.9" }));
	mkdirSync(join(cwd, "packages/ai"), { recursive: true });
	writeFileSync(
		join(cwd, "packages/ai/package.json"),
		JSON.stringify({ name: "@diffexai/diffex-ai", version: "0.0.3" }),
	);
	writeFileSync(join(cwd, "packages/ai/CHANGELOG.md"), "# Changelog\n\n## [0.0.3]\n\n- Fixture\n");
	mkdirSync(join(cwd, "packages/coding-agent"), { recursive: true });
	writeFileSync(
		join(cwd, "packages/coding-agent/package.json"),
		JSON.stringify({ name: "@diffexai/diffex", version: "0.0.3" }),
	);
	git(
		"add",
		"package.json",
		"packages/ai/package.json",
		"packages/ai/CHANGELOG.md",
		"packages/coding-agent/package.json",
	);
	git("commit", "-m", "fixture");
	git("push", "-u", "origin", "main");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const log = join(root, "commands.jsonl");
	const marker = join(root, "lose-ack");
	writeFileSync(
		join(bin, "git"),
		`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {appendFileSync,existsSync,unlinkSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='remote' && args[1]==='get-url') { console.log(process.env.DIFFEX_FIXTURE_ORIGIN || 'https://github.com/diffexai/diffex.git'); }
else { const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}); if(args[0]==='push' && existsSync(${JSON.stringify(marker)})) {unlinkSync(${JSON.stringify(marker)});process.exit(1);} process.exit(result.status??1); }
`,
		{ mode: 0o755 },
	);
	// Executables have no extension, so set module mode in their own parent.
	writeFileSync(join(bin, "package.json"), '{"type":"module"}');
	writeFileSync(join(bin, "npm"), "#!/bin/sh\necho NPM_PREFLIGHT_REACHED >&2\nexit 1\n", { mode: 0o755 });
	return {
		cwd,
		root,
		remote,
		git,
		marker,
		run: (args = ["patch"], overrides = {}) =>
			spawnSync(process.execPath, [release, ...args], {
				cwd,
				env: { ...env, PATH: `${bin}:${env.PATH}`, ...overrides },
				encoding: "utf8",
				timeout: 15000,
			}),
		resolve: (tag, ref, expected) =>
			spawnSync(process.execPath, [source], {
				cwd,
				env: {
					...env,
					PATH: `${bin}:${env.PATH}`,
					RELEASE_TAG: tag,
					SOURCE_REF: ref ?? "",
					EXPECTED_COMMIT: expected ?? "",
					GITHUB_OUTPUT: join(root, "output"),
				},
				encoding: "utf8",
				timeout: 15000,
			}),
		calls: () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

for (const [name, setup, message] of [
	["dirty tree", (f) => writeFileSync(join(f.cwd, "unreviewed"), "dirty"), /clean working tree/],
	["wrong branch", (f) => f.git("switch", "-c", "feature"), /requires main/],
	["unpublished local commit", (f) => f.git("commit", "--allow-empty", "-m", "local"), /HEAD must equal refreshed/],
	[
		"stale remote state",
		(f) => {
			const next = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "remote change");
			f.git("push", f.remote, `${next}:refs/heads/main`);
		},
		/HEAD must equal refreshed/,
	],
	["existing local tag", (f) => f.git("tag", "v0.0.4"), /tag v0.0.4 already exists/],
	[
		"existing remote tag",
		(f) => f.git("--git-dir", f.remote, "update-ref", "refs/tags/v0.0.4", f.git("rev-parse", "HEAD")),
		/tag v0.0.4 already exists/,
	],
	[
		"mismatched package versions",
		(f) => {
			writeFileSync(
				join(f.cwd, "packages/ai/package.json"),
				JSON.stringify({ name: "@diffexai/diffex-ai", version: "0.0.2" }),
			);
			f.git("add", "packages/ai/package.json");
			f.git("commit", "-m", "mismatch");
			f.git("push", "origin", "main");
		},
		/Package versions do not match/,
	],
]) {
	test(`release command rejects ${name} before npm or remote writes`, () => {
		const f = fixture();
		try {
			setup(f);
			const result = f.run();
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, message);
			assert.doesNotMatch(result.stderr, /NPM_PREFLIGHT_REACHED/);
			assert(!f.calls().some((args) => args[0] === "push"));
		} finally {
			f.cleanup();
		}
	});
}
test("release command rejects foreign and multiple origin URLs", () => {
	for (const origin of [
		"https://github.com/other/diffex.git",
		"https://github.com/diffexai/diffex.git\nhttps://github.com/other/diffex.git",
	]) {
		const f = fixture();
		try {
			const result = f.run(["patch"], { DIFFEX_FIXTURE_ORIGIN: origin });
			assert.match(result.stderr, /canonical diffexai/);
			assert(!f.calls().some((args) => ["fetch", "push"].includes(args[0])));
		} finally {
			f.cleanup();
		}
	}
});
test("synchronized main reaches the npm preflight without mutating source", () => {
	const f = fixture();
	try {
		const before = f.git("rev-parse", "HEAD");
		const result = f.run();
		assert.match(result.stderr, /NPM_PREFLIGHT_REACHED/);
		assert.equal(f.git("status", "--porcelain"), "");
		assert.equal(f.git("rev-parse", "HEAD"), before);
	} finally {
		f.cleanup();
	}
});
test("only patch and minor commands are supported", () => {
	assert.equal(targetVersion("0.3.9", "patch"), "0.3.10");
	assert.equal(targetVersion("0.3.9", "minor"), "0.4.0");
	for (const version of ["0.3.9\n", "01.3.9", "0.3.9-beta.1"]) assert.throws(() => targetVersion(version, "patch"));
	for (const target of ["major", "1.0.0", "01.2.3", "1.2.3-beta.1"])
		assert.throws(() => targetVersion("0.3.9", target));
	const f = fixture();
	try {
		for (const target of ["major", "1.0.0"]) assert.match(f.run([target]).stderr, /unsupported/);
	} finally {
		f.cleanup();
	}
});
test("CI resolves the tag once and rejects divergent recovery or event commits", () => {
	const f = fixture();
	try {
		const commit = f.git("rev-parse", "HEAD");
		f.git("--git-dir", f.remote, "update-ref", "refs/tags/v0.0.3", commit);
		const divergent = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "other source");
		f.git("push", f.remote, `${divergent}:refs/heads/recovery`);
		let result = f.resolve("v0.0.3", "refs/heads/recovery");
		assert.match(result.stderr, /Divergent recovery source/);
		result = f.resolve("v0.0.3", undefined, "b".repeat(40));
		assert.match(result.stderr, /original event commit/);
		result = f.resolve("v0.0.3", "refs/heads/main", commit);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(join(f.root, "output"), "utf8"), `commit=${commit}\n`);
		f.git("--git-dir", f.remote, "update-ref", "refs/tags/v0.0.4", commit);
		assert.match(f.resolve("v0.0.4").stderr, /Package\/tag version mismatch/);
		assert(!f.calls().some((args) => args[0] === "push"));
	} finally {
		f.cleanup();
	}
});
for (const failure of ["rejected transaction", "lost acknowledgement"])
	test(`atomic push recovers from ${failure} without recreating commits or tags`, () => {
		const f = fixture();
		try {
			const before = f.git("rev-parse", "HEAD");
			f.git("tag", "v0.0.3");
			writeFileSync(
				join(f.cwd, "packages/ai/CHANGELOG.md"),
				"# Changelog\n\n## [Unreleased]\n\n## [0.0.3]\n\n- Fixture\n",
			);
			f.git("add", "packages/ai/CHANGELOG.md");
			f.git("commit", "-m", "docs(coding-agent): start next release cycle");
			const final = f.git("rev-parse", "HEAD");
			const hook = join(f.remote, "hooks/pre-receive");
			if (failure === "rejected transaction") writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			else writeFileSync(f.marker, "lose response");
			let result = f.run(["--push-prepared", "v0.0.3"]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Atomic push did not confirm/);
			if (failure === "rejected transaction") {
				assert.equal(f.git("--git-dir", f.remote, "rev-parse", "main"), before);
				assert.equal(f.git("--git-dir", f.remote, "tag", "--list"), "");
				rmSync(hook);
			}
			result = f.run(["--push-prepared", "v0.0.3"]);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(f.git("--git-dir", f.remote, "rev-parse", "main"), final);
			assert.equal(f.git("--git-dir", f.remote, "rev-parse", "v0.0.3"), before);
			result = f.run(["--push-prepared", "v0.0.3"]);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(f.git("rev-parse", "HEAD"), final);
		} finally {
			f.cleanup();
		}
	});

test("the actual release inventory is independent of the private monorepo version", () => {
	const packages = getPublicWorkspacePackages();
	assert.doesNotThrow(() => assertPackageVersion(packages[0].version));
});
