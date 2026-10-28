import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test("standard CI runs for pull requests targeting main or a stacked branch", () => {
	assert.ok(Object.hasOwn(workflow.on, "pull_request"));
	for (const filter of ["branches", "branches-ignore", "paths", "paths-ignore"]) {
		assert.equal(workflow.on.pull_request?.[filter], undefined, `${filter} must not exclude stacked PRs`);
	}
	assert.deepEqual(workflow.on.push.branches, ["main"]);
});

test("script-test jobs provision exact pnpm before exercising real package-manager fixtures", () => {
	const release = parse(readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8"));
	for (const job of [workflow.jobs["workspace-tests"], release.jobs["prepare-artifacts"]]) {
		const setup = job.steps.findIndex((step) => step.run === "npm install --global --ignore-scripts pnpm@10.28.2");
		const tests = job.steps.findIndex((step) => step.run?.includes("./test.sh"));
		assert(setup !== -1 && tests > setup, "Pinned pnpm must be available before the real fixture tests");
	}
	assert.equal(release.jobs["prepare-artifacts"].steps.find((step) => step.run === "npm install --global --ignore-scripts pnpm@10.28.2").if,
		"steps.restore.outputs.restored != 'true'");
	const local = readFileSync(new URL("./local-release.mjs", import.meta.url), "utf8");
	assert(local.includes('options.skipBunInstall ? ["npm", "pnpm"] : ["npm", "pnpm", "bun"]'));
});

test("the CI aggregate requires build checks and every isolated test shard", () => {
	const jobs = workflow.jobs;
	assert.deepEqual(jobs["build-check-test"].needs, ["build-check", "workspace-tests", "coding-agent"]);
	assert.equal(jobs["build-check-test"].if, "always()");
	assert.ok(jobs["build-check"].steps.some((step) => step.run === "npm run check"));
	assert.deepEqual(jobs["workspace-tests"].strategy.matrix.shard, [1, 2]);
	assert.deepEqual(jobs["coding-agent"].strategy.matrix.shard, [1, 2, 3, 4]);
	for (const job of ["workspace-tests", "coding-agent"]) {
		assert.ok(jobs[job].steps.some((step) => step.run?.startsWith("./test.sh ")));
	}
});
