import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonAgentSessionEvent } from "../src/modes/json-event.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");

describe.each(["text", "json"] as const)("%s CLI provider outcomes", (mode) => {
	it.each(["success", "authentication", "exhausted", "recovered"])(
		"reports %s",
		async (scenario) => {
			const directory = mkdtempSync(join(tmpdir(), "diffex-print-outcome-"));
			let requests = 0;
			const server = createServer((_request, response) => {
				requests++;
				if (
					scenario === "authentication" ||
					scenario === "exhausted" ||
					(scenario === "recovered" && requests === 1)
				) {
					response.writeHead(scenario === "authentication" ? 401 : 503, { "Content-Type": "application/json" });
					response.end(
						JSON.stringify({
							error: {
								message:
									scenario === "authentication"
										? "Controlled invalid API key"
										: "Controlled service overloaded",
							},
						}),
					);
					return;
				}
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write(
					`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "controlled-ok" }, finish_reason: null }] })}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				response.end("data: [DONE]\n\n");
			});
			try {
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Missing fixture address");
				writeFileSync(
					join(directory, "settings.json"),
					JSON.stringify({
						evolution: { enabled: false },
						retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
					}),
				);
				writeFileSync(
					join(directory, "models.json"),
					JSON.stringify({
						providers: {
							fixture: {
								baseUrl: `http://127.0.0.1:${address.port}/v1`,
								api: "openai-completions",
								apiKey: "fixture-only",
								models: [
									{
										id: "controlled",
										name: "controlled",
										reasoning: false,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 8192,
										maxTokens: 1024,
									},
								],
							},
						},
					}),
				);
				const session = join(directory, "root.jsonl");
				const child = spawn(
					process.execPath,
					[
						`--import=${import.meta.resolve("tsx")}`,
						cliPath,
						"--mode",
						mode,
						"--provider",
						"fixture",
						"--model",
						"controlled",
						"--thinking",
						"off",
						"--session",
						session,
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-approve",
						"--print",
						"Say ok",
					],
					{
						cwd: directory,
						env: {
							PATH: process.env.PATH,
							HOME: directory,
							DIFFEX_CODING_AGENT_DIR: directory,
							DIFFEX_OFFLINE: "1",
							TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
						},
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 15000,
					},
				);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				const [code] = await once(child, "close");
				const failed = scenario === "authentication" || scenario === "exhausted";
				expect(code, stderr).toBe(failed ? 1 : 0);
				expect(requests).toBe(scenario === "exhausted" || scenario === "recovered" ? 2 : 1);
				expect(readFileSync(session, "utf8")).toContain('"role":"assistant"');
				if (mode === "json") {
					const events = stdout
						.trim()
						.split("\n")
						.map((line): JsonAgentSessionEvent => JSON.parse(line))
						.reverse();
					const finalMessage = events.find((event) => event.type === "agent_end")?.messages.at(-1);
					expect(finalMessage?.role === "assistant" && finalMessage.stopReason).toBe(failed ? "error" : "stop");
					if (requests === 2)
						expect(events.find((event) => event.type === "auto_retry_end")?.success).toBe(!failed);
				} else if (!failed) {
					expect(stdout.trim()).toBe("controlled-ok");
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				rmSync(directory, { recursive: true, force: true });
			}
		},
		20000,
	);
});
