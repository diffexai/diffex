export { DiffexClient } from "./client.ts";
export {
	DiffexClientDisposedError,
	DiffexDisconnectedError,
	DiffexServerError,
	DiffexSessionDetachedError,
	DiffexSessionOwnershipError,
} from "./errors.ts";
export type { AcquireSessionOptions, DiffexSessionHandle, SessionLease, SessionLeaseMode } from "./session-handle.ts";
export type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
export type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	DiffexClientOptions,
	ListenerErrorHandler,
	Unsubscribe,
} from "./types.ts";
