import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels, hasApi } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import type { Context } from "../src/types.ts";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const credential: OAuthCredential = {
	type: "oauth",
	access: "opaque-access",
	refresh: "refresh",
	expires: Date.now() + 3600_000,
	clientId: "oaiapp_diffex",
	subject: "account",
	extAgentHostId: "urn:uuid:host",
	scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
};
const catalog = { models: [{ slug: "gpt-6.1-sol", display_name: "Account model", visibility: "list" }] };
const context: Context = {
	messages: [{ role: "user", content: "Use a tool", timestamp: 1 }],
	tools: [{ name: "lookup", description: "Look up a value", parameters: Type.Object({ key: Type.String() }) }],
};

function sse(events: unknown[]) {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function textEvents() {
	return [
		{ type: "response.created", response: { id: "resp_test" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_test", role: "assistant", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, delta: "Hello" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_test",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
	];
}

function completed() {
	return {
		type: "response.completed",
		response: {
			id: "resp_test",
			status: "completed",
			usage: {
				input_tokens: 100,
				input_tokens_details: { cached_tokens: 40 },
				output_tokens: 30,
				output_tokens_details: { reasoning_tokens: 20 },
				total_tokens: 130,
			},
		},
	};
}

async function runtime() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-codex", async () => credential);
	const store = new InMemoryModelsStore();
	const models = createModels({ credentials, modelsStore: store });
	models.setProvider(openaiCodexProvider());
	expect((await models.refresh()).errors.size).toBe(0);
	const model = models.getModel("openai-codex", "gpt-6.1-sol");
	if (!model) throw new Error("Model not discovered");
	return { models, model, credentials, store };
}

it("discovers only the signed-in account's listed models at the public endpoint", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-codex", async () => ({
		type: "oauth",
		access: "opaque-access",
		refresh: "refresh",
		expires: Date.now() + 3600_000,
		clientId: "oaiapp_diffex",
		subject: "account",
		extAgentHostId: "urn:uuid:host",
		scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
	}));
	const fetch = vi.fn(async () =>
		Response.json({
			models: [
				{ slug: "account-first", display_name: "First model", visibility: "list" },
				{ slug: "hidden", display_name: "Hidden model", visibility: "hide" },
				{ slug: "account-second", display_name: "Second model", visibility: "list" },
			],
		}),
	);
	vi.stubGlobal("fetch", fetch);
	const models = createModels({ credentials });
	models.setProvider(openaiCodexProvider());
	expect((await models.refresh()).errors.size).toBe(0);
	expect(fetch).toHaveBeenCalledWith(
		"https://api.openai.com/v1/models",
		expect.objectContaining({
			headers: expect.objectContaining({ Authorization: "Bearer opaque-access" }),
		}),
	);
	expect((await models.getAvailable()).map((model) => [model.id, model.name, model.api, model.baseUrl])).toEqual([
		["account-first", "First model", "openai-responses", "https://api.openai.com/v1"],
		["account-second", "Second model", "openai-responses", "https://api.openai.com/v1"],
	]);
});

it("streams text and usage over public Responses with subscription billing", async () => {
	let body: Record<string, unknown> | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/models")) return Response.json(catalog);
			expect(String(input)).toBe("https://api.openai.com/v1/responses");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer opaque-access");
			expect(new Headers(init?.headers).has("chatgpt-account-id")).toBe(false);
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([...textEvents(), completed()]);
		}),
	);
	const { models, model } = await runtime();
	const events: string[] = [];
	const stream = models.streamSimple(model, context, {
		reasoning: "high",
		samplingParams: { store: true, stream: false },
		onPayload: (payload) => ({ ...(payload as object), store: true, stream: false }),
	});
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	expect(events).toContain("text_delta");
	expect(result.stopReason).toBe("stop");
	expect(result.usage).toMatchObject({
		input: 60,
		output: 30,
		cacheRead: 40,
		reasoning: 20,
		totalTokens: 130,
		cost: { total: 0 },
	});
	expect(body).toMatchObject({
		store: false,
		stream: true,
		reasoning: { effort: "high", summary: "auto" },
		include: ["reasoning.encrypted_content"],
	});
});

it.each(["fresh", "cached offline", "cached after refresh failure"])(
	"omits unsupported prompt-cache options for summaries with a %s catalog",
	async (catalogState) => {
		const bodies: Record<string, unknown>[] = [];
		let failCatalogRefresh = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input).endsWith("/models")) {
					if (failCatalogRefresh) return new Response(null, { status: 503 });
					return Response.json(catalog);
				}
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				bodies.push(body);
				if ("prompt_cache_options" in body) {
					return Response.json(
						{
							error: {
								message: "prompt_cache_options is not supported on this model",
								type: "invalid_request_error",
								param: "prompt_cache_options",
								code: "invalid_parameter",
							},
						},
						{ status: 400 },
					);
				}
				return sse([...textEvents(), completed()]);
			}),
		);
		const initial = await runtime();
		let models = initial.models;
		if (catalogState !== "fresh") {
			const stored = await initial.store.read("openai-codex");
			if (!stored) throw new Error("Catalog not persisted");
			// Simulate a catalog persisted before the hotfix with inherited API-key capabilities.
			await initial.store.write("openai-codex", {
				...stored,
				models: stored.models.map((model) => ({
					...model,
					compat: { ...model.compat, supportsExplicitPromptCacheMode: true },
				})),
			});
			models = createModels({ credentials: initial.credentials, modelsStore: initial.store });
			models.setProvider(openaiCodexProvider());
			failCatalogRefresh = catalogState === "cached after refresh failure";
			const refresh = await models.refresh({ allowNetwork: failCatalogRefresh });
			expect(refresh.errors.size).toBe(failCatalogRefresh ? 1 : 0);
		}
		const model = models.getModel("openai-codex", "gpt-6.1-sol");
		if (!model || !hasApi(model, "openai-responses")) throw new Error("Responses model not discovered");
		const options = { cacheRetention: "none" as const, sessionId: "summary-session" };
		for (const result of [
			await models.completeSimple(model, context, options),
			await models.complete(model, context, options),
		]) {
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
		}
		expect(model.compat?.supportsExplicitPromptCacheMode).toBe(false);
		expect(model.compat?.supportsStrictMode).toBe(true);
		expect(model.compat?.supportsOpenAIGrammarTools).toBe(true);
		const apiKeyModel = openaiProvider()
			.getModels()
			.find((entry) => entry.id === model.id);
		expect(apiKeyModel?.compat?.supportsExplicitPromptCacheMode).toBe(true);
		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(body).not.toHaveProperty("prompt_cache_options");
			expect(body).not.toHaveProperty("prompt_cache_key");
			expect(body).not.toHaveProperty("prompt_cache_retention");
		}
	},
);

it("streams tool arguments and replays tool results and encrypted reasoning", async () => {
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/models")) return Response.json(catalog);
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			if (bodies.length > 1) return sse([...textEvents(), completed()]);
			return sse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_1", summary: [] },
				},
				{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Check the value" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "rs_1",
						summary: [{ type: "summary_text", text: "Check the value" }],
						encrypted_content: "encrypted",
					},
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"key":' },
				{ type: "response.function_call_arguments.delta", output_index: 1, delta: '"value"}' },
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "lookup",
						arguments: '{"key":"value"}',
					},
				},
				completed(),
			]);
		}),
	);
	const { models, model } = await runtime();
	const events: string[] = [];
	const stream = models.streamSimple(model, context, { reasoning: "high" });
	for await (const event of stream) events.push(event.type);
	const first = await stream.result();
	expect(events).toContain("thinking_delta");
	expect(events).toContain("toolcall_delta");
	expect(first.stopReason).toBe("toolUse");
	const tool = first.content.find((block) => block.type === "toolCall");
	expect(tool).toMatchObject({ name: "lookup", arguments: { key: "value" } });
	const result = await models.completeSimple(model, {
		...context,
		messages: [
			...context.messages,
			first,
			{
				role: "toolResult",
				toolName: "lookup",
				toolCallId: tool!.id,
				isError: false,
				content: [{ type: "text", text: "found" }],
				timestamp: 2,
			},
		],
	});
	expect(result.stopReason).toBe("stop");
	expect(bodies[1].input).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted" }),
			expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "found" }),
		]),
	);
});

it.each(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"])(
	"surfaces late %s failures",
	async (code) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).endsWith("/models")
					? Response.json(catalog)
					: sse([
							...textEvents(),
							{
								type: "response.failed",
								response: { status: "failed", error: { code, message: "Usage unavailable" } },
							},
						]),
			),
		);
		const { models, model, credentials } = await runtime();
		const result = await models.completeSimple(model, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(code);
		expect(await credentials.read("openai-codex")).toEqual(credential);
	},
);

it.each(["incomplete", "interrupted"])("distinguishes %s output from completed inference", async (status) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) =>
			String(input).endsWith("/models")
				? Response.json(catalog)
				: sse([
						...textEvents(),
						...(status === "incomplete"
							? [
									{
										type: "response.incomplete",
										response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
									},
								]
							: []),
					]),
		),
	);
	const { models, model } = await runtime();
	expect((await models.completeSimple(model, context)).stopReason).toBe(status === "incomplete" ? "length" : "error");
});

it.each(["cancellation", "logout"])("stops an active HTTP stream on %s", async (action) => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-chatgpt-inference-"));
	directories.push(directory);
	vi.stubEnv("DIFFEX_CODING_AGENT_DIR", directory);
	let requestSignal: AbortSignal | null | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith("/models")) return Response.json(catalog);
			if (String(input).endsWith("/.well-known/openid-configuration"))
				return Response.json({
					issuer: "https://auth.openai.com",
					revocation_endpoint: "https://auth.openai.com/oauth/revoke",
				});
			if (String(input).endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
			requestSignal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								textEvents()
									.slice(0, 3)
									.map((event) => `data: ${JSON.stringify(event)}\n\n`)
									.join(""),
							),
						);
						init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}),
	);
	const { models, model } = await runtime();
	const controller = new AbortController();
	const stream = models.streamSimple(model, context, { signal: controller.signal });
	for await (const event of stream) {
		if (event.type !== "text_delta") continue;
		if (action === "logout") await models.logout("openai-codex");
		else controller.abort();
	}
	expect((await stream.result()).stopReason).toBe("aborted");
	expect(requestSignal?.aborted).toBe(true);
});

it("isolates cached catalogs across accounts, failures, and restart", async () => {
	const fetch = vi.fn(async () => Response.json(catalog));
	vi.stubGlobal("fetch", fetch);
	const { models, credentials, store, model } = await runtime();
	const restarted = createModels({ credentials, modelsStore: store });
	restarted.setProvider(openaiCodexProvider());
	await restarted.refresh({ allowNetwork: false });
	expect((await restarted.getAvailable()).map((entry) => entry.id)).toEqual([model.id]);
	expect(fetch).toHaveBeenCalledOnce();
	await credentials.modify("openai-codex", async () => ({
		...credential,
		clientId: "oaiapp_other",
		subject: "other",
	}));
	expect(await models.getAvailable()).toEqual([]);
	fetch.mockRejectedValue(new Error("network unavailable"));
	expect((await models.refresh()).errors.size).toBe(1);
	expect(models.getModels("openai-codex")).toEqual([]);
	expect((await models.completeSimple(model, context)).stopReason).toBe("error");
});

it("keeps the last valid same-account catalog after a malformed response", async () => {
	const fetch = vi.fn(async () => Response.json(catalog));
	vi.stubGlobal("fetch", fetch);
	const { models, store } = await runtime();
	const before = await store.read("openai-codex");
	fetch.mockResolvedValue(Response.json({ models: [{ slug: "broken", visibility: "list" }] }));
	expect((await models.refresh()).errors.size).toBe(1);
	expect(await store.read("openai-codex")).toEqual(before);
	expect((await models.getAvailable()).map((entry) => entry.id)).toEqual(["gpt-6.1-sol"]);
});
