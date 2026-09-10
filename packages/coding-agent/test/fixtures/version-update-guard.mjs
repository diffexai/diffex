// Loaded only by the controlled CLI reproduction, before application imports.
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import "../../src/core/http-dispatcher.ts";

const recordPath = process.env.DIFFEX_REPRO_RECORD;
if (!recordPath) throw new Error("The reproduction requires an isolated event record");
const record = (event) => appendFileSync(recordPath, `${JSON.stringify(event)}\n`);

globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	const headers = new Headers(init?.headers);
	record({ type: "request", url, method: init?.method ?? "GET", userAgent: headers.get("user-agent") });
	if (url !== "https://pi.dev/api/latest-version") return new Response(null, { status: 503 });
	if (process.env.DIFFEX_REPRO_FAILURE === "1") throw new Error("controlled network failure");
	return Response.json({
		version: process.env.DIFFEX_REPRO_VERSION,
		packageName: "@foreign-fixture/untrusted-cli",
	});
};

// Prevent alternate HTTP clients from reaching the network too.
Socket.prototype.connect = function () {
	record({ type: "blocked-network" });
	throw new Error("Network disabled by the version-update reproduction");
};

const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
	// tsx needs its local compiler service; no application subprocess is allowed.
	if (basename(command) === "esbuild" && args?.some((arg) => arg.startsWith("--service="))) {
		return originalSpawn(command, args, options);
	}
	record({ type: "spawn", command, args });
	if (command !== "npm" || args?.[0] !== "--prefix" || !["uninstall", "install"].includes(args?.[2])) {
		throw new Error("Unexpected subprocess blocked by the version-update reproduction");
	}
	// Simulate completion so both uninstall and install attempts can be observed.
	const child = new EventEmitter();
	queueMicrotask(() => child.emit("close", 0, null));
	return child;
};
childProcess.spawnSync = (command, args) => {
	record({ type: "spawnSync", command, args });
	if (command === "npm" && args?.join(" ") === "root -g") {
		return { status: 0, stdout: `${dirname(dirname(process.env.DIFFEX_PACKAGE_DIR))}\n`, stderr: "" };
	}
	return { status: 1, stdout: "", stderr: "Subprocess disabled by the version-update reproduction" };
};
for (const name of ["exec", "execSync", "execFile", "execFileSync", "fork"]) {
	childProcess[name] = () => {
		record({ type: "blocked-process", operation: name });
		throw new Error("Subprocess disabled by the version-update reproduction");
	};
}
syncBuiltinESMExports();

if (process.env.DIFFEX_PACKAGE_DIR) {
	// Model a writable global npm installation without installing a package.
	Object.defineProperty(process, "execPath", {
		value: join(process.env.DIFFEX_PACKAGE_DIR, "node_modules", "node"),
	});
}
