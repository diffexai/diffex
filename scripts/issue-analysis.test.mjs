import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(new URL("../.github/workflows/issue-analysis.yml", import.meta.url), "utf8");
const workflow = parse(source);

test("issue analysis cannot run tools or expose credentials", () => {
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.deepEqual(workflow.permissions, {});
	assert.deepEqual(Object.keys(workflow.jobs), ["disabled"]);
	assert.equal(workflow.jobs.disabled.if, "${{ false }}");
	assert.doesNotMatch(source, /secrets\.|github\.token|--approve|gists\.create|upload-artifact/);
});
