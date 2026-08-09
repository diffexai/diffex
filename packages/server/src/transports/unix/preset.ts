import { DiffexServer } from "../../server.ts";
import type { DiffexServerService } from "../../types.ts";
import { createUnixListener } from "./listener.ts";
import type { UnixServerOptions } from "./types.ts";

/** Compose DiffexServer with one Unix-domain socket listener. */
export function createUnixServer(service: DiffexServerService, options: UnixServerOptions): DiffexServer {
	const listener = createUnixListener({
		path: options.path,
		mode: options.mode,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new DiffexServer(service, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
	});
}
