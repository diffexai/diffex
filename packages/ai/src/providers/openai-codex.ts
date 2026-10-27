import { lazyStream } from "../api/lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import type { Credential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { OPENAI_MODELS } from "./openai.models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

const BASE_URL = "https://api.openai.com/v1";
const CATALOG_URL = `${BASE_URL}/models`;

function credentialId(credential: Credential | undefined): string | undefined {
	return credential?.type === "oauth" &&
		credential.access &&
		!credential.reauthorizationRequired &&
		Array.isArray(credential.scopes) &&
		credential.scopes.includes("chatgpt.tokens.use.direct") &&
		credential.scopes.includes("resource.invoke") &&
		typeof credential.clientId === "string" &&
		typeof credential.subject === "string"
		? JSON.stringify([credential.clientId, credential.subject])
		: undefined;
}

function parseCatalog(value: unknown): Model<"openai-responses">[] {
	if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) {
		throw new Error("Invalid ChatGPT model catalog");
	}
	const models: Model<"openai-responses">[] = [];
	const ids = new Set<string>();
	for (const entry of value.models as unknown[]) {
		if (!entry || typeof entry !== "object") throw new Error("Invalid ChatGPT model entry");
		const item = entry as Record<string, unknown>;
		if (item.visibility !== "list") continue;
		if (
			typeof item.slug !== "string" ||
			!item.slug ||
			typeof item.display_name !== "string" ||
			!item.display_name ||
			ids.has(item.slug)
		) {
			throw new Error("Invalid or duplicate ChatGPT model identity");
		}
		ids.add(item.slug);
		const known = [...Object.values(OPENAI_MODELS), ...Object.values(OPENAI_CODEX_MODELS)].find(
			(model) => model.id === item.slug,
		);
		const contextWindow =
			typeof item.context_window === "number" && Number.isSafeInteger(item.context_window) && item.context_window > 0
				? item.context_window
				: (known?.contextWindow ?? 128_000);
		const maxTokens =
			typeof item.max_output_tokens === "number" &&
			Number.isSafeInteger(item.max_output_tokens) &&
			item.max_output_tokens > 0
				? item.max_output_tokens
				: (known?.maxTokens ?? 16_384);
		models.push({
			...known,
			id: item.slug,
			name: item.display_name,
			api: "openai-responses",
			provider: "openai-codex",
			baseUrl: BASE_URL,
			reasoning: known?.reasoning ?? false,
			input: known?.input ?? ["text"],
			contextWindow,
			maxTokens: Math.min(maxTokens, contextWindow),
			// ChatGPT plan usage is not billed at API-key token prices.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return models;
}

export function openaiCodexProvider(): Provider<"openai-responses"> {
	let catalog: readonly Model<"openai-responses">[] = [];
	let catalogOwner: string | undefined;
	let activeOwner: string | undefined;
	let session = new AbortController();
	const oauth = lazyOAuth({
		name: "ChatGPT",
		isSubscription: true,
		loginLabel: "Continue with ChatGPT",
		load: loadOpenAICodexOAuth,
	});
	const api = openAIResponsesApi();
	const activate = (owner: string | undefined) => {
		if (activeOwner === owner) return;
		session.abort();
		session = new AbortController();
		activeOwner = owner;
		if (catalogOwner !== owner) {
			catalog = [];
			catalogOwner = undefined;
		}
	};
	const streamWith = (
		model: Model<"openai-responses">,
		context: Parameters<typeof api.stream>[1],
		options: StreamOptions | SimpleStreamOptions | undefined,
		simple: boolean,
	) => {
		const signal = options?.signal ? AbortSignal.any([options.signal, session.signal]) : session.signal;
		return lazyStream(
			model,
			async () => {
				signal.throwIfAborted();
				if (!activeOwner || catalogOwner !== activeOwner || !catalog.some((entry) => entry.id === model.id)) {
					throw new Error(
						"Model is unavailable for the active ChatGPT account. Refresh models and select an available model.",
					);
				}
				const requestModel = { ...model, api: "openai-responses" as const, baseUrl: BASE_URL };
				const requestOptions = { ...options, signal };
				return simple
					? api.streamSimple(requestModel, context, requestOptions)
					: api.stream(requestModel, context, requestOptions);
			},
			signal,
		);
	};
	const provider = createProvider<"openai-responses">({
		id: "openai-codex",
		name: "ChatGPT",
		baseUrl: BASE_URL,
		auth: {
			oauth: {
				...oauth,
				toAuth: async (credential) => {
					const auth = await oauth.toAuth(credential);
					activate(credentialId(credential));
					return auth;
				},
				logout: async (credential, signal) => {
					activate(undefined);
					await oauth.logout?.(credential, signal);
				},
			},
		},
		models: [],
		filterModels: (models, credential) =>
			credentialId(credential) === catalogOwner
				? models.filter((model) => catalog.some((entry) => entry.id === model.id))
				: [],
		api: {
			stream: (model, context, options) => streamWith(model as Model<"openai-responses">, context, options, false),
			streamSimple: (model, context, options) =>
				streamWith(model as Model<"openai-responses">, context, options, true),
		},
	});
	return {
		...provider,
		getModels: () => catalog,
		refreshModels: async (context) => {
			const owner = credentialId(context.credential);
			const stored =
				context.stored?.catalogUrl === CATALOG_URL && context.stored.credentialId === owner && owner
					? context.stored
					: undefined;
			if (
				!(await context.publish({
					update: () => {
						activate(owner);
						if (stored) {
							catalog = stored.models.filter(
								(model): model is Model<"openai-responses"> =>
									model.provider === "openai-codex" &&
									model.api === "openai-responses" &&
									model.baseUrl === BASE_URL,
							);
							catalogOwner = owner;
						}
					},
				}))
			)
				return;
			if (!context.allowNetwork || !owner || context.credential?.type !== "oauth") return;
			await oauth.toAuth(context.credential);
			const response = await fetch(CATALOG_URL, {
				headers: { Authorization: `Bearer ${context.credential.access}`, Accept: "application/json" },
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]),
			});
			if (!response.ok) throw new Error(`ChatGPT model catalog request failed (${response.status})`);
			const models = parseCatalog(await response.json());
			await context.publish({
				persist: { models, catalogUrl: CATALOG_URL, credentialId: owner, checkedAt: Date.now() },
				update: () => {
					catalog = models;
					catalogOwner = owner;
				},
			});
		},
	};
}
