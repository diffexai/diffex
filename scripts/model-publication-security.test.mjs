import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/publish-model-catalog.yml", import.meta.url), "utf8"));

function allowed(job, overrides = {}, inputs = {}) {
	const github = {
		repository: "diffexai/diffex",
		ref: "refs/heads/main",
		event_name: "workflow_run",
		event: { workflow_run: {
			conclusion: "success", event: "push", head_branch: "main",
			head_repository: { full_name: "diffexai/diffex" },
		} },
		...overrides,
	};
	return Boolean(vm.runInNewContext(workflow.jobs[job].if.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), { github, inputs }));
}

for (const job of ["generate", "publish"]) {
	test(`${job} rejects untrusted workflow completions`, () => {
		assert.equal(allowed(job), true);
		for (const change of [
			{ head_repository: { full_name: "attacker/diffex" } },
			{ event: "pull_request" }, { head_branch: "feature" }, { conclusion: "failure" },
		]) {
			assert.equal(allowed(job, { event: { workflow_run: {
				conclusion: "success", event: "push", head_branch: "main",
				head_repository: { full_name: "diffexai/diffex" }, ...change,
			} } }), false, JSON.stringify(change));
		}
	});
}

test("publication accepts only main for scheduled and manual runs", () => {
	assert.equal(allowed("publish", { event_name: "schedule" }), true);
	assert.equal(allowed("publish", { event_name: "pull_request" }), false);
	assert.equal(allowed("publish", { event_name: "workflow_dispatch" }, { publish: true, source_ref: "main" }), true);
	for (const inputs of [{ publish: false, source_ref: "main" }, { publish: true, source_ref: "feature" }]) {
		assert.equal(allowed("publish", { event_name: "workflow_dispatch" }, inputs), false);
	}
	assert.equal(allowed("publish", { event_name: "schedule", ref: "refs/heads/feature" }), false);
});
