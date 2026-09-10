import type { JsonValue, ProtocolError, ProtocolErrorCode } from "@diffexai/diffex-protocol";

export class DiffexServerError extends Error {
	readonly code: ProtocolErrorCode;
	readonly details: JsonValue | undefined;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "DiffexServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

export class DiffexDisconnectedError extends Error {
	constructor(message = "Diffex client is disconnected") {
		super(message);
		this.name = "DiffexDisconnectedError";
	}
}

export class DiffexClientDisposedError extends Error {
	constructor() {
		super("Diffex client is disposed");
		this.name = "DiffexClientDisposedError";
	}
}

export class DiffexSessionOwnershipError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "DiffexSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

export class DiffexSessionDetachedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "DiffexSessionDetachedError";
		this.sessionId = sessionId;
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): DiffexDisconnectedError {
	const cause = toError(error);
	return cause instanceof DiffexDisconnectedError ? cause : new DiffexDisconnectedError(cause.message);
}
