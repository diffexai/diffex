import { join } from "node:path";
import type { Api, Model } from "@diffexai/diffex-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const CHATGPT = "openai-codex";
const OLD_DEFAULT = "gpt-5.5";
const NEW_DEFAULT = "gpt-5.6-terra";

// The catalog and availability policy are synthetic; all provider behavior comes from the faux harness.
describe("regression #296: ChatGPT model defaults", () => {
	let harness: Harness;
	let catalog: Model<Api>[];
	let unavailable: Set<string>;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		harness = await createHarness({ models: [{ id: "fallback-model", name: "Fallback model" }] });
		catalog = [];
		unavailable = new Set();
		const runtime = harness.session.modelRuntime;
		const fauxModel = harness.getModel();
		const fauxProvider = runtime.getProvider(fauxModel.provider);
		if (!fauxProvider) throw new Error("Faux provider is unavailable");
		runtime.registerNativeProvider({
			...fauxProvider,
			id: CHATGPT,
			name: "ChatGPT fixture",
			getModels: () => catalog,
			filterModels: (models) => models.filter((model) => !unavailable.has(model.id)),
		});
		await runtime.refresh({ allowNetwork: false });
		const getAvailableSnapshot = runtime.getAvailableSnapshot.bind(runtime);
		vi.spyOn(runtime, "getAvailableSnapshot").mockImplementation(() =>
			getAvailableSnapshot().filter((model) => model.provider === CHATGPT || model.provider === fauxModel.provider),
		);
	});

	afterEach(async () => {
		try {
			for (const session of sessions.splice(0)) await session.dispose();
			await harness?.cleanup();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	async function setCatalog(ids: string[], unavailableIds: string[] = []): Promise<void> {
		catalog = ids.map((id) => ({ ...harness.getModel(), id, name: id, provider: CHATGPT }));
		unavailable = new Set(unavailableIds);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
	}

	async function openSession(options: { savedModelId?: string; model?: Model<Api> } = {}) {
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		if (options.savedModelId) {
			sessionManager.appendModelChange(CHATGPT, options.savedModelId);
			sessionManager.appendMessage({ role: "user", content: "Previous conversation", timestamp: 1 });
		}
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			sessionManager,
			model: options.model,
			subagents: false,
			noTools: "all",
		});
		sessions.push(result.session);
		return result;
	}

	it("uses the current default for startup when both old and new models are available", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);

		const result = await openSession();

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("keeps an available saved default instead of upgrading it", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);
		harness.settingsManager.setDefaultModelAndProvider(CHATGPT, OLD_DEFAULT);

		const result = await openSession();

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: OLD_DEFAULT });
		expect(result.modelFallbackMessage).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBe(OLD_DEFAULT);
	});

	it("replaces an unavailable saved default within ChatGPT and exposes the startup warning", async () => {
		await setCatalog(["account-first", NEW_DEFAULT]);
		harness.settingsManager.setDefaultModelAndProvider(CHATGPT, OLD_DEFAULT);

		const result = await openSession();

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
		expect(result.modelFallbackMessage).toContain(`Saved default model ${CHATGPT}/${OLD_DEFAULT}`);
		expect(result.modelFallbackMessage).toContain(`Using ${CHATGPT}/${NEW_DEFAULT}`);
		expect(harness.settingsManager.getDefaultProvider()).toBe(CHATGPT);
		expect(harness.settingsManager.getDefaultModel()).toBe(OLD_DEFAULT);
	});

	it.each([
		{ ids: [OLD_DEFAULT], selected: OLD_DEFAULT },
		{ ids: ["account-first", "account-second"], selected: "account-first" },
	])("uses account catalog order when the hardcoded default is missing: $ids", async ({ ids, selected }) => {
		await setCatalog(ids);
		harness.settingsManager.setDefaultModelAndProvider(CHATGPT, "removed-model");

		const result = await openSession();

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: selected });
		expect(result.modelFallbackMessage).toContain(`Using ${CHATGPT}/${selected}`);
		expect(harness.settingsManager.getDefaultModel()).toBe("removed-model");
	});

	it("restores an available session model instead of upgrading it or taking the saved default", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);
		harness.settingsManager.setDefaultModelAndProvider(CHATGPT, NEW_DEFAULT);

		const result = await openSession({ savedModelId: OLD_DEFAULT });

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: OLD_DEFAULT });
		expect(result.modelFallbackMessage).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBe(NEW_DEFAULT);
	});

	it("keeps a missing session model on ChatGPT before considering another saved provider", async () => {
		await setCatalog(["account-first", NEW_DEFAULT]);
		const fallback = harness.getModel();
		harness.settingsManager.setDefaultModelAndProvider(fallback.provider, fallback.id);

		const result = await openSession({ savedModelId: OLD_DEFAULT });

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
		expect(result.modelFallbackMessage).toContain(`Could not restore model ${CHATGPT}/${OLD_DEFAULT}`);
		expect(result.modelFallbackMessage).toContain(`Using ${CHATGPT}/${NEW_DEFAULT}`);
		expect(harness.settingsManager.getDefaultProvider()).toBe(fallback.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe(fallback.id);
	});

	it("does not restore a known model excluded by the active account's availability policy", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT], [OLD_DEFAULT]);
		expect(harness.session.modelRuntime.getModel(CHATGPT, OLD_DEFAULT)).toBeDefined();
		expect(harness.session.modelRuntime.hasConfiguredAuth(CHATGPT)).toBe(true);

		const result = await openSession({ savedModelId: OLD_DEFAULT });

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
		expect(result.modelFallbackMessage).toContain(`Using ${CHATGPT}/${NEW_DEFAULT}`);
	});

	it("restores using account catalog order when neither old nor current defaults are available", async () => {
		await setCatalog(["account-first", "account-second"]);

		const result = await openSession({ savedModelId: OLD_DEFAULT });

		expect(result.session.model).toMatchObject({ provider: CHATGPT, id: "account-first" });
		expect(result.modelFallbackMessage).toContain(`Using ${CHATGPT}/account-first`);
	});

	it("retains settings fallback and the restore warning when ChatGPT has no available models", async () => {
		await setCatalog([OLD_DEFAULT], [OLD_DEFAULT]);
		const fallback = harness.getModel();
		harness.settingsManager.setDefaultModelAndProvider(fallback.provider, fallback.id);

		const result = await openSession({ savedModelId: OLD_DEFAULT });

		expect(result.session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });
		expect(result.modelFallbackMessage).toContain(`Could not restore model ${CHATGPT}/${OLD_DEFAULT}`);
		expect(result.modelFallbackMessage).toContain(`Using ${fallback.provider}/${fallback.id}`);
	});

	it("retains the unknown placeholder and actionable guidance when no provider has available models", async () => {
		await setCatalog([]);
		vi.mocked(harness.session.modelRuntime.getAvailableSnapshot).mockReturnValue([]);
		harness.settingsManager.setDefaultModelAndProvider(CHATGPT, OLD_DEFAULT);

		const result = await openSession({ savedModelId: OLD_DEFAULT });

		expect(result.session.model).toMatchObject({ provider: "unknown", id: "unknown", api: "unknown" });
		expect(result.modelFallbackMessage).toContain("No models available");
		expect(result.modelFallbackMessage).toContain("/login");
		expect(harness.settingsManager.getDefaultModel()).toBe(OLD_DEFAULT);
	});

	it("preserves an explicitly supplied model over session restoration", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);
		const explicitModel = harness.getModel();

		const result = await openSession({ savedModelId: OLD_DEFAULT, model: explicitModel });

		expect(result.session.model).toMatchObject({ provider: explicitModel.provider, id: explicitModel.id });
		expect(result.modelFallbackMessage).toBeUndefined();
	});
});
