import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Credential, InMemoryModelsStore, type Model } from "@diffexai/diffex-ai";
import { anthropicProvider } from "@diffexai/diffex-ai/providers/anthropic";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkProviderAuth, getProviderCredential } from "../src/cli/auth-check.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	findInitialModel,
	resolveCliModel,
	resolveModelScopeFromModels,
	restoreModelFromSession,
} from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("Radius support has been removed"),
			});
			expect(runtime.getProviderAuthStatus("radius")).toEqual({ configured: false });
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
			).rejects.toThrow("Radius support has been removed");
			expect(prompt).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ providerId: "radius" },
		{ providerId: "Radius" },
		{ providerId: "radius", oauth: "radius" },
		{ providerId: "radius-dev", oauth: "radius" },
	])("rejects Radius models.json configuration: %j", async ({ providerId, ...config }) => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					[providerId]: {
						...config,
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
		expect(runtime.getError()).toContain("Radius support has been removed");
		expect(runtime.getError()).toContain(`providers.${providerId}`);
		expect(runtime.getProvider(providerId)).toBeUndefined();
		await runtime.refresh({ providers: [providerId], allowNetwork: true });
		expect(runtime.getProvider(providerId)).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects extension registrations and runtime keys before mutating state", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		expect(() => runtime.registerProvider("radius", { api: "diffex-messages", baseUrl: staleModel.baseUrl })).toThrow(
			"Radius support has been removed",
		);
		expect(() => runtime.registerNativeProvider({ ...anthropicProvider(), id: "radius" })).toThrow(
			"Radius support has been removed",
		);
		await expect(runtime.setRuntimeApiKey("radius", "unused-key")).rejects.toThrow("Radius support has been removed");
		expect(runtime.getRegisteredProviderIds()).not.toContain("radius");
		expect(runtime.getProviderAuthStatus("radius")).toEqual({ configured: false });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("omits Radius from both login methods and permits local credential cleanup", async () => {
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ radius: { type: "api_key", key: "unused-key" } }),
			modelsPath: null,
		});
		const prototype = InteractiveMode.prototype as unknown as {
			getLoginProviderOptions(this: object, authType: "oauth" | "api_key"): Array<{ id: string }>;
			getLogoutProviderOptions(this: object): Promise<Array<{ id: string }>>;
		};
		const view = { session: { modelRuntime }, diffexAccountAuth: { hasSession: async () => false } };
		for (const type of ["oauth", "api_key"] as const) {
			const options = prototype.getLoginProviderOptions.call(view, type);
			expect(options.length).toBeGreaterThan(0);
			expect(options.some((option) => option.id === "radius")).toBe(false);
		}
		expect(await prototype.getLogoutProviderOptions.call(view)).toMatchObject([{ id: "radius" }]);
		await modelRuntime.logout("radius");
		expect(await modelRuntime.listCredentials()).toEqual([]);
		expect(await prototype.getLogoutProviderOptions.call(view)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects auth checks and credential export without reading old tokens", async () => {
		const credentials = AuthStorage.inMemory({
			radius: { type: "oauth", access: "old-token", refresh: "unused", expires: 0 },
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		await expect(
			checkProviderAuth(
				{ provider: "radius", messages: [], fileArgs: [], diagnostics: [], unknownFlags: new Map() },
				runtime,
			),
		).rejects.toThrow("Radius support has been removed");
		const read = vi.spyOn(credentials, "read");
		await expect(getProviderCredential("radius", runtime, credentials, { refresh: false })).rejects.toThrow(
			"Radius support has been removed",
		);
		expect(read).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("explains removed CLI, default, and restored model selections", async () => {
		const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		for (const selection of [
			{ cliProvider: "radius", cliModel: "auto" },
			{ cliModel: "Radius/auto" },
			{ cliProvider: "radius" },
		]) {
			expect(resolveCliModel({ ...selection, modelRuntime })).toMatchObject({
				model: undefined,
				error: expect.stringContaining("Radius support has been removed"),
			});
		}
		await expect(
			findInitialModel({
				defaultProvider: "radius",
				defaultModelId: "auto",
				scopedModels: [],
				isContinuing: false,
				modelRuntime,
			}),
		).rejects.toThrow("Update defaultProvider and defaultModel in settings.json");
		await expect(restoreModelFromSession("radius", "auto", undefined, false, modelRuntime)).rejects.toThrow(
			"Resume with an explicit --model provider/model",
		);
		expect(() => resolveModelScopeFromModels(["radius/*"], modelRuntime.getModels())).toThrow(
			"Radius support has been removed",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["api_key", "oauth", "cli", "default"])(
		"explains legacy %s configuration through the source CLI",
		(kind) => {
			const repo = fileURLToPath(new URL("../../..", import.meta.url));
			const agentDir = join(tempDir, "agent");
			mkdirSync(agentDir);
			const settings = {
				packages: [],
				...(kind === "default" ? { defaultProvider: "radius", defaultModel: "auto" } : {}),
			};
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
			const authPath = join(agentDir, "auth.json");
			const auth = JSON.stringify({ radius: { type: "api_key", key: "unused-key" } });
			writeFileSync(authPath, auth);
			if (kind === "api_key" || kind === "oauth") {
				writeFileSync(
					join(agentDir, "models.json"),
					JSON.stringify({
						providers: {
							radius: {
								api: "diffex-messages",
								apiKey: "unused-key",
								baseUrl: staleModel.baseUrl,
								models: [{ id: "auto" }],
								...(kind === "oauth" ? { oauth: "radius" } : {}),
							},
						},
					}),
				);
			}
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					join(repo, "node_modules/tsx/dist/loader.mjs"),
					join(repo, "packages/coding-agent/src/cli.ts"),
					"--offline",
					"--no-extensions",
					"--no-skills",
					"--no-context-files",
					"--no-prompt-templates",
					"--no-session",
					...(kind === "cli"
						? ["--model", "radius/auto", "-p", "Do not send"]
						: kind === "default"
							? ["-p", "Do not send"]
							: ["--list-models"]),
				],
				{
					cwd: tempDir,
					env: {
						PATH: process.env.PATH,
						HOME: tempDir,
						DIFFEX_CODING_AGENT_DIR: agentDir,
						DIFFEX_OFFLINE: "1",
						DIFFEX_NO_LOCAL_LLM: "1",
						RADIUS_API_KEY: "unused-key",
						TSX_TSCONFIG_PATH: join(repo, "tsconfig.json"),
					},
					encoding: "utf8",
					timeout: 20000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(kind === "cli" || kind === "default" ? 1 : 0);
			expect(result.stderr).toContain("Radius support has been removed");
			expect(result.stdout).not.toMatch(/^radius\s+auto/m);
			expect(readFileSync(authPath, "utf8")).toBe(auth);
		},
	);
});
