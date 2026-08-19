import { describe, expect, it } from "vitest";
import {
	computeEvolutionContentDigest,
	createEvolutionArtifactMetadata,
	type EvolutionArtifactProducer,
	type EvolutionScope,
} from "../src/index.ts";

const scope: EvolutionScope = { repositoryId: "diffex", scopeId: "repository" };
const producer: EvolutionArtifactProducer = {
	name: "diffex-evolution",
	version: "1.0.0",
	promptVersion: null,
	model: null,
};

describe("evolution artifact contracts", () => {
	it("computes stable content digests independent of object key order", () => {
		const first = computeEvolutionContentDigest({ nested: { second: 2, first: 1 }, value: "same" });
		const second = computeEvolutionContentDigest({ value: "same", nested: { first: 1, second: 2 } });

		expect(first).toBe(second);
		expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("rejects values that cannot be represented by durable JSON", () => {
		expect(() => computeEvolutionContentDigest({ missing: undefined })).toThrow("Cannot digest undefined value");
		expect(() => computeEvolutionContentDigest({ invalid: Number.POSITIVE_INFINITY })).toThrow(
			"Cannot digest non-finite number",
		);
	});

	it("records explicit provenance for deterministic artifacts", () => {
		const metadata = createEvolutionArtifactMetadata({
			artifactId: "artifact-1",
			producer,
			sourceIds: ["evidence-1"],
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
			content: { lesson: "Keep exact source references" },
		});

		expect(metadata).toEqual({
			schemaVersion: 1,
			artifactId: "artifact-1",
			producer,
			sourceIds: ["evidence-1"],
			contentDigest: computeEvolutionContentDigest({ lesson: "Keep exact source references" }),
			scope,
			createdAt: "2026-08-19T12:00:00.000Z",
		});
	});
});
