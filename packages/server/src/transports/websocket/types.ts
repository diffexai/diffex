import type { IncomingMessage } from "node:http";
import type { DiffexServerOptions } from "../../types.ts";

export interface WebSocketAuthorization {
	authorized: boolean;
}

export interface WebSocketListenerOptions {
	host?: string;
	port: number;
	path?: string;
	authorize(request: IncomingMessage): WebSocketAuthorization | Promise<WebSocketAuthorization>;
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface WebSocketServerOptions extends Omit<DiffexServerOptions, "listeners">, WebSocketListenerOptions {}
