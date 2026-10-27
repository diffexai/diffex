import type { Api, Model, ProviderHeaders } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const integrations = [
	{
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		headers: {
			"HTTP-Referer": "https://diffex.ai",
			"X-OpenRouter-Title": "Diffex",
			"X-OpenRouter-Categories": "cli-agent",
		},
		optional: true,
	},
	{
		provider: "nvidia",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		headers: { "X-BILLING-INVOKE-ORIGIN": "Diffex" },
		optional: true,
	},
	{
		provider: "cloudflare-workers-ai",
		baseUrl: "https://api.cloudflare.com/client/v4/accounts/test/ai/v1",
		headers: { "User-Agent": "diffex-coding-agent" },
		optional: true,
	},
	{
		provider: "cloudflare-ai-gateway",
		baseUrl: "https://gateway.ai.cloudflare.com/v1/test/gateway/compat",
		headers: { "User-Agent": "diffex-coding-agent" },
		optional: true,
	},
	{
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		headers: { "x-opencode-session": "session-id", "x-opencode-client": "diffex" },
		optional: false,
	},
	{
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		headers: { "x-opencode-session": "session-id", "x-opencode-client": "diffex" },
		optional: false,
	},
] satisfies { provider: string; baseUrl: string; headers: Record<string, string>; optional: boolean }[];

function model(provider: string, baseUrl: string): Model<Api> {
	return {
		provider,
		baseUrl,
		id: "test-model",
		name: "Test model",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

describe("provider attribution defaults", () => {
	afterEach(() => vi.unstubAllEnvs());

	for (const integration of integrations) {
		describe(integration.provider, () => {
			it.each([true, false])("retains session behavior when optional attribution is %s", (enabled) => {
				vi.stubEnv("DIFFEX_PROVIDER_ATTRIBUTION", undefined);
				const settings = SettingsManager.inMemory({ enableProviderAttribution: enabled });
				for (const provider of [integration.provider, "custom-provider"]) {
					for (const sessionId of [undefined, "session-id"]) {
						const headers = mergeProviderAttributionHeaders(
							model(provider, integration.baseUrl),
							settings,
							sessionId,
						);
						const present = integration.optional ? enabled : Boolean(sessionId);
						expect(headers).toEqual(present ? integration.headers : undefined);
					}
				}
			});

			it.each(["1", "TRUE", "yes", "0", "false", "NO", ""])("honors the environment override %j", (env) => {
				vi.stubEnv("DIFFEX_PROVIDER_ATTRIBUTION", env);
				const enabled = ["1", "true", "yes"].includes(env.toLowerCase());
				const settings = SettingsManager.inMemory({ enableProviderAttribution: !enabled });
				const headers = mergeProviderAttributionHeaders(
					model(integration.provider, integration.baseUrl),
					settings,
					"session-id",
				);
				expect(headers).toEqual(!integration.optional || enabled ? integration.headers : undefined);
			});

			it("keeps model and caller precedence and explicit null removal", () => {
				vi.stubEnv("DIFFEX_PROVIDER_ATTRIBUTION", undefined);
				const settings = SettingsManager.inMemory({ enableProviderAttribution: true });
				const target = model(integration.provider, integration.baseUrl);
				const modelHeaders: ProviderHeaders = Object.fromEntries(
					Object.keys(integration.headers).map((key) => [key, "model-value"]),
				);
				const callerHeaders: ProviderHeaders = Object.fromEntries(
					Object.keys(integration.headers).map((key) => [key, "caller-value"]),
				);
				const removed: ProviderHeaders = Object.fromEntries(
					Object.keys(integration.headers).map((key) => [key, null]),
				);
				expect(mergeProviderAttributionHeaders(target, settings, "session-id", modelHeaders)).toEqual(modelHeaders);
				expect(
					mergeProviderAttributionHeaders(target, settings, "session-id", modelHeaders, callerHeaders),
				).toEqual(callerHeaders);
				expect(
					mergeProviderAttributionHeaders(target, settings, "session-id", modelHeaders, callerHeaders, removed),
				).toEqual(removed);
			});
		});
	}

	it("leaves unrelated and custom provider headers alone", () => {
		vi.stubEnv("DIFFEX_PROVIDER_ATTRIBUTION", undefined);
		const settings = SettingsManager.inMemory({ enableProviderAttribution: true });
		const headers = { "X-App": "Custom client", "User-Agent": "custom-agent" };
		expect(
			mergeProviderAttributionHeaders(model("custom", "https://example.test/v1"), settings, "session-id", headers),
		).toEqual(headers);
	});
});
