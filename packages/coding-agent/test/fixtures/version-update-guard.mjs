// Loaded only by the controlled CLI reproduction, before application imports.
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, fetch as requestStaging } from "undici";
import "../../src/core/http-dispatcher.ts";

const recordPath = process.env.DIFFEX_REPRO_RECORD;
if (!recordPath) throw new Error("The reproduction requires an isolated event record");
const record = (event) => appendFileSync(recordPath, `${JSON.stringify(event)}\n`);

const staging = process.env.DIFFEX_REPRO_STAGING === "1";
const stagingUrl = "https://diffex-public-api-staging.yibai14651.workers.dev/api/latest-version";
const stagingHost = new URL(stagingUrl).hostname;
const dispatcher = staging ? new Agent() : undefined;

async function controlledFetch(input, init) {
	const url = input instanceof Request ? input.url : String(input);
	const headers = new Headers(init?.headers);
	record({
		type: "request",
		url,
		method: init?.method ?? "GET",
		userAgent: headers.get("user-agent"),
		redirect: init?.redirect,
	});
	if (url !== "https://api.diffex.ai/api/latest-version") return new Response(null, { status: 503 });
	if (process.env.DIFFEX_REPRO_RELEASE_RESPONSE) {
		while (!existsSync(process.env.DIFFEX_REPRO_RELEASE_RESPONSE)) {
			await delay(10, undefined, { signal: init?.signal });
		}
	}
	if (staging) {
		if ((init?.method ?? "GET") !== "GET" || init?.redirect !== "manual") {
			throw new Error("Unexpected staging request options");
		}
		const response = await requestStaging(stagingUrl, { ...init, dispatcher, redirect: "manual" });
		const body = await response.text();
		record({
			type: "staging-response",
			url: stagingUrl,
			status: response.status,
			body,
			cacheControl: response.headers.get("cache-control"),
			contentType: response.headers.get("content-type"),
		});
		return new Response(body, { status: response.status, headers: response.headers });
	}
	if (process.env.DIFFEX_REPRO_FAILURE === "1") throw new Error("controlled network failure");
	if (process.env.DIFFEX_REPRO_RESPONSE) {
		return new Response(process.env.DIFFEX_REPRO_RESPONSE, {
			status: Number(process.env.DIFFEX_REPRO_STATUS || "200"),
			headers: {
				"Content-Type": "application/json",
				...(process.env.DIFFEX_REPRO_REDIRECT ? { Location: process.env.DIFFEX_REPRO_REDIRECT } : {}),
			},
		});
	}
	return Response.json({
		version: process.env.DIFFEX_REPRO_VERSION,
		packageName: process.env.DIFFEX_REPRO_PACKAGE,
	});
}

globalThis.fetch = async (input, init) => {
	try {
		const response = await controlledFetch(input, init);
		const json = response.json.bind(response);
		response.json = async () => {
			try {
				return await json();
			} finally {
				// Drain validation and notification promise continuations before the parent sends more input.
				setImmediate(() => record({ type: "discovery-settled" }));
			}
		};
		if (response.status !== 200 && response.status !== 404) {
			setImmediate(() => record({ type: "discovery-settled" }));
		}
		return response;
	} catch (error) {
		setImmediate(() => record({ type: "discovery-settled" }));
		throw error;
	}
};

// Prevent alternate HTTP clients from reaching the network too.
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
	const options = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (staging && options?.host === stagingHost && Number(options.port) === 443) {
		record({ type: "staging-connect", host: stagingHost, port: 443 });
		return originalConnect.apply(this, args);
	}
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
	const cacheArgs = [
		"--prefix",
		join(process.env.DIFFEX_PACKAGE_DIR ?? "", "../../../.."),
		"cache",
		"add",
		"--ignore-scripts",
		"--min-release-age=0",
		`@diffexai/diffex@${process.env.DIFFEX_REPRO_VERSION}`,
	];
	const cacheAdd =
		Boolean(process.env.DIFFEX_PACKAGE_DIR) &&
		process.env.DIFFEX_REPRO_PACKAGE === "@diffexai/diffex" &&
		args?.length === cacheArgs.length &&
		cacheArgs.every((arg, index) => args[index] === arg);
	if (
		command !== "npm" ||
		(!cacheAdd && (args?.[0] !== "--prefix" || !["uninstall", "install"].includes(args?.[2])))
	) {
		throw new Error("Unexpected subprocess blocked by the version-update reproduction");
	}
	// Simulate completion so cache prefetch, uninstall and install attempts can be observed.
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
