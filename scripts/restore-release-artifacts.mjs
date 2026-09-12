import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const repository = "diffexai/diffex";
let run = process.env.GITHUB_RUN_ID;
if (!/^[1-9]\d*$/.test(run ?? "")) throw new Error("Invalid artifact run ID");
const commit = process.env.DIFFEX_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Invalid resolved release commit");
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
const api = (path) => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${path}`], { encoding: "utf8" }));
const name = `private-release-${commit}`;
function findArtifacts(id) {
	const metadata = api(`actions/runs/${id}`);
	if (
		metadata.path !== ".github/workflows/build-binaries.yml" ||
		!["push", "workflow_dispatch"].includes(metadata.event)
	)
		throw new Error("Recovery artifacts must come from the release workflow");
	const inventory = api(`actions/runs/${id}/artifacts?per_page=100`);
	if (inventory.total_count > 100) throw new Error("Incomplete artifact inventory; recovery refused");
	return inventory.artifacts.filter((artifact) => artifact.name === name);
}
let artifacts = findArtifacts(run);
if (!artifacts.length && process.env.RECOVERY_RUN_ID) {
	if (!/^[1-9]\d*$/.test(process.env.RECOVERY_RUN_ID)) throw new Error("Invalid recovery artifact run ID");
	run = process.env.RECOVERY_RUN_ID;
	artifacts = findArtifacts(run);
}
if (artifacts.length > 1 || artifacts.some((artifact) => artifact.expired))
	throw new Error("Ambiguous or expired retained artifacts; never rebuild a published version");
if (artifacts.length === 1) {
	execFileSync("gh", ["run", "download", run, "--repo", repository, "--name", name, "--dir", ".artifacts/release"], {
		stdio: "inherit",
	});
	appendFileSync(process.env.GITHUB_OUTPUT, `restored=true\nupload=${run !== process.env.GITHUB_RUN_ID}\n`);
} else {
	// A retry without retained bytes is safe only if no publication job ever ran.
	const jobs = api(`actions/runs/${run}/jobs?filter=all&per_page=100`);
	if (
		process.env.RECOVERY_RUN_ID ||
		jobs.total_count > 100 ||
		jobs.jobs.some((job) => job.name === "publish-npm" && job.steps?.some((entry) => entry.status !== "queued"))
	)
		throw new Error("Retained artifacts are missing; recovery cannot reconstruct published bytes");
	appendFileSync(process.env.GITHUB_OUTPUT, "restored=false\nupload=true\n");
}
