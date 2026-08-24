import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/diffex-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

type WebSocketData = ArrayBuffer | ArrayBufferView;

interface WebSocketMessageEvent {
	readonly data: unknown;
}

interface WebSocketCloseEvent {
	readonly code: number;
	readonly reason: string;
}

interface WebSocketErrorEvent {
	readonly error?: unknown;
}

interface WebSocketLike {
	binaryType: string;
	readonly bufferedAmount: number;
	readonly readyState: number;
	send(data: WebSocketData): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
	addEventListener(type: "message", listener: (event: WebSocketMessageEvent) => void): void;
	addEventListener(type: "close", listener: (event: WebSocketCloseEvent) => void, options?: { once?: boolean }): void;
	addEventListener(type: "error", listener: (event: WebSocketErrorEvent) => void, options?: { once?: boolean }): void;
}

export interface WebSocketConstructor {
	new (url: string | URL, protocols?: string | string[]): WebSocketLike;
	readonly OPEN: number;
}

export interface WebSocketTransportOptions {
	url: string | URL | (() => string | URL | Promise<string | URL>);
	protocols?: string | string[];
	maxPendingBytes?: number;
	webSocket?: WebSocketConstructor;
}

/** Creates authenticated browser-compatible WebSocket transports for DiffexClient connection attempts. */
export function createWebSocketTransportFactory(options: WebSocketTransportOptions): ByteTransportFactory {
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("WebSocket transport maxPendingBytes must be a positive safe integer");
	}

	return async (handlers) => {
		const url = typeof options.url === "function" ? await options.url() : options.url;
		const WebSocketImpl = options.webSocket ?? resolveGlobalWebSocket();
		return connectWebSocket(WebSocketImpl, url, options.protocols, maxPendingBytes, handlers);
	};
}

function resolveGlobalWebSocket(): WebSocketConstructor {
	const candidate = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
	if (!candidate) throw new Error("WebSocket is not available in this runtime");
	return candidate;
}

function connectWebSocket(
	WebSocketImpl: WebSocketConstructor,
	url: string | URL,
	protocols: string | string[] | undefined,
	maxPendingBytes: number,
	handlers: ByteTransportHandlers,
): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		const socket = protocols === undefined ? new WebSocketImpl(url) : new WebSocketImpl(url, protocols);
		socket.binaryType = "arraybuffer";
		let connected = false;
		let terminal = false;

		socket.addEventListener(
			"open",
			() => {
				if (terminal) return;
				connected = true;
				resolve(
					new WebSocketByteTransport(socket, WebSocketImpl.OPEN, maxPendingBytes, () => {
						terminal = true;
					}),
				);
			},
			{ once: true },
		);
		socket.addEventListener("message", (event) => {
			if (terminal) return;
			const bytes = binaryMessage(event.data);
			if (!bytes) {
				terminal = true;
				socket.close(1003, "Binary protocol frames required");
				handlers.onError(new Error("WebSocket transport received a non-binary message"));
				return;
			}
			handlers.onData(bytes);
		});
		socket.addEventListener(
			"close",
			(event) => {
				if (terminal) return;
				terminal = true;
				if (connected) handlers.onClose();
				else reject(new Error(`WebSocket transport closed before connecting (${event.code}: ${event.reason})`));
			},
			{ once: true },
		);
		socket.addEventListener(
			"error",
			(event) => {
				if (terminal) return;
				terminal = true;
				const error = event.error instanceof Error ? event.error : new Error("WebSocket transport failed");
				socket.close();
				if (connected) handlers.onError(error);
				else reject(error);
			},
			{ once: true },
		);
	});
}

function binaryMessage(data: unknown): Uint8Array | undefined {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return undefined;
}

class WebSocketByteTransport implements ByteTransport {
	readonly #socket: WebSocketLike;
	readonly #openState: number;
	readonly #maxPendingBytes: number;
	readonly #markLocalClose: () => void;
	#closed = false;
	#pendingBytes = 0;
	#sendTail: Promise<void> = Promise.resolve();

	constructor(socket: WebSocketLike, openState: number, maxPendingBytes: number, markLocalClose: () => void) {
		this.#socket = socket;
		this.#openState = openState;
		this.#maxPendingBytes = maxPendingBytes;
		this.#markLocalClose = markLocalClose;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket transport chunks must be Uint8Array"));
		}
		if (this.#closed || this.#socket.readyState !== this.#openState) {
			return Promise.reject(new Error("WebSocket transport is closed"));
		}
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("WebSocket transport exceeded its pending byte limit"));
		}

		const bytes = chunk.slice();
		this.#pendingBytes += bytes.byteLength;
		const send = this.#sendTail.then(() => {
			if (this.#closed || this.#socket.readyState !== this.#openState) {
				throw new Error("WebSocket transport is closed");
			}
			this.#socket.send(bytes);
			if (this.#socket.bufferedAmount > this.#maxPendingBytes) {
				this.close();
				throw new Error("WebSocket transport exceeded its buffered byte limit");
			}
		});
		const tracked = send.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#sendTail = tracked.catch(() => {});
		return tracked;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markLocalClose();
		this.#socket.close(1000, "Client closed");
	}
}
