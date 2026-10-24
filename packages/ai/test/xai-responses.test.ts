import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { xaiProvider } from "../src/providers/xai.ts";
import type { Context, Model } from "../src/types.ts";
import { generateModelsFixture, modelsDevProvider } from "./generate-models-fixture.ts";

const retiredModelIds = [
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-code-fast-1",
];
const catalog = generateModelsFixture({
	xai: modelsDevProvider({
		...Object.fromEntries(retiredModelIds.map((id) => [id, {}])),
		"grok-4.3": {},
		"grok-4.5": { reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }] },
	}),
});
const grok45 = catalog.getModel("xai", "grok-4.5", "openai-responses");

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_xai_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const result = await xaiProvider().stream(model, context, options).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(captured).toBeDefined();
	return captured!;
}

describe("xAI Responses provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("excludes retired and redundant models from the built-in catalog", () => {
		for (const modelId of retiredModelIds) {
			expect(catalog.getModels("xai").map((model) => model.id)).not.toContain(modelId);
		}
	});

	it("uses Responses for Grok 4.5 with upstream effort options", () => {
		expect(getSupportedThinkingLevels(grok45)).toEqual(["low", "medium", "high"]);
		expect(catalog.getModel("xai", "grok-4.3", "openai-completions").api).toBe("openai-completions");
	});

	it("preserves newly advertised Grok 4.5 effort options", () => {
		const updated = generateModelsFixture({
			xai: modelsDevProvider({
				"grok-4.5": { reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] },
			}),
		});
		expect(getSupportedThinkingLevels(updated.getModel("xai", "grok-4.5", "openai-responses"))).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	it("uses /responses with bearer auth and xAI-compatible request fields", async () => {
		const captured = await captureRequest(
			grok45,
			{
				systemPrompt: "You are a careful coding assistant.",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "xai-test-token",
				sessionId: "pi-session-123",
				cacheRetention: "long",
				reasoningEffort: "medium",
			},
		);

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(captured.headers.get("session_id")).toBe("pi-session-123");
		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			prompt_cache_key: "pi-session-123",
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("prompt_cache_retention");
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "You are a careful coding assistant.",
				}),
			]),
		);
	});
});
