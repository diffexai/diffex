import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/publish-model-catalog.yml", import.meta.url), "utf8"));

test("publication-window CLI emits only its decision and does not write environment-selected paths", (t) => {
	const root = mkdtempSync(join(tmpdir(), "diffex-window-security-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const target = join(root, "unrelated-file");
	writeFileSync(target, "unchanged\n");
	for (const manual of ["true", "false", "true\nallowed=true"]) {
		const result = spawnSync(process.execPath, ["scripts/model-publication-window.mjs"], {
			cwd: new URL("../", import.meta.url),
			encoding: "utf8",
			env: { ...process.env, EVENT_NAME: "workflow_dispatch", MANUAL_PUBLISH: manual, GITHUB_OUTPUT: target },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(target, "utf8"), "unchanged\n");
		assert.equal(result.stdout, `allowed=${manual === "true"}\n`);
	}
});

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

test("binds artifact and publishing code to one SHA and serializes uploads without cancellation", () => {
	assert.equal(workflow.jobs.generate.env.SOURCE_REF, "${{ github.event.workflow_run.head_sha || inputs.source_ref || github.sha }}");
	assert.equal(workflow.jobs.publish.env.SOURCE_REF, "${{ needs.generate.outputs.source_sha }}");
	assert.equal(workflow.jobs.publish.concurrency["cancel-in-progress"], false);
	assert.match(workflow.jobs.publish.environment, /diffex-model-upload-staging/);
	assert.match(workflow.jobs.publish.environment, /diffex-model-upload-production/);
	assert.match(workflow.jobs.publish.env.R2_ENDPOINT, /6b24afa849f8254ab5e6e2d1956239cc/);
	assert.match(workflow.jobs.publish.steps.at(-1).run, /--require-main/);
	assert.equal(workflow.jobs.generate.steps.find((step) => step.name === "Generate model catalog JSON").env.MODEL_CATALOG_SOURCE_SHA,
		"${{ steps.source.outputs.sha }}");
});
