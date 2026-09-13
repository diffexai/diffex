// Private acceptance fixture; the runner prepends a static import of the installed HTTP dispatcher.
import { appendFileSync, readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";

const record = (event) => appendFileSync(process.env.DIFFEX_LIFECYCLE_EVENTS, `${JSON.stringify(event)}\n`);
globalThis.fetch = async (input, init) => {
	const url = String(input);
	record({ type: "discovery", url, redirect: init?.redirect });
	if (url !== "https://api.diffex.ai/api/latest-version" || init?.redirect !== "manual")
		throw new Error("Unexpected lifecycle discovery request");
	const fixture = JSON.parse(readFileSync(process.env.DIFFEX_LIFECYCLE_RESPONSE, "utf8"));
	if (fixture.failure) throw new Error("Controlled discovery outage");
	return new Response(fixture.body, {
		status: fixture.status,
		headers: { "content-type": "application/json", ...fixture.headers },
	});
};
Socket.prototype.connect = function () {
	throw new Error("Installed CLI attempted unexpected network access");
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
	record({ type: "process", command, args });
	return spawn(command, args, options);
};
syncBuiltinESMExports();
