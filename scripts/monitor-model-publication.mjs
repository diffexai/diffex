import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Allow one hour for runner delays. Weekends do not make unchanged content stale.
export function expectedPublication(now = new Date()) {
	const cutoff = now.getTime() - 60 * 60 * 1000;
	for (let time = Math.floor(cutoff / 60000) * 60000; time > cutoff - 4 * 86400000; time -= 60000) {
		const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
			timeZone: "Europe/Vienna", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
		}).formatToParts(new Date(time)).map(({ type, value }) => [type, value]));
		if (!["Sat", "Sun"].includes(parts.weekday) && ["10", "12", "14"].includes(parts.hour) && parts.minute === "17") return time;
	}
	throw new Error("Could not determine publication deadline");
}

export function checkPublicationRuns(jobs, now = new Date()) {
	const expected = expectedPublication(now);
	const generated = jobs.filter((job) => job.name === "generate" && job.conclusion === "success").map((job) => Date.parse(job.completed_at));
	const published = jobs.flatMap((job) => job.name === "publish" ? (job.steps ?? []).filter((step) => step.name === "Publish model catalog to R2" && step.conclusion === "success").map((step) => Date.parse(step.completed_at)) : []);
	const validation = Math.max(0, ...generated);
	const publication = Math.max(0, ...published);
	if (validation < expected) throw new Error(`Missed successful catalog generation since ${new Date(expected).toISOString()}`);
	if (publication < expected) throw new Error(`Missed successful catalog publication since ${new Date(expected).toISOString()}`);
	return { lastSuccessfulGeneration: new Date(validation).toISOString(), lastSuccessfulPublication: new Date(publication).toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const api = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
	const runs = api("repos/diffexai/diffex/actions/workflows/publish-model-catalog.yml/runs?branch=main&per_page=100").workflow_runs;
	const jobs = runs.filter((run) => run.event !== "pull_request").flatMap((run) => {
		const entries = api(`repos/diffexai/diffex/actions/runs/${run.id}/jobs?per_page=100`).jobs;
		// Production monitoring must not count a manual staging upload as production health.
		return run.display_title === "Model catalog (production)" ? entries : entries.filter((job) => job.name === "generate");
	});
	console.log(JSON.stringify(checkPublicationRuns(jobs)));
}
