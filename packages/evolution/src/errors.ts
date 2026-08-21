import type { EvolutionFailureReasonCode, JsonValue } from "./contracts.ts";

export type EvolutionToolDenialCode =
	| "document-not-permitted"
	| "evidence-not-permitted"
	| "invalid-range"
	| "invalid-reference"
	| "invalid-request"
	| "registry-revoked"
	| "slice-not-permitted"
	| "tool-budget-exhausted";

export class EvolutionToolDeniedError extends Error {
	readonly code: EvolutionToolDenialCode;
	readonly recoverable: boolean;

	constructor(code: EvolutionToolDenialCode, message: string) {
		super(message);
		this.name = "EvolutionToolDeniedError";
		this.code = code;
		this.recoverable = code !== "registry-revoked" && code !== "tool-budget-exhausted";
	}
}

export class EvolutionExecutionError extends Error {
	readonly reasonCode: EvolutionFailureReasonCode;
	readonly retryable: boolean;
	readonly diagnostics: JsonValue | null;

	constructor(
		message: string,
		options: {
			readonly reasonCode: EvolutionFailureReasonCode;
			readonly retryable: boolean;
			readonly cause?: unknown;
			readonly diagnostics?: JsonValue;
		},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "EvolutionExecutionError";
		this.reasonCode = options.reasonCode;
		this.retryable = options.retryable;
		this.diagnostics = options.diagnostics ?? null;
	}
}
