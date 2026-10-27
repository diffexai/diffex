import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Credential, InMemoryModelsStore, type Model } from "@diffexai/diffex-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const staleModel: Model<"diffex-messages"> = {
	id: "auto",
	name: "Radius Auto",
	api: "diffex-messages",
	provider: "radius",
	baseUrl: "https://radius.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};
let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "diffex-radius-removal-"));
	vi.stubEnv("RADIUS_API_KEY", "unused-radius-key");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Unexpected provider request");
		}),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("removed Radius integration", () => {
	it.each([
		{ type: "api_key", key: "stored-key" },
		{ type: "oauth", access: "access", refresh: "refresh", expires: Number.MAX_SAFE_INTEGER },
		{
			type: "oauth",
			access: "expired",
			refresh: "refresh",
			expires: 0,
			gatewayConfig: { baseUrl: staleModel.baseUrl, models: [staleModel] },
		},
	] satisfies Credential[])(
		"does not reactivate Radius from saved credentials or cached models: %j",
		async (credential) => {
			const credentials = AuthStorage.inMemory({ radius: credential });
			const modelsStore = new InMemoryModelsStore();
			await modelsStore.write("radius", { models: [staleModel] });
			const runtime = await ModelRuntime.create({
				credentials,
				modelsStore,
				modelsPath: null,
				allowModelNetwork: false,
			});
			expect(runtime.getProviders().some((provider) => provider.id === "radius")).toBe(false);
			expect(runtime.getProvider("radius")).toBeUndefined();
			expect(runtime.getModels("radius")).toEqual([]);
			expect(runtime.hasConfiguredAuth("radius")).toBe(false);
			expect(runtime.isUsingOAuth("radius")).toBe(false);
			await expect(runtime.getAuth("radius")).resolves.toBeUndefined();
			await expect(runtime.checkAuth("radius")).resolves.toBeUndefined();
			await expect(runtime.getAvailable("radius")).resolves.toEqual([]);
			await runtime.refresh({ providers: ["radius"], allowNetwork: true });
			const result = await runtime.completeSimple(staleModel, { messages: [] });
			expect(result).toMatchObject({ stopReason: "error", errorMessage: "Unknown provider: radius" });
			expect(fetch).not.toHaveBeenCalled();
			await expect(credentials.read("radius")).resolves.toEqual(credential);
		},
	);

	it.each(["oauth", "api_key"] as const)(
		"rejects direct Radius %s login before prompting or making requests",
		async (type) => {
			const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
			const prompt = vi.fn(async () => {
				throw new Error("Unexpected prompt");
			});
			const notify = vi.fn();
			await expect(
				runtime.login("radius", type, { signal: new AbortController().signal, prompt, notify }),
			).rejects.toThrow("Unknown provider: radius");
			expect(prompt).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["radius", "radius-dev"])(
		"rejects the Radius models.json OAuth configuration under %s",
		async (providerId) => {
			const modelsPath = join(tempDir, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						[providerId]: {
							oauth: "radius",
							baseUrl: "https://radius.example",
							apiKey: "stored-key",
							api: "diffex-messages",
							models: [{ id: "auto" }],
						},
					},
				}),
			);
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath,
				modelsStore: new InMemoryModelsStore(),
			});
			expect(runtime.getError()).toContain("oauth");
			expect(runtime.getProvider(providerId)).toBeUndefined();
			await runtime.refresh({ providers: [providerId], allowNetwork: true });
			expect(runtime.getProvider(providerId)).toBeUndefined();
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
