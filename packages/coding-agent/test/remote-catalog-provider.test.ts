import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type ModelsStore,
	type Provider,
	type RefreshModelsContext,
} from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { FileModelsStore } from "../src/core/models-store.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		"https://api.diffex.ai",
		localGeneratedAt,
	);
}

async function refreshProvider(
	provider: Provider,
	store: ModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it("preserves a provider's account-specific discovery policy", () => {
		const provider = createProvider({
			id: "account-catalog",
			models: [],
			api: {},
			auth: { apiKey: { name: "Test", resolve: async () => undefined } },
			fetchModels: async () => [],
		});
		expect(withRemoteCatalog(provider)).toBe(provider);
	});
	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`diffex/${VERSION}`),
		});
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("preserves a valid matching cache when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBe('"catalog-1"');
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
	});

	it("treats incompatible catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});

	it.each([
		{},
		{ catalogUrl: "https://old.example/api/models/providers/test-provider", catalogClientVersion: VERSION },
		{ catalogUrl: "https://api.diffex.ai/api/models/providers/test-provider", catalogClientVersion: "0.0.1" },
	])("ignores foreign cache models, validators and timers: %j", async (provenance) => {
		const store = new InMemoryModelsStore();
		await store.write("test-provider", {
			models: [model("foreign")],
			checkedAt: Date.now(),
			lastModified: Date.now(),
			etag: '"foreign"',
			...provenance,
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ fresh: model("fresh") }));
		const provider = testProvider();
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(fetchSpy).not.toHaveBeenCalled();
		await refreshProvider(provider, store);
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);
		expect(await store.read(provider.id)).toMatchObject({
			catalogUrl: "https://api.diffex.ai/api/models/providers/test-provider",
			catalogClientVersion: VERSION,
		});
	});

	it.each(["json", "fields", "provider", "key", "network", "timeout", "cancel", "http"])(
		"preserves the matching cache after %s failure",
		async (failure) => {
			const store = new InMemoryModelsStore();
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(Response.json({ valid: model("valid") }, { headers: { etag: '"valid"' } }));
			const provider = testProvider();
			await refreshProvider(provider, store);
			const before = await store.read(provider.id);
			const controller = new AbortController();
			fetchSpy.mockImplementation(async () => {
				if (failure === "network") throw new TypeError("network unavailable");
				if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
				if (failure === "cancel") controller.abort();
				if (failure === "http") return new Response(null, { status: 503 });
				if (failure === "json") return new Response("{broken");
				return Response.json({
					invalid: {
						...model(failure === "key" ? "wrong" : "invalid"),
						...(failure === "fields" ? { contextWindow: -1 } : {}),
						...(failure === "provider" ? { provider: "other" } : {}),
					},
				});
			});
			const refresh = refreshProvider(provider, store, { force: true, signal: controller.signal });
			if (failure === "cancel") await refresh;
			else await expect(refresh).rejects.toThrow();
			expect(await store.read(provider.id)).toEqual(before);
			expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "valid"]);
		},
	);

	it("persists provenance across restart and restores matching models offline", async () => {
		const root = mkdtempSync(join(tmpdir(), "diffex-catalog-restart-"));
		try {
			const path = join(root, "models-store.json");
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(Response.json({ dynamic: model("dynamic") }, { headers: { etag: '"valid"' } }));
			await refreshProvider(testProvider(), new FileModelsStore(path));
			const restarted = testProvider();
			const store = new FileModelsStore(path);
			await refreshProvider(restarted, store, { allowNetwork: false });
			await refreshProvider(restarted, store);
			expect(fetchSpy).toHaveBeenCalledOnce();
			expect(restarted.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
			const entry = await store.read(restarted.id);
			if (!entry) throw new Error("Missing persisted cache");
			await store.write(restarted.id, { ...entry, checkedAt: Date.now() - 4 * 60 * 60 * 1000 });
			fetchSpy.mockResolvedValue(new Response(null, { status: 304 }));
			await refreshProvider(restarted, store);
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
