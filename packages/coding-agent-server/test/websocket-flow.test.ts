import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffexClient } from "@earendil-works/diffex-client";
import { createWebSocketTransportFactory } from "@earendil-works/diffex-client/websocket";
import { ModelRuntime } from "@earendil-works/diffex-coding-agent";
import { DiffexServer } from "@earendil-works/diffex-server";
import { TestServerService } from "@earendil-works/diffex-server/testing";
import { createWebSocketListener } from "@earendil-works/diffex-server/websocket";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createHostedCodingAgentService } from "../src/service.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("hosted Diffex runtime", () => {
	it("carries the native protocol over an authorized WebSocket", async () => {
		const service = new TestServerService();
		service.seed("cloud-session-1", "Cloud session");
		const listener = createWebSocketListener({
			port: 0,
			path: "/runtime",
			authorize: (request) => ({ authorized: request.headers.authorization === "Bearer internal-secret" }),
		});
		const server = new DiffexServer(service, { listeners: [listener] });
		await server.start();

		try {
			const address = server.addresses[0];
			if (!address) throw new Error("Missing WebSocket server address");
			await expect(
				DiffexClient.connect({
					transportFactory: authorizedTransport(address, "wrong-secret"),
				}),
			).rejects.toThrow();
			const client = await DiffexClient.connect({
				transportFactory: authorizedTransport(address, "internal-secret"),
			});

			try {
				expect((await client.listSessions()).map((session) => session.id)).toEqual(["cloud-session-1"]);
				const session = await client.attachSession("cloud-session-1");
				expect(session.snapshot?.id).toBe("cloud-session-1");
				const prompt = session.prompt("hello cloud");
				const runtime = service.latestRuntime("cloud-session-1");
				await waitFor(() => runtime.getPhase() === "turn");
				runtime.emitProgress({
					type: "assistant_delta",
					messageId: "assistant-streaming",
					contentIndex: 0,
					kind: "text",
					delta: "reply:",
				});
				runtime.finishPrompt();
				await expect(prompt).resolves.toMatchObject({
					phase: "idle",
					transcript: [
						{ role: "user", content: [{ type: "text", text: "hello cloud" }] },
						{ role: "assistant", content: [{ type: "text", text: "reply:hello cloud" }] },
					],
				});
				await session.dispose();
			} finally {
				await client.dispose();
			}

			const reconnected = await DiffexClient.connect({
				transportFactory: authorizedTransport(address, "internal-secret"),
			});
			try {
				const session = await reconnected.attachSession("cloud-session-1");
				expect(session.snapshot?.transcript).toHaveLength(2);
				await session.dispose();
			} finally {
				await reconnected.dispose();
			}
		} finally {
			await server.close();
		}
	});

	it("persists an empty cloud session before the first model response", async () => {
		const root = temporaryDirectory();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		});
		await modelRuntime.setRuntimeApiKey("anthropic", "test-api-key");

		const first = await createHostedCodingAgentService({
			sessionId: "cloud-session-2",
			cwd,
			agentDir,
			sessionDir,
			modelRuntime,
		});
		const firstMetadata = (await first.listSessions())[0];
		expect(firstMetadata?.id).toBe("cloud-session-2");

		const reopened = await createHostedCodingAgentService({
			sessionId: "cloud-session-2",
			cwd,
			agentDir,
			sessionDir,
			modelRuntime,
		});
		const reopenedMetadata = (await reopened.listSessions())[0];
		expect(reopenedMetadata?.createdAt).toBe(firstMetadata?.createdAt);
		const runtime = await reopened.openSession("cloud-session-2");
		expect(runtime.snapshot()).toMatchObject({
			id: "cloud-session-2",
			cwd,
			phase: "idle",
			transcript: [],
		});
		await runtime.dispose();
	});
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "diffex-hosted-runtime-"));
	temporaryDirectories.push(directory);
	return directory;
}

function authorizedTransport(address: string, secret: string) {
	return createWebSocketTransportFactory({
		url: address,
		webSocket: class extends WebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols, { headers: { authorization: `Bearer ${secret}` } });
			}
		} as never,
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for runtime state");
}
