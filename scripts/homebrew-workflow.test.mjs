import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8"));

test("Homebrew candidates use native maintained targets and retained reviewed npm bytes", () => {
	const job = workflow.jobs["prepare-homebrew"];
	assert.deepEqual(job.strategy.matrix.include, [
		{ runner: "macos-15", platform: "darwin-arm64" },
		{ runner: "macos-15-intel", platform: "darwin-x64" },
		{ runner: "ubuntu-24.04-arm", platform: "linux-arm64" },
		{ runner: "ubuntu-24.04", platform: "linux-x64" },
	]);
	const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
	assert.equal(checkout.with.ref, "${{ github.sha }}", "Dispatch inputs must not select executable workflow control code");
	assert.equal(checkout.with["fetch-depth"], 0, "Local tag/main ancestry must be independently revalidated");
	assert.equal(checkout.with["persist-credentials"], false);
	const approved = job.steps.findIndex((step) => step.run === "node scripts/checkout-approved-release.mjs");
	const restore = job.steps.findIndex((step) => step.run === "node scripts/restore-release-artifacts.mjs");
	assert(approved >= 0 && approved < restore);
	const build = job.steps.findIndex((step) => step.run?.startsWith("node scripts/prepare-homebrew-archive.mjs"));
	const accept = job.steps.findIndex((step) => step.run?.includes("node scripts/homebrew-acceptance.mjs"));
	assert(restore >= 0 && build > restore && accept > build);
	assert.equal(job.steps[build].if, "steps.restore.outputs.restored != 'true'");
	const retained = job.steps.find((step) => step.with?.name?.startsWith("homebrew-${{"));
	assert(retained.with.path.includes("*.tar.gz") && retained.with.path.includes("*.json"));
	assert(!retained.with.path.includes(".artifacts/release"), "No source, debug, npm cache or authentication files in Homebrew uploads");
});

test("complete signed Homebrew bytes are retained before either publication job", () => {
	const job = workflow.jobs["retain-homebrew"];
	assert.equal(job.environment, "homebrew-release");
	const signing = job.steps.findIndex((step) => step.run?.includes("homebrew-release.mjs sign"));
	const verification = job.steps.findIndex((step) => step.run?.includes("homebrew-release.mjs verify"));
	const retained = job.steps.findIndex((step) => step.with?.name?.startsWith("homebrew-release-"));
	assert(signing >= 0 && verification > signing && retained > verification);
	for (const name of ["publish-npm", "publish-homebrew"]) assert(workflow.jobs[name].needs.includes("retain-homebrew"));
	assert.equal(workflow.jobs["publish-npm"].environment, "npm-publish");
	assert.equal(workflow.jobs["publish-npm"].permissions["id-token"], "write");
});

test("announcement and latest advancement require public Homebrew verification", () => {
	const job = workflow.jobs["announce-diffex-release"];
	assert(job.needs.includes("publish-homebrew"));
	const announce = job.steps.findIndex((step) => step.run?.includes("publish-release-announcement.mjs"));
	const promote = job.steps.findIndex((step) => step.run?.includes("homebrew-release.mjs promote"));
	assert(announce >= 0 && promote > announce);
	assert(job.steps[announce].run.includes("--homebrew-artifacts .artifacts/homebrew-release"));
	assert.equal(job.concurrency.group, "announce-diffex-release");
});

test("tap token is short-lived, repository scoped, and issued only after anonymous verification", () => {
	const job = workflow.jobs["update-homebrew-tap"];
	assert(job.needs.includes("announce-diffex-release"));
	assert.equal(job.environment, "homebrew-tap");
	const verification = job.steps.findIndex((step) => step.run?.includes("homebrew-release.mjs verify-public"));
	const token = job.steps.findIndex((step) => step.uses?.startsWith("actions/create-github-app-token@"));
	assert(verification >= 0 && token > verification);
	assert.deepEqual({ owner: job.steps[token].with.owner, repositories: job.steps[token].with.repositories,
		contents: job.steps[token].with["permission-contents"], prs: job.steps[token].with["permission-pull-requests"] },
		{ owner: "diffexai", repositories: "homebrew-tap", contents: "write", prs: "write" });
	assert(!job.steps.some((step) => step.run?.includes("merge")));
});

test("publication remains disabled until an explicit policy review; no direct installer is added", () => {
	const policy = JSON.parse(readFileSync(new URL("../docs/release/distribution-policy.json", import.meta.url), "utf8"));
	assert.equal(policy.channels.homebrew, "defer");
	assert.equal(policy.channels.standalone, "defer");
	assert.equal(policy.homebrewApproval.status, "pending");
	assert.deepEqual(JSON.parse(readFileSync(new URL("../docs/release/homebrew-signers.json", import.meta.url), "utf8")).keys, []);
	assert(workflow.jobs["publish-homebrew"].if.includes("HOMEBREW_DISTRIBUTION_ENABLED"));
	const local = readFileSync(new URL("./local-release.mjs", import.meta.url), "utf8");
	assert(local.includes('arg === "--homebrew"'));
	assert(local.includes("prepareHomebrewArchive"));
	assert(!local.includes("install.sh"));
});
