import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffexClient } from "/opt/diffex/packages/client/dist/index.js";
import { createWebSocketTransportFactory } from "/opt/diffex/packages/client/dist/websocket.js";
import { WebSocket } from "/opt/diffex/node_modules/ws/wrapper.mjs";

const root = mkdtempSync(join(tmpdir(), "diffex-runtime-smoke-"));
for (const name of ["workspace", "agent", "state", "sessions"]) mkdirSync(join(root, name));
const events = join(root, "events");
writeFileSync(events, "");
const secret = "runtime-local-smoke-fixture-32-bytes";
const env = {
	PATH: process.env.PATH,
	HOME: root,
	DIFFEX_OFFLINE: "1",
	HOST: "127.0.0.1",
	PORT: "8787",
	DIFFEX_SESSION_ID: "runtime-smoke-session",
	DIFFEX_WORKSPACE: join(root, "workspace"),
	DIFFEX_AGENT_DIR: join(root, "agent"),
	DIFFEX_CODING_AGENT_DIR: join(root, "agent"),
	DIFFEX_RUNTIME_SHARED_SECRET: secret,
	DIFFEX_RUNTIME_STATE_DIR: join(root, "state"),
	DIFFEX_SESSION_DIR: join(root, "sessions"),
	DIFFEX_OWNER_USER_ID: "runtime-smoke-user",
	DIFFEX_ORG_ID: "runtime-smoke-org",
	DIFFEX_MODEL_PROVIDER: "runtime-fixture",
	DIFFEX_MODEL_ID: "fixture",
	DIFFEX_MODEL_API_KEY: "local-unused-fixture",
	DIFFEX_USAGE_ENDPOINT: "http://127.0.0.1:1/usage",
	DIFFEX_SMOKE_EVENTS: events,
};
const transport = (credential) =>
	createWebSocketTransportFactory({
		url: "ws://127.0.0.1:8787/runtime",
		webSocket: class extends WebSocket {
			constructor(url, protocols) {
				super(url, protocols, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
			}
		},
	});
let child;
let completion;
const watchdog = setTimeout(() => child?.kill("SIGKILL"), 60000);
async function start() {
	child = spawn(
		process.execPath,
		["--import", "/acceptance/runtime-fixture.mjs", "/opt/diffex/packages/coding-agent-server/dist/cli.js"],
		{ cwd: env.DIFFEX_WORKSPACE, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	completion = once(child, "exit");
	let output = "";
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	await new Promise((done, reject) => {
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`Runtime exited before readiness: ${output}`)));
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("Diffex runtime server listening")) done();
		});
	});
}
async function stop() {
	child.kill("SIGTERM");
	const [code, signal] = await completion;
	assert.equal(signal, null);
	assert.equal(code, 0);
}
try {
	await start();
	await assert.rejects(DiffexClient.connect({ transportFactory: transport() }));
	await assert.rejects(DiffexClient.connect({ transportFactory: transport("wrong-fixture") }));
	const client = await DiffexClient.connect({ transportFactory: transport(secret) });
	try {
		assert.deepEqual(
			(await client.listSessions()).map((session) => session.id),
			[env.DIFFEX_SESSION_ID],
		);
		await assert.rejects(client.attachSession("another-session"));
		const session = await client.attachSession(env.DIFFEX_SESSION_ID);
		try {
			const result = await session.prompt("Reply with the fixture confirmation.");
			assert(
				result.transcript.some(
					(item) =>
						item.role === "assistant" &&
						item.content.some((part) => part.type === "text" && part.text.includes("runtime-fixture-ok")),
				),
			);
		} finally {
			await session.dispose();
		}
	} finally {
		await client.dispose();
	}
	await stop();
	await start();
	const restored = await DiffexClient.connect({ transportFactory: transport(secret) });
	try {
		const session = await restored.attachSession(env.DIFFEX_SESSION_ID);
		assert(session.snapshot.transcript.some((item) => item.role === "assistant"));
		await session.dispose();
	} finally {
		await restored.dispose();
	}
	await stop();
	assert(readFileSync(events, "utf8").includes("inference"));
	assert(readFileSync(events, "utf8").includes("usage"));
	console.log(
		JSON.stringify({
			status: "passed",
			platform: process.platform,
			architecture: process.arch,
			node: process.version,
			startup: true,
			anonymousRejected: true,
			wrongCredentialRejected: true,
			foreignSessionRejected: true,
			promptReply: "mock-provider",
			usage: "mock-endpoint",
			restartPersistence: true,
			shutdown: true,
			externalNetwork: "disabled by container",
			sourceCommit: JSON.parse(readFileSync("/opt/diffex/runtime-distribution.json", "utf8")).sourceCommit,
		}),
	);
} finally {
	clearTimeout(watchdog);
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await completion;
	}
	rmSync(root, { recursive: true, force: true });
	assert(!existsSync(root));
}
