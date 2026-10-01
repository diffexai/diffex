import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, isRetryableAssistantError, retryAssistantCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.ts";
import { generateSummaryWithUsage } from "../src/core/compaction/compaction.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { captureSubagentSessionConfig, createSubagentSession } from "../src/core/subagents/services.ts";

const sessionId = "2f1c9e00-aaaa-4000-8000-000000000001";
const baseUrl = `https://cloud.fixture/v1/runtime/sessions/${sessionId}/model`;
const modelId = "claude-sonnet-4-5";
const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 1 }] };
const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntime() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "gateway-runtime-test-")));
	roots.push(directory);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		hostedGateway: {
			baseUrl,
			credential: "gateway-fixture-credential",
			provider: "anthropic",
			modelId,
			stateDirectory: directory,
			maxOutputTokens: 8192,
		},
	});
	const model = runtime.getModel("anthropic", modelId);
	if (!model) throw new Error("Missing fixture model");
	return { runtime, model, directory };
}

function completion(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				model: modelId,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("hosted model gateway", () => {
	test("persists a private operation before send, constrains headers, and uses a unique ID for identical calls", async () => {
		const { runtime, model, directory } = await createRuntime();
		const ids: string[] = [];
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			expect(request.url).toBe(`${baseUrl}/v1/messages`);
			expect(request.headers.get("x-api-key")).toBe("gateway-fixture-credential");
			expect(request.headers.get("authorization")).toBeNull();
			expect(request.headers.get("x-untrusted")).toBeNull();
			expect(request.redirect).toBe("error");
			const id = request.headers.get("x-diffex-operation-id")!;
			expect(id).toMatch(/^[0-9a-f-]{36}$/u);
			ids.push(id);
			const pending = join(directory, "model-operations", `${id}.json`);
			const record = JSON.parse(await readFile(pending, "utf8"));
			expect(record).toMatchObject({ version: 1, operationId: id, model: modelId });
			expect(record.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
			expect(JSON.stringify(record)).not.toContain("Say hello");
			expect((await stat(pending)).mode & 0o777).toBe(0o600);
			const payload = await request.json();
			expect(payload).toMatchObject({ model: modelId, stream: true, max_tokens: 16 });
			return completion();
		});
		for (let i = 0; i < 2; i++) {
			const result = await runtime.completeSimple(model, context, {
				maxTokens: 16,
				headers: { "x-untrusted": "ignored" },
				maxRetries: 10,
			});
			expect(result.stopReason).toBe("stop");
			expect(result.usage).toMatchObject({ input: 8, output: 2 });
		}
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(ids[0]).not.toBe(ids[1]);
		expect(await readdir(join(directory, "model-operations"))).toEqual([]);
		expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toEqual([modelId]);
	});

	test.each(["in_progress", "unresolved", "completed_output_unavailable", "unavailable"])(
		"does not retry gateway %s at provider or summary retry layers",
		async (code) => {
			const { runtime, model, directory } = await createRuntime();
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					Response.json(
						{ type: "error", error: { type: "api_error", message: `gateway_${code}` } },
						{ status: code === "unavailable" ? 503 : 409 },
					),
				);
			const produce = vi.fn(() => runtime.completeSimple(model, context, { maxRetries: 4 }));
			const result = await retryAssistantCall(produce, { enabled: true, maxRetries: 4, baseDelayMs: 1 }, undefined);
			expect(result.stopReason).toBe("error");
			expect(result.retryable).toBe(false);
			expect(result.errorMessage).toContain(`gateway_${code}`);
			expect(result.diagnostics?.at(-1)).toMatchObject({ type: "model_gateway_failure", error: { code } });
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(produce).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(await readdir(join(directory, "model-operations"))).toHaveLength(1);
		},
	);

	test.each(["socket hang up", "Request timed out", "fetch failed"])(
		"retains pending evidence and never retries ambiguous %s",
		async (message) => {
			const { runtime, model, directory } = await createRuntime();
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(message));
			const result = await retryAssistantCall(
				() => runtime.completeSimple(model, context, { maxRetries: 10 }),
				{ enabled: true, maxRetries: 10, baseDelayMs: 1 },
				undefined,
			);
			expect(result.retryable).toBe(false);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(await readdir(join(directory, "model-operations"))).toHaveLength(1);
		},
	);

	test("rejects endpoint, model, direct credentials and custom transports before send", async () => {
		const { runtime, model } = await createRuntime();
		const fetch = vi.spyOn(globalThis, "fetch");
		for (const override of [
			{ ...model, baseUrl: "https://api.other-provider.test" },
			{ ...model, id: "another" },
		]) {
			expect((await runtime.completeSimple(override, context)).errorMessage).toContain(
				"gateway_model_override_forbidden",
			);
		}
		expect((await runtime.completeSimple(model, context, { apiKey: "direct-provider-key" })).errorMessage).toContain(
			"gateway_transport_override_forbidden",
		);
		expect((await runtime.completeSimple(model, context, { fetch: globalThis.fetch })).errorMessage).toContain(
			"gateway_transport_override_forbidden",
		);
		expect(() => runtime.registerNativeProvider(runtime.getProvider("anthropic")!)).toThrow("provider overrides");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("does not replay pending calls when the runtime restarts", async () => {
		const { runtime, model, directory } = await createRuntime();
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("socket hang up"));
		await runtime.completeSimple(model, context);
		const files = await readdir(join(directory, "model-operations"));
		await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			hostedGateway: {
				baseUrl,
				credential: "replacement-gateway-credential",
				provider: "anthropic",
				modelId,
				stateDirectory: directory,
				maxOutputTokens: 8192,
			},
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await readdir(join(directory, "model-operations"))).toEqual(files);
	});

	test("keeps dropped terminal streams non-retryable and enforces the server output cap before send", async () => {
		const { runtime, model, directory } = await createRuntime();
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const body = await completion().text();
			return new Response(body.replace('event: message_stop\ndata: {"type":"message_stop"}\n\n', ""), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const result = await retryAssistantCall(
			() => runtime.completeSimple(model, context),
			{ enabled: true, maxRetries: 4, baseDelayMs: 1 },
			undefined,
		);
		expect(result.retryable).toBe(false);
		expect(result.errorMessage).toContain("gateway_transport_or_stream_interrupted");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await readdir(join(directory, "model-operations"))).toHaveLength(1);
		const excessive = await runtime.completeSimple(model, context, { maxTokens: 9000 });
		expect(excessive.errorMessage).toContain("gateway_invalid_request");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await readdir(join(directory, "model-operations"))).toHaveLength(1);
	});

	test("routes actual parent, compaction, branch summary and child agent calls through one gateway", async () => {
		const { runtime, model, directory } = await createRuntime();
		const requests: Array<{ id: string; payload: Record<string, unknown> }> = [];
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			expect(request.url).toBe(`${baseUrl}/v1/messages`);
			expect(request.headers.get("x-api-key")).toBe("gateway-fixture-credential");
			requests.push({
				id: request.headers.get("x-diffex-operation-id")!,
				payload: (await request.json()) as Record<string, unknown>,
			});
			return completion();
		});
		const { session: parent } = await createAgentSession({
			cwd: directory,
			agentDir: join(directory, "agent"),
			modelRuntime: runtime,
			model,
			sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 4, baseDelayMs: 1 },
			}),
		});
		let child: Awaited<ReturnType<typeof createSubagentSession>> | undefined;
		try {
			await parent.prompt("A parent request");
			const summary = await generateSummaryWithUsage(
				parent.agent.state.messages,
				model,
				16384,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				parent.agent.streamFunction,
			);
			expect(summary.text).toBe("Hello");
			const branch = await generateBranchSummary(parent.sessionManager.getBranch(), {
				model,
				signal: new AbortController().signal,
				streamFn: parent.agent.streamFunction,
			});
			expect(branch.summary).toContain("Hello");
			child = await createSubagentSession(captureSubagentSessionConfig(parent, join(directory, "agent")), {
				childName: "gateway_child",
			});
			expect(child.modelRuntime).toBe(runtime);
			await child.prompt("A child request");
			expect(fetch).toHaveBeenCalledTimes(4);
			expect(new Set(requests.map((request) => request.id)).size).toBe(4);
			for (const request of requests) expect(request.payload).toMatchObject({ model: modelId, stream: true });
			expect(requests[0]?.payload.max_tokens).toBe(8192);
			expect(requests[1]?.payload.max_tokens).toBeLessThanOrEqual(8192);
			expect(await readdir(join(directory, "model-operations"))).toEqual([]);
		} finally {
			await child?.dispose();
			await parent.dispose();
		}
	});

	test.skipIf(process.getuid?.() === 0)(
		"preserves completed output and usage when pending metadata cannot be removed",
		async () => {
			const { runtime, model, directory } = await createRuntime();
			const pendingDirectory = join(directory, "model-operations");
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
				await chmod(pendingDirectory, 0o500);
				return completion();
			});
			try {
				const result = await runtime.completeSimple(model, context);
				expect(result.stopReason).toBe("stop");
				expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
				expect(result.usage).toMatchObject({ input: 8, output: 2 });
				expect(result.diagnostics?.at(-1)?.type).toBe("model_gateway_pending_cleanup_failed");
				expect(await readdir(pendingDirectory)).toHaveLength(1);
			} finally {
				await chmod(pendingDirectory, 0o700);
			}
		},
	);

	test("gives each generation in an actual tool loop a distinct durable operation ID", async () => {
		const { runtime, model, directory } = await createRuntime();
		await writeFile(join(directory, "tool-loop-fixture.txt"), "gateway-tool-loop");
		const requests: Array<{ id: string; payload: Record<string, unknown> }> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			requests.push({
				id: request.headers.get("x-diffex-operation-id")!,
				payload: (await request.json()) as Record<string, unknown>,
			});
			if (requests.length > 1) return completion();
			const events = [
				{
					type: "message_start",
					message: {
						id: "msg_tool_fixture",
						type: "message",
						role: "assistant",
						model: modelId,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 8,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "tool_fixture", name: "read", input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"path":"tool-loop-fixture.txt"}' },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			];
			return new Response(
				events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: join(directory, "agent"),
			modelRuntime: runtime,
			model,
			sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		});
		try {
			await session.prompt("Execute the harmless fixture tool and then answer.");
			expect(requests).toHaveLength(2);
			expect(requests[0]?.id).not.toBe(requests[1]?.id);
			expect(JSON.stringify(requests[1]?.payload.messages)).toContain('"type":"tool_result"');
			expect(JSON.stringify(requests[1]?.payload.messages)).toContain("gateway-tool-loop");
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(await readdir(join(directory, "model-operations"))).toEqual([]);
		} finally {
			await session.dispose();
		}
	});
});
