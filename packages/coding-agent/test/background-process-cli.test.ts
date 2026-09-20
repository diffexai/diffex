import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import type { ShellOwnershipRecord } from "../src/utils/owned-shell-processes.ts";
import { readShellProcessGroup } from "../src/utils/shell-process-identity.ts";
import { createBackgroundService, queryBackgroundService } from "./background-service.ts";

describe("background lifetime CLI validation", () => {
	it("requires an explicit policy and handoff destination", () => {
		expect(parseArgs(["--background-process-lifetime=environment"]).diagnostics).not.toEqual([]);
		expect(parseArgs(["--background-process-lifetime", "invalid"]).diagnostics).not.toEqual([]);
		expect(parseArgs(["--background-process-ownership-dir", "/tmp/ownership"]).diagnostics).not.toEqual([]);
		expect(
			parseArgs(["--background-process-lifetime=environment", "--background-process-ownership-dir=/tmp/ownership"])
				.diagnostics,
		).toEqual([]);
		expect(parseArgs(["--background-process-lifetime", "session"]).diagnostics).toEqual([]);
	});
});

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin").each(["text", "json"] as const)(
	"%s CLI background services",
	(mode) => {
		it.each([
			"default",
			"success",
			"provider-error",
			"SIGTERM",
			"SIGHUP",
			"SIGINT",
			"SIGKILL",
			"active-SIGTERM",
			"noisy",
		])(
			"handles %s",
			async (scenario) => {
				const directory = mkdtempSync(join(tmpdir(), "diffex-background-cli-"));
				const ownershipDirectory = join(directory, "ownership");
				const service = createBackgroundService(directory, { noisy: scenario === "noisy" });
				let cli: ChildProcess | undefined;
				let requests = 0;
				let reachableBeforeFinal = false;
				let observedRecords: ShellOwnershipRecord[] = [];
				let providerError: unknown;
				const server = createServer(async (_request, response) => {
					requests++;
					try {
						let delta: Record<string, unknown>;
						let finishReason = "stop";
						if (requests === 1 || (requests === 2 && scenario === "active-SIGTERM")) {
							const command =
								requests === 1
									? service.command
									: "echo $$ > active.pgid; sleep 60 & echo $! > active.pid; wait";
							delta = {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: `launch-${requests}`,
										type: "function",
										function: { name: "bash", arguments: JSON.stringify({ command }) },
									},
								],
							};
							finishReason = "tool_calls";
						} else {
							reachableBeforeFinal = (await queryBackgroundService(service.address().port)) === "service-ok";
							if (scenario !== "default") {
								observedRecords = readdirSync(ownershipDirectory)
									.filter((file) => file.endsWith(".json"))
									.map((file) => JSON.parse(readFileSync(join(ownershipDirectory, file), "utf8")));
							}
							if (scenario === "provider-error") {
								response.writeHead(401, { "Content-Type": "application/json" });
								response.end(JSON.stringify({ error: { message: "Controlled provider failure" } }));
								return;
							}
							if (scenario.startsWith("SIG")) {
								cli!.kill(scenario as NodeJS.Signals);
								return;
							}
							delta = { role: "assistant", content: "service-ready" };
						}
						response.writeHead(200, { "Content-Type": "text/event-stream" });
						response.write(
							`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
						);
						response.write(
							`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`,
						);
						response.end("data: [DONE]\n\n");
					} catch (error) {
						providerError = error;
						response.writeHead(500);
						response.end();
					}
				});
				try {
					server.listen(0, "127.0.0.1");
					await once(server, "listening");
					const address = server.address();
					if (!address || typeof address === "string") throw new Error("Missing mock provider address");
					writeFileSync(
						join(directory, "settings.json"),
						JSON.stringify({ evolution: { enabled: false }, retry: { enabled: false } }),
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
					cli = spawn(
						process.execPath,
						[
							`--import=${import.meta.resolve("tsx")}`,
							resolve(__dirname, "../src/cli.ts"),
							"--mode",
							mode,
							"--provider",
							"fixture",
							"--model",
							"controlled",
							"--thinking",
							"off",
							"--session",
							join(directory, "root.jsonl"),
							"--no-extensions",
							"--no-skills",
							"--no-context-files",
							"--no-prompt-templates",
							"--no-themes",
							"--no-approve",
							...(scenario === "default"
								? []
								: [
										"--background-process-lifetime=environment",
										"--background-process-ownership-dir",
										ownershipDirectory,
									]),
							"--print",
							"Launch the service",
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
							timeout: 15_000,
						},
					);
					let stdout = "";
					let stderr = "";
					cli.stdout!.on("data", (chunk) => {
						stdout += chunk.toString();
					});
					cli.stderr!.on("data", (chunk) => {
						stderr += chunk.toString();
					});
					const closed = once(cli, "close");
					if (scenario === "active-SIGTERM") {
						await vi.waitFor(
							() => expect(Number(readFileSync(join(directory, "active.pid"), "utf8"))).toBeGreaterThan(0),
							{ timeout: 10_000 },
						);
						reachableBeforeFinal = (await queryBackgroundService(service.address().port)) === "service-ok";
						cli.kill("SIGTERM");
					}
					const [code, signal] = await closed;
					expect(providerError).toBeUndefined();
					expect(reachableBeforeFinal).toBe(true);
					if (scenario === "SIGKILL") expect(signal).toBe("SIGKILL");
					else if (scenario.startsWith("SIG") || scenario === "active-SIGTERM") {
						expect(code, stderr).toBe(scenario === "SIGHUP" ? 129 : scenario === "SIGINT" ? 130 : 143);
					} else {
						expect(code, stderr).toBe(scenario === "provider-error" ? 1 : 0);
						if (scenario !== "provider-error") expect(stdout).toContain("service-ready");
						expect(readFileSync(join(directory, "root.jsonl"), "utf8")).toContain('"role":"assistant"');
					}
					if (scenario === "default") {
						await expect(queryBackgroundService(service.address().port)).rejects.toThrow();
					} else {
						await expect(queryBackgroundService(service.address().port)).resolves.toBe("service-ok");
						if (scenario !== "active-SIGTERM") {
							expect(observedRecords).toHaveLength(1);
							expect(observedRecords[0]).toMatchObject({ owner: "environment", state: "background" });
							expect(observedRecords[0].members.some((member) => member.pid === service.address().pid)).toBe(
								true,
							);
							expect(readShellProcessGroup(observedRecords[0].processGroupId)).toEqual(
								observedRecords[0].members,
							);
						} else {
							expect(
								readShellProcessGroup(Number(readFileSync(join(directory, "active.pgid"), "utf8"))),
							).toEqual([]);
						}
					}
				} finally {
					if (cli && cli.exitCode === null && cli.signalCode === null) {
						cli.kill("SIGKILL");
						await once(cli, "close");
					}
					service.cleanup();
					server.closeAllConnections();
					await new Promise<void>((done) => server.close(() => done()));
					rmSync(directory, { recursive: true, force: true });
				}
			},
			20_000,
		);
	},
);
