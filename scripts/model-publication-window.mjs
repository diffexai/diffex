import { pathToFileURL } from "node:url";

export function publicationAllowed(event, manual, date = new Date()) {
	if (event === "workflow_dispatch") return manual;
	if (event !== "schedule" && event !== "workflow_run") return false;
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/Vienna", weekday: "short", hour: "2-digit", hourCycle: "h23",
	}).formatToParts(date).map(({ type, value }) => [type, value]));
	const hour = Number(parts.hour);
	return !["Sat", "Sun"].includes(parts.weekday) && hour >= 10 && hour < 15 &&
		(event !== "schedule" || (hour - 10) % 2 === 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const allowed = publicationAllowed(process.env.EVENT_NAME, process.env.MANUAL_PUBLISH === "true");
	console.log(`allowed=${allowed}`);
}
