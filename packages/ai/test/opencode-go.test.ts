import { afterEach, expect, it, vi } from "vitest";
import { createModels } from "../src/models.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Model } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

it("streams Google models through OpenCode Go with its API key and endpoint", async () => {
	const fetchMock = vi.fn<typeof fetch>(
		async () =>
			new Response(
				`data: ${JSON.stringify({
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				})}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const models = createModels({
		authContext: {
			env: async (name) => (name === "OPENCODE_API_KEY" ? "test-opencode-key" : undefined),
			fileExists: async () => false,
		},
	});
	models.setProvider(opencodeGoProvider());
	const model: Model<"google-generative-ai"> = {
		id: "gemini-test",
		name: "Gemini test",
		api: "google-generative-ai",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	const result = await models.completeSimple(model, {
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	});
	expect(result.errorMessage).toBeUndefined();
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
	expect(fetchMock).toHaveBeenCalledOnce();
	const [input, init] = fetchMock.mock.calls[0];
	const request = new Request(input, init);
	expect(request.url).toBe("https://opencode.ai/zen/go/v1/models/gemini-test:streamGenerateContent?alt=sse");
	expect(request.headers.get("x-goog-api-key")).toBe("test-opencode-key");
});
