import type { EvolutionFailureReasonCode } from "./contracts.ts";

export class EvolutionExecutionError extends Error {
	readonly reasonCode: EvolutionFailureReasonCode;
	readonly retryable: boolean;

	constructor(
		message: string,
		options: {
			readonly reasonCode: EvolutionFailureReasonCode;
			readonly retryable: boolean;
			readonly cause?: unknown;
		},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "EvolutionExecutionError";
		this.reasonCode = options.reasonCode;
		this.retryable = options.retryable;
	}
}
