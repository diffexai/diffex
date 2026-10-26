import type { Api, Model } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateModelValue(
	value: unknown,
	providerId: string,
	modelId: string,
	expectedApi: string,
	errors: string[],
): void {
	const label = `${providerId}/${modelId}`;
	if (!isRecord(value)) {
		errors.push(`${label} must be an object`);
		return;
	}
	if (value.id !== modelId)
		errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
	if (value.provider !== providerId) {
		errors.push(`${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(providerId)}`);
	}
	if (typeof value.api !== "string" || value.api.length === 0) errors.push(`${label} has no api string`);
	if (value.api !== expectedApi) {
		errors.push(`${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`);
	}
	if (typeof value.name !== "string" || value.name.length === 0) errors.push(`${label} has no model name`);
	if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
	if (typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
	if (
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		value.input.some((entry) => entry !== "text" && entry !== "image")
	) {
		errors.push(`${label} has invalid input modalities`);
	}
	if (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow) || value.contextWindow <= 0) {
		errors.push(`${label} has invalid contextWindow`);
	}
	if (typeof value.maxTokens !== "number" || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0) {
		errors.push(`${label} has invalid maxTokens`);
	}
	if (!isRecord(value.cost)) {
		errors.push(`${label} has invalid cost metadata`);
	} else {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const cost = value.cost[field];
			if (typeof cost !== "number" || !Number.isFinite(cost)) {
				errors.push(`${label} has invalid cost.${field}`);
			}
		}
	}
}

/** Validate a complete provider shard before accepting any model metadata. */
export function parseModelCatalog(providerId: string, value: unknown): Model<Api>[] {
	if (!isRecord(value) || Object.keys(value).length === 0) {
		throw new Error(`Invalid model catalog for provider "${providerId}"`);
	}
	const errors: string[] = [];
	for (const [id, model] of Object.entries(value)) {
		validateModelValue(
			model,
			providerId,
			id,
			isRecord(model) && typeof model.api === "string" ? model.api : "",
			errors,
		);
	}
	if (errors.length) throw new Error(`Invalid model catalog: ${errors.slice(0, 30).join("; ")}`);
	return Object.values(value) as Model<Api>[];
}
