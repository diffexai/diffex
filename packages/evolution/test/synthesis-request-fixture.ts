import type { SkillSynthesisRequestDiagnostics } from "../src/index.ts";

export const synthesisRequestFixture = {
	serialization: "canonical-json-utf8-v1",
	serializedBytes: 1,
	estimatedTokens: 1,
	inputSerializedBytes: 1,
	inputEstimatedTokens: 1,
	contextWindow: 128_000,
	maxOutputTokens: 16_384,
	schemaEstimatedTokens: 1,
	protocolOverheadTokens: 1_024,
	safetyMarginTokens: 8_960,
	inputBudgetTokens: 100_000,
	schemaDigest: `sha256:${"1".repeat(64)}`,
	capsuleDigest: `sha256:${"2".repeat(64)}`,
	requestDigest: `sha256:${"3".repeat(64)}`,
} satisfies SkillSynthesisRequestDiagnostics;
