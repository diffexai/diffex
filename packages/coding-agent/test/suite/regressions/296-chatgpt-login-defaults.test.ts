import type { Api, Model } from "@diffexai/diffex-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const CHATGPT = "openai-codex";
const OLD_DEFAULT = "gpt-5.5";
const NEW_DEFAULT = "gpt-5.6-terra";

// Exercise login completion with a synthetic account catalog and the faux provider only.
describe("regression #296: ChatGPT login defaults", () => {
	let harness: Harness;
	let catalog: Model<Api>[];
	let unavailable: Set<string>;

	beforeEach(async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
		harness = await createHarness();
		catalog = [];
		unavailable = new Set();
		const runtime = harness.session.modelRuntime;
		const fauxProvider = runtime.getProvider(harness.getModel().provider);
		if (!fauxProvider) throw new Error("Faux provider is unavailable");
		runtime.registerNativeProvider({
			...fauxProvider,
			id: CHATGPT,
			name: "ChatGPT fixture",
			getModels: () => catalog,
			filterModels: (models) => models.filter((model) => !unavailable.has(model.id)),
		});
	});

	afterEach(async () => {
		try {
			await harness?.cleanup();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	async function setCatalog(ids: string[], unavailableIds: string[] = []): Promise<void> {
		catalog = ids.map((id) => ({ ...harness.getModel(), provider: CHATGPT, id, name: id }));
		unavailable = new Set(unavailableIds);
		await harness.session.modelRuntime.refresh({ allowNetwork: false });
	}

	async function completeLogin(
		previousModel: Model<Api> | undefined,
		authType: "oauth" | "api_key" = "oauth",
		providerId = CHATGPT,
	) {
		const runtime = harness.session.modelRuntime;
		const refresh = vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const setModel = vi.spyOn(harness.session, "setModel");
		const context = {
			session: harness.session,
			updateAvailableProviderCount: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const complete = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
			this: object,
			providerId: string,
			providerName: string,
			authType: "oauth" | "api_key",
			previousModel: Model<Api> | undefined,
		) => Promise<void>;

		await complete.call(context, providerId, "ChatGPT fixture", authType, previousModel);
		expect(refresh).toHaveBeenCalledExactlyOnceWith({ providers: [providerId], signal: expect.any(AbortSignal) });
		return { ...context, setModel };
	}

	it.each(["oauth", "api_key"] as const)(
		"selects the current default on first %s login without a model",
		async (authType) => {
			await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);

			const context = await completeLogin(undefined, authType);

			expect(harness.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
			expect(context.setModel).toHaveBeenCalledExactlyOnceWith(catalog[1]);
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	it("replaces the unknown placeholder on login", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);
		const unknownModel = { ...harness.getModel(), provider: "unknown", id: "unknown", api: "unknown" };
		harness.session.agent.state.model = unknownModel;

		const context = await completeLogin(unknownModel);

		expect(harness.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("preserves an available current and saved model instead of upgrading it", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);
		const previousModel = catalog[0]!;
		await harness.session.setModel(previousModel);

		const context = await completeLogin(previousModel);

		expect(context.setModel).not.toHaveBeenCalled();
		expect(harness.session.model).toBe(previousModel);
		expect(harness.settingsManager.getDefaultModel()).toBe(OLD_DEFAULT);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("preserves an available model from another provider", async () => {
		await setCatalog([NEW_DEFAULT]);
		const previousModel = harness.getModel();
		await harness.session.setModel(previousModel);

		const context = await completeLogin(previousModel);

		expect(context.setModel).not.toHaveBeenCalled();
		expect(harness.session.model).toBe(previousModel);
		expect(harness.settingsManager.getDefaultProvider()).toBe(previousModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe(previousModel.id);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it.each(["ChatGPT login", "custom provider reauthentication"])(
		"preserves an uncatalogued custom model during %s",
		async (login) => {
			await setCatalog([NEW_DEFAULT]);
			const previousModel = { ...harness.getModel(), id: "uncatalogued-custom-model" };
			await harness.session.setModel(previousModel);
			expect(harness.session.modelRuntime.getModel(previousModel.provider, previousModel.id)).toBeUndefined();
			expect(harness.session.modelRuntime.getAvailableSnapshot()).not.toContainEqual(previousModel);
			const providerId = login === "ChatGPT login" ? CHATGPT : previousModel.provider;

			const context = await completeLogin(previousModel, "api_key", providerId);

			expect(context.setModel).not.toHaveBeenCalled();
			expect(harness.session.model).toBe(previousModel);
			expect(harness.settingsManager.getDefaultProvider()).toBe(previousModel.provider);
			expect(harness.settingsManager.getDefaultModel()).toBe(previousModel.id);
			expect(context.showError).not.toHaveBeenCalled();
		},
	);

	it("replaces a known current model excluded by the newly active account", async () => {
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT]);
		const previousModel = catalog[0]!;
		await harness.session.setModel(previousModel);
		await setCatalog([OLD_DEFAULT, NEW_DEFAULT], [OLD_DEFAULT]);
		expect(harness.session.modelRuntime.getModel(CHATGPT, OLD_DEFAULT)).toBeDefined();
		expect(harness.session.modelRuntime.getAvailableSnapshot()).not.toContainEqual(previousModel);

		const context = await completeLogin(previousModel);

		expect(harness.session.model).toMatchObject({ provider: CHATGPT, id: NEW_DEFAULT });
		expect(context.setModel).toHaveBeenCalledExactlyOnceWith(catalog[1]);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("uses account catalog order when the preferred default is unavailable", async () => {
		await setCatalog([NEW_DEFAULT, "account-first", "account-second"], [NEW_DEFAULT]);

		const context = await completeLogin(undefined);

		expect(harness.session.model).toMatchObject({ provider: CHATGPT, id: "account-first" });
		expect(context.setModel).toHaveBeenCalledExactlyOnceWith(catalog[1]);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("reports an empty account catalog without selecting another provider's model", async () => {
		await setCatalog([NEW_DEFAULT], [NEW_DEFAULT]);

		const context = await completeLogin(undefined);

		expect(context.setModel).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith(
			"Logged in to ChatGPT fixture, but no models are available for that provider. Use /model to select a model.",
		);
	});
});
