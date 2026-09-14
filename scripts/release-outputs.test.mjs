import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseOutputPaths, stageReleaseOutputs } from "./release-outputs.mjs";

test("real npm workspace version changes stage existing nested locks and reject unrelated files", () => {
	const previous = process.cwd();
	const root = mkdtempSync(join(tmpdir(), "diffex-release-outputs-"));
	const workspace = "packages/cli/examples/example";
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	try {
		mkdirSync(join(root, workspace), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: [workspace] }));
		writeFileSync(
			join(root, workspace, "package.json"),
			JSON.stringify({ name: "release-example", version: "0.2.1", private: true }),
		);
		writeFileSync(
			join(root, workspace, "package-lock.json"),
			JSON.stringify({
				name: "release-example",
				version: "0.2.1",
				lockfileVersion: 3,
				packages: { "": { name: "release-example", version: "0.2.1" } },
			}),
		);
		git("init", "--quiet");
		git("add", "package.json", `${workspace}/package.json`, `${workspace}/package-lock.json`);
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		);
		process.chdir(root);
		const allowed = releaseOutputPaths([]);
		execFileSync(
			"npm",
			[
				"version",
				"patch",
				"--workspaces",
				"--no-git-tag-version",
				"--no-workspaces-update",
				"--ignore-scripts",
				"--offline",
			],
			{ cwd: root, stdio: "pipe" },
		);
		assert(git("diff", "--name-only").includes(`${workspace}/package-lock.json`));
		writeFileSync(join(root, workspace, "unexpected.txt"), "unreviewed");
		assert.throws(() => stageReleaseOutputs(allowed), /Unexpected generated changes/);
		assert.equal(git("diff", "--cached", "--name-only"), "");
		rmSync(join(root, workspace, "unexpected.txt"));
		writeFileSync(join(root, "packages/cli/package.json"), '{"private":true}');
		writeFileSync(join(root, "packages/cli/package-lock.json"), "{}");
		assert.throws(() => stageReleaseOutputs(allowed), /Unexpected generated changes/);
		rmSync(join(root, "packages/cli/package.json"));
		rmSync(join(root, "packages/cli/package-lock.json"));
		stageReleaseOutputs(allowed);
		assert.deepEqual(git("diff", "--cached", "--name-only").split("\n"), [
			`${workspace}/package-lock.json`,
			`${workspace}/package.json`,
		]);
	} finally {
		process.chdir(previous);
		rmSync(root, { recursive: true, force: true });
	}
});
