import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(
  new URL("../.github/workflows/issue-analysis.yml", import.meta.url),
  "utf8",
);
const script = workflow
  .split("          script: |\n")[1]
  .split("\n  analyze:")[0];

async function authorize(permission, options = {}) {
  const outputs = {};
  const failures = [];
  const requests = [];
  const context = {
    eventName: options.comment ? "issue_comment" : "issues",
    repo: { owner: "diffexai", repo: "diffex" },
    issue: { number: 123 },
    payload: {
      sender: { login: "reviewer" },
      action: "labeled",
      label: { name: "diffex-analyze" },
      issue: {},
      comment: { body: options.body ?? "@issuron analyze" },
    },
  };
  await vm.runInNewContext(`(async () => {${script}\n})()`, {
    context,
    process: { env: {} },
    console: { log() {} },
    core: {
      setOutput: (key, value) => {
        outputs[key] = value;
      },
      setFailed: (message) => failures.push(message),
    },
    fetch: () => {
      throw new Error("Unexpected external authorization");
    },
    github: {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async (input) => {
            requests.push(input);
            if (options.failure) throw new Error("Controlled GitHub failure");
            return { data: { permission } };
          },
        },
        issues: { removeLabel: async () => {}, addLabels: async () => {} },
      },
    },
  });
  return { outputs, failures, requests };
}

for (const permission of ["admin", "write"]) {
  test(`repository ${permission} can authorize without organization credentials`, async () => {
    const result = await authorize(permission);
    assert.equal(result.outputs.should_run, "true", result.failures.join("\n"));
    assert.equal(result.requests[0].owner, "diffexai");
    assert.equal(result.requests[0].repo, "diffex");
  });
}
for (const permission of ["read", "triage", "none", undefined]) {
  test(`rejects ${permission} permission`, async () => {
    const result = await authorize(permission);
    assert.equal(result.outputs.should_run, "false");
    assert.equal(result.failures.length, 1);
  });
}
test("authorization service failures fail closed", async () => {
  const result = await authorize("admin", { failure: true });
  assert.equal(result.outputs.should_run, "false");
  assert.equal(result.failures.length, 1);
});
test("comment runner selection remains constrained", async () => {
  const result = await authorize("write", {
    comment: true,
    body: "@issuron analyze #run-on-mac",
  });
  assert.equal(result.outputs.should_run, "true");
  assert.equal(result.outputs.runner_os, "macos");
  const invalid = await authorize("write", {
    comment: true,
    body: "@issuron analyze #run-on-private",
  });
  assert.equal(invalid.outputs.should_run, "false");
  assert.equal(invalid.requests.length, 0);
});
