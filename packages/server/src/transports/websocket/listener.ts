import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { DEFAULT_MAX_FRAME_LENGTH } from "@diffexai/diffex-protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { DiffexServerListener } from "../../listener.ts";
import type { WebSocketListenerOptions } from "./types.ts";

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;

class DiffexWebSocketListener implements DiffexServerListener {
	readonly #options: Required<Pick<WebSocketListenerOptions, "host" | "path">> & WebSocketListenerOptions;
	readonly #connections = new Set<WebSocketByteConnection>();
	#server?: Server;
	#webSockets?: WebSocketServer;
	#accept?: ByteConnectionAcceptor;
	#address?: string;
	#closing = false;

	constructor(options: WebSocketListenerOptions) {
		this.#options = resolveOptions(options);
	}

	get address(): string | undefined {
		return this.#address;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.#server) throw new Error("WebSocket listener is already started");
		if (this.#closing) throw new Error("WebSocket listener is closing or closed");
		this.#accept = accept;

		const webSockets = new WebSocketServer({
			noServer: true,
			maxPayload: this.#options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH,
			perMessageDeflate: false,
		});
		const server = createServer((_request, response) => {
			response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
			response.end("Not found");
		});
		server.on("upgrade", (request, socket, head) => {
			void this.#upgrade(webSockets, request, socket, head);
		});
		server.on("error", (error) => this.#reportError(error));
		webSockets.on("connection", (socket) => this.#acceptSocket(socket));
		webSockets.on("error", (error) => this.#reportError(error));

		this.#server = server;
		this.#webSockets = webSockets;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(this.#options.port, this.#options.host);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("WebSocket listener has no TCP address");
			this.#address = `ws://${formatHost(address.address)}:${address.port}${this.#options.path}`;
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		this.#address = undefined;
		await Promise.all([...this.#connections].map((connection) => connection.close()));
		await Promise.all([closeWebSocketServer(this.#webSockets), closeHttpServer(this.#server)]);
		this.#connections.clear();
		this.#webSockets = undefined;
		this.#server = undefined;
	}

	async #upgrade(webSockets: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		try {
			const requestUrl = new URL(request.url ?? "/", "http://runtime.internal");
			if (requestUrl.pathname !== this.#options.path || this.#closing) {
				rejectUpgrade(socket, 404, "Not Found");
				return;
			}
			const authorization = await this.#options.authorize(request);
			if (!authorization.authorized || this.#closing) {
				rejectUpgrade(socket, 401, "Unauthorized");
				return;
			}
			webSockets.handleUpgrade(request, socket, head, (client) => {
				webSockets.emit("connection", client, request);
			});
		} catch (error) {
			this.#reportError(error);
			rejectUpgrade(socket, 401, "Unauthorized");
		}
	}

	#acceptSocket(socket: WebSocket): void {
		if (this.#closing || !this.#accept) {
			socket.close(1012, "Server shutting down");
			return;
		}
		const connection = new WebSocketByteConnection(
			socket,
			this.#options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4,
			this.#options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
		);
		this.#connections.add(connection);
		const handler = this.#accept(connection);
		socket.on("message", (data, isBinary) => {
			if (!isBinary) {
				handler.onError(new Error("Diffex WebSocket protocol requires binary messages"));
				socket.close(1003, "Binary messages required");
				return;
			}
			handler.onData(rawDataBytes(data));
		});
		socket.once("error", (error) => handler.onError(error));
		socket.once("close", () => {
			connection.markClosed();
			this.#connections.delete(connection);
			handler.onClose();
		});
	}

	#reportError(error: unknown): void {
		try {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect listener state.
		}
	}
}

export function createWebSocketListener(options: WebSocketListenerOptions): DiffexServerListener {
	return new DiffexWebSocketListener(options);
}

export class WebSocketByteConnection implements ByteConnection {
	readonly #socket: WebSocket;
	readonly #maxPendingBytes: number;
	readonly #gracefulCloseTimeoutMs: number;
	#closed = false;
	#pendingBytes = 0;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(socket: WebSocket, maxPendingBytes: number, gracefulCloseTimeoutMs: number) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
		this.#gracefulCloseTimeoutMs = gracefulCloseTimeoutMs;
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) return Promise.reject(new TypeError("WebSocket chunks must be Uint8Array"));
		if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket connection is closed"));
		}
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		}
		const bytes = chunk.slice();
		this.#pendingBytes += bytes.byteLength;
		const send = this.#writeTail.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
						reject(new Error("WebSocket connection is closed"));
						return;
					}
					this.#socket.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
				}),
		);
		const tracked = send.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#writeTail = tracked.catch(() => {});
		return tracked;
	}

	async close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closed) return;
		if (finalChunk) await this.send(finalChunk);
		this.#closed = true;
		if (this.#socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.#socket.terminate();
				resolve();
			}, this.#gracefulCloseTimeoutMs);
			timer.unref();
			this.#socket.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			this.#socket.close(1000, "Server closed");
		});
	}

	markClosed(): void {
		this.#closed = true;
	}
}

function resolveOptions(options: WebSocketListenerOptions) {
	if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new TypeError("WebSocket listener port must be an integer from 0 through 65535");
	}
	const path = options.path ?? "/runtime";
	if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
		throw new TypeError("WebSocket listener path must be an absolute path without query or fragment");
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("WebSocket listener maxPendingBytes must be a positive safe integer");
	}
	return { ...options, host: options.host ?? "127.0.0.1", path, maxPendingBytes };
}

function rawDataBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	if (socket.destroyed) return;
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`);
}

function formatHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

async function closeWebSocketServer(server: WebSocketServer | undefined): Promise<void> {
	if (!server) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeHttpServer(server: Server | undefined): Promise<void> {
	if (!server || !server.listening) return;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
