import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiffexClient } from "@diffexai/diffex-client";
import { createWebSocketTransportFactory } from "@diffexai/diffex-client/websocket";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";

const sessionId = "2f1c9e00-aaaa-4000-8000-000000000001";
const credential = "runtime-gateway-local-fixture";
const secret = "runtime-protocol-local-fixture-32-bytes";

function completion(): string {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_runtime_fixture",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "gateway-runtime-ok" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
			usage: { output_tokens: 3 },
		},
		{ type: "message_stop" },
	];
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe("hosted gateway runtime process", () => {
	test("uses gateway authentication over native WebSocket, preserves pending calls, and reopens without redispatch", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-runtime-process-")));
		for (const name of ["workspace", "agent", "state", "sessions"]) await mkdir(join(root, name));
		const requests: Array<{ operationId: string; body: Record<string, unknown> }> = [];
		let responseMode = "complete";
		const gateway = createServer(async (request, response) => {
			try {
				if (request.url === "/usage") {
					response.writeHead(200, { "content-type": "application/json" });
					response.end('{"accepted":true}');
					return;
				}
				expect(request.url).toBe(`/v1/runtime/sessions/${sessionId}/model/v1/messages`);
				expect(request.headers["x-api-key"]).toBe(credential);
				expect(request.headers.authorization).toBeUndefined();
				const operationId = String(request.headers["x-diffex-operation-id"]);
				const record = JSON.parse(
					await readFile(join(root, "state", "model-operations", `${operationId}.json`), "utf8"),
				);
				expect(record.operationId).toBe(operationId);
				let body = "";
				for await (const chunk of request) body += chunk;
				requests.push({ operationId, body: JSON.parse(body) });
				if (responseMode === "complete") {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completion());
				} else {
					response.writeHead(503, { "content-type": "application/json" });
					response.end('{"type":"error","error":{"type":"api_error","message":"gateway_unresolved"}}');
				}
			} catch (error) {
				response.writeHead(500);
				response.end(String(error));
			}
		});
		gateway.listen(0, "127.0.0.1");
		await once(gateway, "listening");
		const gatewayAddress = gateway.address();
		if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Missing gateway address");
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const runtimeAddress = reservation.address();
		if (!runtimeAddress || typeof runtimeAddress === "string") throw new Error("Missing runtime address");
		await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
		let child: ChildProcess | undefined;
		let exit: Promise<unknown[]> | undefined;
		const launch = async (): Promise<void> => {
			child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url))], {
				cwd: join(root, "workspace"),
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: root,
					DIFFEX_OFFLINE: "1",
					HOST: "127.0.0.1",
					PORT: String(runtimeAddress.port),
					DIFFEX_SESSION_ID: sessionId,
					DIFFEX_WORKSPACE: join(root, "workspace"),
					DIFFEX_AGENT_DIR: join(root, "agent"),
					DIFFEX_CODING_AGENT_DIR: join(root, "agent"),
					DIFFEX_RUNTIME_STATE_DIR: join(root, "state"),
					DIFFEX_SESSION_DIR: join(root, "sessions"),
					DIFFEX_RUNTIME_SHARED_SECRET: secret,
					DIFFEX_OWNER_USER_ID: "fixture-user",
					DIFFEX_ORG_ID: "fixture-org",
					DIFFEX_MODEL_PROVIDER: "anthropic",
					DIFFEX_MODEL_ID: "claude-sonnet-4-5",
					DIFFEX_MODEL_MAX_OUTPUT_TOKENS: "8192",
					DIFFEX_MODEL_GATEWAY_URL: `http://127.0.0.1:${gatewayAddress.port}/v1/runtime/sessions/${sessionId}/model`,
					DIFFEX_MODEL_GATEWAY_CREDENTIAL: credential,
					DIFFEX_USAGE_ENDPOINT: `http://127.0.0.1:${gatewayAddress.port}/usage`,
				},
			});
			exit = once(child, "exit");
			await new Promise<void>((resolve, reject) => {
				let output = "";
				child?.once("error", reject);
				child?.once("exit", () => reject(new Error(`Runtime exited before readiness: ${output}`)));
				child?.stderr?.on("data", (chunk) => {
					output += chunk;
				});
				child?.stdout?.on("data", (chunk) => {
					output += chunk;
					if (output.includes("Diffex runtime server listening")) resolve();
				});
			});
		};
		const stop = async (): Promise<void> => {
			child?.kill("SIGTERM");
			expect(await exit).toEqual([0, null]);
		};
		const connect = (candidate: string) =>
			DiffexClient.connect({
				transportFactory: createWebSocketTransportFactory({
					url: `ws://127.0.0.1:${runtimeAddress.port}/runtime`,
					webSocket: class extends WebSocket {
						constructor(url: string | URL, protocols?: string | string[]) {
							super(url, protocols, { headers: { authorization: `Bearer ${candidate}` } });
						}
					} as never,
				}),
			});
		try {
			await launch();
			await expect(connect("wrong")).rejects.toThrow();
			const client = await connect(secret);
			try {
				await expect(client.attachSession("another-session")).rejects.toThrow();
				const session = await client.attachSession(sessionId);
				await expect(session.prompt("Reply with fixture text")).resolves.toMatchObject({
					phase: "idle",
					transcript: expect.arrayContaining([
						expect.objectContaining({
							role: "assistant",
							content: [{ type: "text", text: "gateway-runtime-ok" }],
							status: "complete",
							usage: expect.objectContaining({ input: 10, output: 3 }),
						}),
					]),
				});
				expect(requests).toHaveLength(1);
				expect(requests[0]?.body).toMatchObject({ model: "claude-sonnet-4-5", stream: true, max_tokens: 8192 });
				responseMode = "unresolved";
				const failed = await session.prompt("A distinct second call");
				expect(failed.transcript.at(-1)).toMatchObject({
					status: "error",
					errorMessage: expect.stringContaining("gateway_unresolved"),
				});
				expect(requests).toHaveLength(2);
				expect(requests[0]?.operationId).not.toBe(requests[1]?.operationId);
				expect(await readdir(join(root, "state", "model-operations"))).toHaveLength(1);
				await session.dispose();
			} finally {
				await client.dispose();
			}
			await stop();
			await launch();
			const restored = await connect(secret);
			try {
				const session = await restored.attachSession(sessionId);
				expect(session.snapshot?.transcript.at(-1)).toMatchObject({ status: "error" });
				expect(requests).toHaveLength(2);
				await session.dispose();
			} finally {
				await restored.dispose();
			}
			await stop();
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exit;
			}
			await new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve())));
			await rm(root, { recursive: true, force: true });
		}
	});
});
