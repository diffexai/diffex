import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	finishReason: "MALFORMED_FUNCTION_CALL",
	toolCall: false,
	requests: [] as GenerateContentParameters[],
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* (params: GenerateContentParameters) {
				googleGenAiMock.requests.push(params);
				yield {
					responseId: "google-response-id",
					candidates: [
						{
							finishReason: googleGenAiMock.finishReason,
							...(googleGenAiMock.toolCall && {
								content: { parts: [{ functionCall: { name: "lookup", args: {} } }] },
							}),
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 0,
						totalTokenCount: 1,
					},
				};
			},
		};
	}

	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			CONTINUATION: "CONTINUATION",
			TOO_MANY_TOOL_CALLS: "TOO_MANY_TOOL_CALLS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			NONE: "NONE",
			ANY: "ANY",
			VALIDATED: "VALIDATED",
		},
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("Google raw stop reasons", () => {
	it.each(["google-generative-ai", "google-vertex"] as const)(
		"disables automatic continuation and maps new finish reasons for %s",
		async (api) => {
			for (const toolCall of [false, true]) {
				for (const [finishReason, expected] of [
					["CONTINUATION", "length"],
					["TOO_MANY_TOOL_CALLS", "error"],
					["STOP", toolCall ? "toolUse" : "stop"],
				] as const) {
					googleGenAiMock.finishReason = finishReason;
					googleGenAiMock.toolCall = toolCall;
					googleGenAiMock.requests = [];
					const options = { apiKey: "test-api-key" };
					const stream =
						api === "google-generative-ai"
							? streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, options)
							: streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, options);
					const message = await stream.result();

					expect(googleGenAiMock.requests).toHaveLength(1);
					expect(googleGenAiMock.requests[0].config?.automaticContinuation).toBe(false);
					expect(message.stopReason).toBe(expected);
					expect(message.rawStopReason).toBe(finishReason);
					expect(message.errorMessage).toBe(
						expected === "error" ? `Provider stopped with: ${finishReason}` : undefined,
					);
				}
			}
			googleGenAiMock.toolCall = false;
		},
	);

	it("preserves raw Gemini finish reasons for Google Generative AI errors", async () => {
		googleGenAiMock.finishReason = "MALFORMED_FUNCTION_CALL";

		const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "test-api-key",
		});

		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("MALFORMED_FUNCTION_CALL");
		expect(message.errorMessage).toBe("Provider stopped with: MALFORMED_FUNCTION_CALL");
	});

	it("preserves raw Gemini finish reasons for Google Vertex errors", async () => {
		googleGenAiMock.finishReason = "SAFETY";

		const stream = streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, {
			project: "test-project",
			location: "us-central1",
		});

		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("SAFETY");
		expect(message.errorMessage).toBe("Provider stopped with: SAFETY");
	});
});
