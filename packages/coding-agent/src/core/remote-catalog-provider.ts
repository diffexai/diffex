import { type Api, type Model, type ModelsStoreEntry, type Provider, parseModelCatalog } from "@diffexai/diffex-ai";
import { VERSION } from "../config.ts";
import { getDiffexUserAgent } from "../utils/diffex-user-agent.ts";
import { fetchWithRetry } from "../utils/management-http.ts";

const DEFAULT_CATALOG_BASE_URL = "https://api.diffex.ai";
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function remoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
): readonly Model<Api>[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

/** Add a persisted remote catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	if (provider.refreshModels) return provider;
	let dynamicModels: readonly Model<Api>[] = [];
	const catalogUrl = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl).href;
	const provenance = { catalogUrl, catalogClientVersion: VERSION };

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels: async (context) => {
			const stored =
				context.stored?.catalogUrl === catalogUrl && context.stored.catalogClientVersion === VERSION
					? context.stored
					: undefined;
			const restored = remoteModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored?.models.length ? stored.etag : undefined;
			const response = await fetchWithRetry(catalogUrl, {
				headers: {
					accept: "application/json",
					"User-Agent": getDiffexUserAgent(VERSION),
					...(validator ? { "if-none-match": validator } : {}),
				},
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
			});
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304 && stored && validator) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				if (!stored)
					await context.publish({
						persist: {
							...provenance,
							models: [],
							checkedAt,
							lastModified: 0,
							etag: undefined,
						},
					});
				return;
			}
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const refreshed = parseModelCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry = {
				...provenance,
				models: refreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = remoteModels(entry, localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}
