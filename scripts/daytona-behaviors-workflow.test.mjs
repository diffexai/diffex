import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/daytona-behaviors.yml", import.meta.url), "utf8"));
const gate = "github.event_name == 'workflow_dispatch' || vars.DAYTONA_BEHAVIORS_QUALIFIED == 'true'";

test("Daytona triggers every main push, allows qualification dispatch and never cancels overlapping runs", () => {
	assert.deepEqual(workflow.on.push, { branches: ["main"] });
	assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
	assert.equal(workflow.concurrency, undefined);
	assert.equal(workflow.jobs.prepare.if, "${{ " + gate + " }}");
	assert.match(workflow.jobs["daytona-behaviors"].if, /always\(\)/);
	assert.ok(workflow.jobs["daytona-behaviors"].if.includes(gate));
	assert.equal(workflow.env.DIFFEX_SOURCE_COMMIT, "${{ github.sha }}");
	for (const job of Object.values(workflow.jobs)) {
		assert.equal(job.concurrency, undefined);
		for (const step of job.steps) {
			if (step.uses?.startsWith("actions/checkout@")) {
				assert.equal(step.with.ref, "${{ github.sha }}");
				assert.equal(step.with["persist-credentials"], false);
			}
			if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
			if (step.uses?.startsWith("actions/upload-artifact@")) {
				assert.equal(step.with["retention-days"], 30);
				assert.equal(step.with["if-no-files-found"], "error");
			}
			if (step.run) {
				const parsed = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
				assert.equal(parsed.status, 0, `${step.name}: ${parsed.stderr}`);
			}
		}
	}
});

test("one 35-minute preparation freezes, builds offline, prepares and verifies the reused artifact bytes", () => {
	const prepare = workflow.jobs.prepare;
	assert.equal(prepare["timeout-minutes"], 35);
	const script = prepare.steps.map((step) => step.run ?? "").join("\n");
	const commands = [
		"npm run hydrate:model-data",
		"node scripts/release-artifacts.mjs freeze .artifacts/release",
		"npm run build:offline",
		"node scripts/release-artifacts.mjs prepare .artifacts/release",
		"node scripts/release-artifacts.mjs verify .artifacts/release",
	];
	let previous = -1;
	for (const command of commands) {
		const position = script.indexOf(command);
		assert.ok(position > previous, `Missing or reordered command: ${command}`);
		previous = position;
	}
	assert.ok(script.includes("npm ci --ignore-scripts"));
	assert.ok(script.includes("sha256sum .artifacts/daytona-bundle/bundle.tar.gz"));
	assert.match(script, /-m unittest discover -s scripts\/daytona-behaviors/);
	assert.match(script, /node --test .*daytona-behaviors\/fixture\.test\.mjs/);
	for (const step of prepare.steps) {
		assert.equal(step.env?.DAYTONA_API_KEY, undefined);
		assert.equal(step.env?.OPENAI_API_KEY, undefined);
	}
	for (const mode of ["deterministic", "live"]) {
		const job = workflow.jobs[mode];
		assert.equal(job.needs, "prepare");
		assert.equal(job.environment, "daytona-behaviors");
		const commands = job.steps.map((step) => step.run ?? "").join("\n");
		assert.doesNotMatch(commands, /npm run (build|hydrate)|release-artifacts\.mjs (prepare|freeze)/);
		assert.match(commands, /release-artifacts\.mjs verify/);
		assert.match(commands, /sha256sum -c/);
		assert.ok(job.steps.some((step) => step.with?.name === "daytona-release-${{ github.sha }}-${{ github.run_attempt }}"));
		assert.ok(job.env.DAYTONA_BEHAVIOR_RUN_ID.endsWith(`-${mode}`));
		const run = job.steps.find((step) => step.id === "run");
		const recover = job.steps.find((step) => step.id === "recover");
		assert.ok(run.run.includes(`--mode ${mode}`));
		assert.ok(run.run.includes('--snapshot "$DAYTONA_SNAPSHOT"'));
		assert.ok(recover.if.includes("always()"));
		assert.ok(recover.if.includes("steps.run.outcome != 'skipped'"));
		assert.match(recover.run, /daytona_runner\.py recover/);
		assert.doesNotMatch(recover.run, /--mode|--artifacts/);
		assert.equal(recover.env.OPENAI_API_KEY, undefined);
		assert.equal(run.env.OPENAI_API_KEY !== undefined, mode === "live");
		assert.equal(job.steps.at(-1).if, "always()");
	}
	assert.deepEqual(workflow.jobs["daytona-behaviors"].needs, ["prepare", "deterministic", "live"]);
});

for (const scenario of ["pass", "missing-artifact", "missing-result", "invalid-result", "missing-xml", "failed-job", "cleanup-failed", "wrong-commit", "wrong-run", "orchestration-failed", "cleanup-unconfirmed", "partial-scenarios", "wrong-result-commit", "different-tarballs"]) {
	test(`aggregate fails closed: ${scenario}`, () => {
		const root = mkdtempSync(join(tmpdir(), "daytona workflow "));
		try {
			const commit = "a".repeat(40);
			const fixtures = join(root, "fixtures");
			for (const mode of ["deterministic", "live"]) {
				const directory = join(fixtures, mode);
				mkdirSync(join(directory, "evidence"), { recursive: true });
				writeFileSync(join(directory, "workflow-job.json"), JSON.stringify({
					commit, mode, runId: `123-2-${mode}`, execution: "success", recovery: "success",
				}));
				writeFileSync(join(directory, "orchestration.json"), JSON.stringify({
					commit, mode, run_id: `123-2-${mode}`, outcome: "passed", execution: "passed",
					exit_code: 0, installed_outcome: "passed", reports_complete: true, cleanup: "confirmed",
				}));
				const identities = mode === "live"
					? ["artifact-integrity", "npm-package-integrity", "npm-live-openai"]
					: ["artifact-integrity", "npm-package-integrity", "bun-package-integrity", ...["npm", "bun"].flatMap((manager) =>
						["installation", "print", "builtin-auth-transport", "terminal-tools-cancel-resume", "artifact-terminal"].map((name) => `${manager}-${name}`))];
				writeFileSync(join(directory, "evidence/results.json"), JSON.stringify({
					schemaVersion: 1, commit, mode, outcome: "passed", artifactHashes: { "diffex.tgz": "c".repeat(64) },
					scenarios: identities.map((id) => ({ id, commit, outcome: "passed" })),
				}));
				for (const file of ["orchestration.xml", "evidence/results.xml"]) writeFileSync(join(directory, file), "<testsuites/>");
			}
			const live = join(fixtures, "live");
			if (scenario === "missing-artifact") rmSync(live, { recursive: true });
			if (scenario === "missing-result") rmSync(join(live, "evidence/results.json"));
			if (scenario === "invalid-result") writeFileSync(join(live, "evidence/results.json"), "[]");
			if (scenario === "missing-xml") rmSync(join(live, "orchestration.xml"));
			if (["orchestration-failed", "cleanup-unconfirmed"].includes(scenario)) {
				const report = JSON.parse(readFileSync(join(live, "orchestration.json"), "utf8"));
				if (scenario === "orchestration-failed") report.outcome = "failed";
				if (scenario === "cleanup-unconfirmed") report.cleanup = "unconfirmed";
				writeFileSync(join(live, "orchestration.json"), JSON.stringify(report));
			}
			if (["partial-scenarios", "wrong-result-commit", "different-tarballs"].includes(scenario)) {
				const report = JSON.parse(readFileSync(join(live, "evidence/results.json"), "utf8"));
				if (scenario === "partial-scenarios") report.scenarios.pop();
				if (scenario === "wrong-result-commit") report.commit = "b".repeat(40);
				if (scenario === "different-tarballs") report.artifactHashes["diffex.tgz"] = "d".repeat(64);
				writeFileSync(join(live, "evidence/results.json"), JSON.stringify(report));
			}
			if (["cleanup-failed", "wrong-commit", "wrong-run"].includes(scenario)) {
				const marker = JSON.parse(readFileSync(join(live, "workflow-job.json"), "utf8"));
				if (scenario === "cleanup-failed") marker.recovery = "failure";
				if (scenario === "wrong-commit") marker.commit = "b".repeat(40);
				if (scenario === "wrong-run") marker.runId = "123-1-live";
				writeFileSync(join(live, "workflow-job.json"), JSON.stringify(marker));
			}
			mkdirSync(join(root, "bin"));
			writeFileSync(join(root, "bin/gh"), `#!/usr/bin/env node
const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const name = args[args.indexOf("--name") + 1];
const mode = name.includes("-deterministic-") ? "deterministic" : "live";
const source = join(process.env.DAYTONA_FIXTURES, mode);
if (!existsSync(source)) process.exit(1);
cpSync(source, args[args.indexOf("--dir") + 1], { recursive: true });
`, { mode: 0o755 });
			const aggregate = workflow.jobs["daytona-behaviors"].steps[0].run;
			const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", aggregate], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${join(root, "bin")}:${process.env.PATH}`,
					DAYTONA_FIXTURES: fixtures,
					DIFFEX_SOURCE_COMMIT: commit,
					GITHUB_RUN_ID: "123",
					GITHUB_RUN_ATTEMPT: "2",
					GITHUB_REPOSITORY: "diffexai/diffex",
					GITHUB_STEP_SUMMARY: join(root, "summary.md"),
					PREPARE_RESULT: "success",
					DETERMINISTIC_RESULT: "success",
					LIVE_RESULT: scenario === "failed-job" ? "failure" : "success",
				},
			});
			assert.equal(result.status, scenario === "pass" ? 0 : 1, `${result.stdout}\n${result.stderr}`);
			const summary = JSON.parse(readFileSync(join(root, ".artifacts/daytona-summary/summary.json"), "utf8"));
			assert.equal(summary.passed, scenario === "pass");
			// Downloaded evidence remains in the aggregate artifact, including failed cases.
			if (scenario !== "missing-artifact") assert.ok(readFileSync(join(root, ".artifacts/daytona-summary/live/workflow-job.json")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
