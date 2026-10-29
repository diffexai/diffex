import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./restore-release-artifacts.mjs", import.meta.url));
const commit = "a".repeat(40);
function runFixture(configuration, recovery, extraEnv = {}) {
	const directory = mkdtempSync(join(tmpdir(), "diffex-retained-artifacts-"));
	try {
		const bin = join(directory, "bin");
		mkdirSync(bin);
		const config = join(directory, "fixture.json");
		writeFileSync(config, JSON.stringify(configuration));
		const calls = join(directory, "calls");
		writeFileSync(calls, "");
		const output = join(directory, "output");
		writeFileSync(join(bin, "package.json"), '{"type":"module"}');
		writeFileSync(
			join(bin, "gh"),
			`#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(${JSON.stringify(config)},'utf8'));
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='run' && args[1]==='download'){if(fixture.downloadFailure)process.exit(1);process.exit(0);}
if(args[0]!=='api')throw new Error('Unmocked GitHub command');
const match=/^repos\\/diffexai\\/diffex\\/actions\\/runs\\/(\\d+)(.*)$/.exec(args[1]);if(!match)throw new Error('Unmocked GitHub API');
const run=fixture[match[1]];if(!run)throw new Error('Unknown run');
if(match[2]==='')console.log(JSON.stringify({path:run.path??'.github/workflows/build-binaries.yml',event:run.event??'push'}));
else if(match[2].startsWith('/artifacts?'))console.log(JSON.stringify({artifacts:run.artifacts??[]}));
else if(match[2].startsWith('/jobs?'))console.log(JSON.stringify({total_count:run.total_count??(run.jobs??[]).length,jobs:run.jobs??[]}));
else throw new Error('Unmocked endpoint');
`,
			{ mode: 0o755 },
		);
		const result = spawnSync(process.execPath, [script], {
			cwd: directory,
			env: {
				PATH: `${bin}:${process.env.PATH}`,
				GITHUB_RUN_ID: "100",
				RECOVERY_RUN_ID: recovery ?? "",
				DIFFEX_SOURCE_COMMIT: commit,
				GITHUB_OUTPUT: output,
				...extraEnv,
			},
			encoding: "utf8",
			timeout: 10000,
		});
		return {
			...result,
			output: result.status === 0 ? readFileSync(output, "utf8") : "",
			calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
const artifact = { name: `private-release-${commit}`, expired: false };
test("first build and pre-publication failure can prepare new artifacts", () => {
	for (const jobs of [[], [{ name: "publish-npm", steps: [] }]]) {
		const result = runFixture({ 100: { jobs } });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.output, "restored=false\nupload=true\n");
	}
});
test("a rerun restores immutable bytes and never overwrites its artifact", () => {
	const result = runFixture({ 100: { artifacts: [artifact] } });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.output, "restored=true\nupload=false\n");
	assert(result.calls.some((args) => args[0] === "run" && args[2] === "100"));
});
test("recovery copies the original artifact once and its retry reuses the copy", () => {
	const first = runFixture({ 100: {}, 90: { artifacts: [artifact] } }, "90");
	assert.equal(first.status, 0, first.stderr);
	assert.equal(first.output, "restored=true\nupload=true\n");
	assert(first.calls.some((args) => args[0] === "run" && args[2] === "90"));
	const retry = runFixture({ 100: { artifacts: [artifact] } }, "90");
	assert.equal(retry.status, 0, retry.stderr);
	assert.equal(retry.output, "restored=true\nupload=false\n");
});
test("Homebrew recovery restores exact platform and signed bundle artifacts, never npm inputs", () => {
	for (const [extraEnv, name, directory] of [
		[{ HOMEBREW_PLATFORM: "darwin-arm64" }, `homebrew-darwin-arm64-${commit}`, ".artifacts/homebrew/darwin-arm64"],
		[{ HOMEBREW_RELEASE: "true" }, `homebrew-release-${commit}`, ".artifacts/homebrew-release"],
	]) {
		const result = runFixture({ 100: { artifacts: [{ name, expired: false }] } }, undefined, extraEnv);
		assert.equal(result.status, 0, result.stderr);
		assert(result.calls.some((args) => args[0] === "run" && args.includes(name) && args.includes(directory)));
	}
	assert.equal(runFixture({ 100: {} }, undefined, { HOMEBREW_PLATFORM: "../../auth" }).status, 1);
});

for (const [name, configuration, recovery] of [
	[
		"missing evidence after Homebrew publication started",
		{ 100: { jobs: [{ name: "publish-homebrew", steps: [{ status: "completed" }] }] } },
		undefined,
	],
	[
		"missing evidence after npm started",
		{ 100: { jobs: [{ name: "publish-npm", steps: [{ status: "completed" }] }] } },
		undefined,
	],
	["missing recovery evidence", { 100: {}, 90: {} }, "90"],
	["expired evidence", { 100: { artifacts: [{ ...artifact, expired: true }] } }, undefined],
	["ambiguous evidence", { 100: { artifacts: [artifact, artifact] } }, undefined],
	["foreign workflow", { 100: {}, 90: { path: ".github/workflows/ci.yml", artifacts: [artifact] } }, "90"],
	["untrusted pull request artifacts", { 100: { event: "pull_request", artifacts: [artifact] } }, undefined],
	["failed artifact download", { 100: { artifacts: [artifact] }, downloadFailure: true }, undefined],
	["incomplete publication history", { 100: { total_count: 101 } }, undefined],
])
	test(`${name} blocks recovery instead of rebuilding`, () => {
		const result = runFixture(configuration, recovery);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.output, "");
	});
