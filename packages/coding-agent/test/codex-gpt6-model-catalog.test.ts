import { InMemoryModelsStore } from "@diffexai/diffex-ai";
import { describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("Codex GPT-6 model catalog", () => {
	it("lists GPT-6 models for a ChatGPT login", async () => {
		allowNetwork();
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				models: [
					{ slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" },
					{ slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
					{ slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list" },
					{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
				],
			}),
		);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"openai-codex": {
					type: "oauth",
					clientId: "oaiapp_diffex_test",
					subject: "account",
					extAgentHostId: "urn:uuid:host",
					scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
					access: "fixture-token",
					refresh: "fixture-refresh",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
			modelsPath: null,
			modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const output: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line: string) => {
			output.push(line);
		});

		try {
			await modelRuntime.refresh({ providers: ["openai-codex"], allowNetwork: true });
			await listModels(modelRuntime, "gpt-6");
		} finally {
			log.mockRestore();
			fetch.mockRestore();
		}

		const listedIds = output
			.filter((line) => line.startsWith("openai-codex  gpt-6"))
			.map((line) => line.trim().split(/\s+/)[1]);
		expect(listedIds).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]);
	});
});
