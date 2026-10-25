import { complete, resetApiProviders } from "@diffexai/diffex-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function createOfflineFetch(): { fetch: typeof globalThis.fetch; requests: Request[] } {
	const requests: Request[] = [];
	return {
		requests,
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			const chunk = {
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 0,
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	};
}

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

function getCloudflareCompatModelId(modelRuntime: ModelRuntime): string {
	const model = modelRuntime
		.getModels("cloudflare-ai-gateway")
		.find((candidate) => candidate.api === "openai-completions" && candidate.baseUrl.endsWith("/compat"));
	if (!model) throw new Error("Cloudflare AI Gateway has no OpenAI-compatible model");
	return model.id;
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", getCloudflareCompatModelId(modelRuntime));
		expect(model).toBeDefined();
		const offline = createOfflineFetch();

		resetApiProviders();
		const result = await modelRuntime.completeSimple(model!, { messages: [] }, { fetch: offline.fetch });

		expect(result.stopReason).toBe("stop");
		expect(offline.requests).toHaveLength(1);
		expect(offline.requests[0].url).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat/chat/completions",
		);
		expect(offline.requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRuntime, modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", getCloudflareCompatModelId(modelRuntime));
		expect(model).toBeDefined();
		const offline = createOfflineFetch();

		resetApiProviders();
		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		const result = await complete(model!, { messages: [] }, { ...auth, fetch: offline.fetch });

		expect(result.stopReason).toBe("stop");
		expect(offline.requests).toHaveLength(1);
		expect(offline.requests[0].url).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat/chat/completions",
		);
		expect(offline.requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-token");
		expect(offline.requests[0].headers.has("Authorization")).toBe(false);
		expect(offline.requests[0].headers.has("x-api-key")).toBe(false);
	});
});
