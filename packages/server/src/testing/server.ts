import { DiffexServer } from "../server.ts";
import type { DiffexServerOptions, DiffexServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends DiffexServerOptions {
	service?: DiffexServerService;
}

export interface TestServer {
	server: DiffexServer;
	service: DiffexServerService;
}

/** Create an unstarted DiffexServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new DiffexServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}
