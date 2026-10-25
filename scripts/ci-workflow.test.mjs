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
