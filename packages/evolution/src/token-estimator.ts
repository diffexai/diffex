import type { MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import { serializeEvolutionValue } from "./provenance.ts";

export const EVOLUTION_TOKEN_ESTIMATOR_VERSION = "canonical-json-utf8-v1" as const;
export const AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD = 600_000;
export const AUTOMATIC_EVOLUTION_MINIMUM_INVOCATIONS = 3;
export const AUTOMATIC_EVOLUTION_COOLDOWN_MS = 20 * 60 * 1_000;

const CHARACTERS_PER_ESTIMATED_TOKEN = 4;

export interface EvolutionValueSize {
	readonly serializedBytes: number;
	readonly estimatedTokens: number;
}

export function measureEvolutionValue(value: unknown): EvolutionValueSize {
	const serializedBytes = new TextEncoder().encode(serializeEvolutionValue(value)).byteLength;
	return {
		serializedBytes,
		estimatedTokens: Math.ceil(serializedBytes / CHARACTERS_PER_ESTIMATED_TOKEN),
	};
}

export function estimateEvolutionTokens(invocations: readonly MaterializedInvocation[]): number {
	if (invocations.length === 0) return 0;
	return measureEvolutionValue(invocations).estimatedTokens;
}

export type AutomaticEvolutionEligibilityReason =
	| "cooldown-active"
	| "insufficient-invocations"
	| "insufficient-tokens";

export type AutomaticEvolutionEligibility =
	| { readonly eligible: true }
	| { readonly eligible: false; readonly reason: AutomaticEvolutionEligibilityReason };

export interface AutomaticEvolutionEligibilityInput {
	readonly invocationCount: number;
	readonly estimatedTokens: number;
	readonly now: string;
	readonly previousAutomaticTerminalAt: string | null;
}

export function evaluateAutomaticEvolutionEligibility(
	input: AutomaticEvolutionEligibilityInput,
): AutomaticEvolutionEligibility {
	if (input.invocationCount < AUTOMATIC_EVOLUTION_MINIMUM_INVOCATIONS) {
		return { eligible: false, reason: "insufficient-invocations" };
	}
	if (input.estimatedTokens <= AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD) {
		return { eligible: false, reason: "insufficient-tokens" };
	}
	if (input.previousAutomaticTerminalAt !== null) {
		const terminalAt = Date.parse(input.previousAutomaticTerminalAt);
		const now = Date.parse(input.now);
		if (!Number.isFinite(terminalAt) || !Number.isFinite(now)) {
			throw new Error("Automatic evolution cooldown timestamps must be valid ISO dates");
		}
		if (now - terminalAt < AUTOMATIC_EVOLUTION_COOLDOWN_MS) {
			return { eligible: false, reason: "cooldown-active" };
		}
	}
	return { eligible: true };
}
