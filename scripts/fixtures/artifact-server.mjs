import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiffexClient } from "@diffexai/diffex-client";
import { createWebSocketTransportFactory } from "@diffexai/diffex-client/websocket";
import { WebSocket } from "ws";

const root = dirname(fileURLToPath(import.meta.url));
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const secret = "local-artifact-acceptance-fixture-32-bytes";
const child = spawn(
	process.execPath,
	["--import", join(root, "guard.mjs"), join(root, "node_modules/@diffexai/diffex-coding-agent-server/dist/cli.js")],
	{
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			HOST: "127.0.0.1",
			PORT: String(port),
			DIFFEX_SESSION_ID: "artifact-session",
			DIFFEX_WORKSPACE: process.cwd(),
			DIFFEX_AGENT_DIR: process.env.DIFFEX_CODING_AGENT_DIR,
			DIFFEX_RUNTIME_SHARED_SECRET: secret,
			DIFFEX_RUNTIME_STATE_DIR: join(root, "runtime-state"),
			DIFFEX_SESSION_DIR: join(root, "sessions"),
			DIFFEX_OWNER_USER_ID: "artifact-user",
			DIFFEX_ORG_ID: "artifact-org",
			DIFFEX_MODEL_PROVIDER: "anthropic",
			DIFFEX_MODEL_ID: "claude-sonnet-4-5",
			DIFFEX_MODEL_API_KEY: "local-unused-fixture",
			DIFFEX_USAGE_ENDPOINT: "http://127.0.0.1:1/usage",
		},
	},
);
const exited = once(child, "exit");
let output = "";
child.stderr.on("data", (chunk) => {
	output += chunk;
});
const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
try {
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`Server exited before readiness: ${output}`)));
		child.stdout.on("data", (chunk) => {
			output += chunk;
			if (output.includes("Diffex runtime server listening")) resolve();
		});
	});
	const transport = (credential) =>
		createWebSocketTransportFactory({
			url: `ws://127.0.0.1:${port}/runtime`,
			webSocket: class extends WebSocket {
				constructor(url, protocols) {
					super(url, protocols, { headers: { authorization: `Bearer ${credential}` } });
				}
			},
		});
	await assert.rejects(DiffexClient.connect({ transportFactory: transport("wrong-fixture") }));
	const client = await DiffexClient.connect({ transportFactory: transport(secret) });
	try {
		assert.deepEqual(
			(await client.listSessions()).map((session) => session.id),
			["artifact-session"],
		);
	} finally {
		await client.dispose();
	}
	child.kill("SIGTERM");
	const [code, signal] = await exited;
	assert.equal(signal, null);
	assert.equal(code, 0);
	console.log("Packed runtime server: ready, rejected wrong credential, listed session, graceful shutdown");
} finally {
	clearTimeout(watchdog);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await exited;
	}
}
