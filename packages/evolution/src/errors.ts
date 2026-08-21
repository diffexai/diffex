import type { EvolutionFailureReasonCode, JsonValue } from "./contracts.ts";

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
