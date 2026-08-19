import { createHash } from "node:crypto";
import type { EvolutionArtifactMetadata, EvolutionArtifactProducer, EvolutionScope, JsonValue } from "./contracts.ts";
import { EVOLUTION_SCHEMA_VERSION } from "./contracts.ts";

const CONTENT_DIGEST_PREFIX = "sha256:";

function canonicalize(value: unknown, path: string): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Cannot digest non-finite number at ${path}`);
		return value;
	}
	if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
	if (typeof value === "object") {
		const record = value as Readonly<Record<string, unknown>>;
		const result: Record<string, JsonValue> = {};
		for (const key of Object.keys(record).sort()) {
			const child = record[key];
			if (child === undefined) throw new Error(`Cannot digest undefined value at ${path}.${key}`);
			result[key] = canonicalize(child, `${path}.${key}`);
		}
		return result;
	}
	throw new Error(`Cannot digest ${typeof value} value at ${path}`);
}

export function computeEvolutionContentDigest(value: unknown): string {
	const canonical = serializeEvolutionValue(value);
	return `${CONTENT_DIGEST_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

export function serializeEvolutionValue(value: unknown): string {
	return JSON.stringify(canonicalize(value, "$"));
}

export interface CreateEvolutionArtifactMetadataOptions {
	readonly artifactId: string;
	readonly producer: EvolutionArtifactProducer;
	readonly sourceIds: readonly string[];
	readonly scope: EvolutionScope;
	readonly createdAt: string;
	readonly content: unknown;
}

export function createEvolutionArtifactMetadata(
	options: CreateEvolutionArtifactMetadataOptions,
): EvolutionArtifactMetadata {
	return {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		artifactId: options.artifactId,
		producer: options.producer,
		sourceIds: [...options.sourceIds],
		contentDigest: computeEvolutionContentDigest(options.content),
		scope: options.scope,
		createdAt: options.createdAt,
	};
}
