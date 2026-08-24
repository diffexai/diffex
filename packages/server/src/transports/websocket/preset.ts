import { DiffexServer } from "../../server.ts";
import type { DiffexServerService } from "../../types.ts";
import { createWebSocketListener } from "./listener.ts";
import type { WebSocketServerOptions } from "./types.ts";

export function createWebSocketServer(service: DiffexServerService, options: WebSocketServerOptions): DiffexServer {
	const listener = createWebSocketListener(options);
	return new DiffexServer(service, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
	});
}
