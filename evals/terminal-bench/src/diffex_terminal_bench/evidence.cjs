// Transfer shutdown evidence without traversing logs, sessions, or agent state.
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const directory = process.argv[2];
const evidence = {};
for (const name of ["cleanup.json", "stop-requested", "launcher.json", "cli.json", "process.json"]) {
	try {
		evidence[name] = readFileSync(join(directory, name), "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
// A lost cleanup RPC response can arrive before the remote process has
// published its report. Absence is retryable; a negative report is not.
if (!("cleanup.json" in evidence) || !("stop-requested" in evidence)) {
	process.stdout.write("null");
} else {
	let ownership = [];
	try { ownership = readdirSync(join(directory, "ownership")); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	for (const name of ownership.filter((name) => name.endsWith(".json")).sort()) {
		evidence[`ownership/${name}`] = readFileSync(join(directory, "ownership", name), "utf8");
	}
	process.stdout.write(JSON.stringify(evidence));
}
