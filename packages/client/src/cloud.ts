import { PROTOCOL_VERSION } from "@earendil-works/diffex-protocol";
import type { ByteTransportFactory } from "./transport.ts";
import { createWebSocketTransportFactory, type WebSocketConstructor } from "./websocket.ts";

export type CloudSessionStatus = "creating" | "running" | "stopping" | "stopped" | "failed" | "deleting" | "deleted";

export interface CloudSession {
	session_id: string;
	status: CloudSessionStatus;
	created_at: string;
	updated_at: string;
}

export interface CloudRuntimeAttachment {
	url: string;
	expires_at: string;
	protocol_version: number;
}

interface CloudFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

export type CloudFetch = (
	input: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body?: string;
	},
) => Promise<CloudFetchResponse>;

export interface DiffexCloudClientOptions {
	baseUrl: string | URL;
	accessToken: string | (() => string | Promise<string>);
	fetch?: CloudFetch;
}

export interface CloudTransportOptions {
	maxPendingBytes?: number;
	webSocket?: WebSocketConstructor;
}

export class DiffexCloudApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId?: string;

	constructor(input: { status: number; code: string; message: string; requestId?: string }) {
		super(input.message);
		this.name = "DiffexCloudApiError";
		this.status = input.status;
		this.code = input.code;
		this.requestId = input.requestId;
	}
}

/** Authenticated control-plane client for hosted Diffex session lifecycle and attachment. */
export class DiffexCloudClient {
	readonly #baseUrl: URL;
	readonly #accessToken: DiffexCloudClientOptions["accessToken"];
	readonly #fetch: CloudFetch;

	constructor(options: DiffexCloudClientOptions) {
		this.#baseUrl = normalizedBaseUrl(options.baseUrl);
		this.#accessToken = options.accessToken;
		this.#fetch = options.fetch ?? requiredFetch();
	}

	async createSession(): Promise<CloudSession> {
		const value = await this.#request("POST", "/v1/cloud/sessions", {});
		return sessionResponse(value);
	}

	async listSessions(): Promise<CloudSession[]> {
		const value = record(await this.#request("GET", "/v1/cloud/sessions"));
		if (!Array.isArray(value.sessions)) throw invalidResponse();
		return value.sessions.map(cloudSession);
	}

	async getSession(sessionId: string): Promise<CloudSession> {
		return sessionResponse(await this.#request("GET", sessionPath(sessionId)));
	}

	async createAttachment(sessionId: string): Promise<CloudRuntimeAttachment> {
		const value = record(await this.#request("POST", `${sessionPath(sessionId)}/attach`, {}));
		return cloudAttachment(value.attachment);
	}

	async stopSession(sessionId: string): Promise<CloudSession> {
		return sessionResponse(await this.#request("POST", `${sessionPath(sessionId)}/stop`, {}));
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.#request("DELETE", sessionPath(sessionId));
	}

	createTransportFactory(sessionId: string, options: CloudTransportOptions = {}): ByteTransportFactory {
		assertSessionId(sessionId);
		return createWebSocketTransportFactory({
			url: async () => (await this.createAttachment(sessionId)).url,
			...(options.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
			...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
		});
	}

	async #request(method: string, path: string, body?: object): Promise<unknown> {
		const token = await resolveAccessToken(this.#accessToken);
		const response = await this.#fetch(new URL(path, this.#baseUrl).toString(), {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (response.status === 204) return undefined;
		const value = await response.json().catch(() => undefined);
		if (!response.ok) throw apiError(response.status, value);
		return value;
	}
}

function normalizedBaseUrl(input: string | URL): URL {
	const value = new URL(input);
	if (
		value.username ||
		value.password ||
		(value.protocol !== "https:" && !(value.protocol === "http:" && isLoopbackHostname(value.hostname)))
	) {
		throw new TypeError("Diffex cloud baseUrl must use HTTPS outside localhost");
	}
	value.pathname = value.pathname.endsWith("/") ? value.pathname : `${value.pathname}/`;
	value.search = "";
	value.hash = "";
	return value;
}

function requiredFetch(): CloudFetch {
	const candidate = globalThis.fetch;
	if (!candidate) throw new Error("fetch is not available in this runtime");
	return (input, init) => candidate(input, init);
}

async function resolveAccessToken(input: DiffexCloudClientOptions["accessToken"]): Promise<string> {
	const value = typeof input === "function" ? await input() : input;
	const token = value.trim();
	if (!token) throw new Error("Diffex cloud access token is empty");
	return token;
}

function sessionPath(sessionId: string): string {
	assertSessionId(sessionId);
	return `/v1/cloud/sessions/${encodeURIComponent(sessionId)}`;
}

function assertSessionId(sessionId: string): void {
	if (!sessionId.trim()) throw new TypeError("Diffex cloud session ID is required");
}

function sessionResponse(input: unknown): CloudSession {
	return cloudSession(record(input).session);
}

function cloudSession(input: unknown): CloudSession {
	const value = record(input);
	const sessionId = stringValue(value.session_id);
	const status = stringValue(value.status);
	const createdAt = isoTimestamp(value.created_at);
	const updatedAt = isoTimestamp(value.updated_at);
	if (!isCloudSessionStatus(status)) throw invalidResponse();
	return { session_id: sessionId, status, created_at: createdAt, updated_at: updatedAt };
}

function cloudAttachment(input: unknown): CloudRuntimeAttachment {
	const value = record(input);
	const url = stringValue(value.url);
	const parsedUrl = new URL(url);
	if (
		parsedUrl.username ||
		parsedUrl.password ||
		(parsedUrl.protocol !== "wss:" && !(parsedUrl.protocol === "ws:" && isLoopbackHostname(parsedUrl.hostname)))
	) {
		throw invalidResponse();
	}
	const protocolVersion = value.protocol_version;
	if (protocolVersion !== PROTOCOL_VERSION) {
		throw new DiffexCloudApiError({
			status: 409,
			code: "unsupported_protocol_version",
			message: `Diffex cloud requires protocol version ${String(protocolVersion)}; this client supports ${String(PROTOCOL_VERSION)}`,
		});
	}
	return {
		url,
		expires_at: isoTimestamp(value.expires_at),
		protocol_version: Number(protocolVersion),
	};
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isCloudSessionStatus(value: string): value is CloudSessionStatus {
	return ["creating", "running", "stopping", "stopped", "failed", "deleting", "deleted"].includes(value);
}

function apiError(status: number, input: unknown): DiffexCloudApiError {
	const error = optionalRecord(optionalRecord(input)?.error);
	return new DiffexCloudApiError({
		status,
		code: typeof error?.code === "string" ? error.code : "request_failed",
		message: typeof error?.message === "string" ? error.message : `Diffex cloud request failed (${status})`,
		...(typeof error?.requestId === "string" ? { requestId: error.requestId } : {}),
	});
}

function record(input: unknown): Record<string, unknown> {
	const value = optionalRecord(input);
	if (!value) throw invalidResponse();
	return value;
}

function optionalRecord(input: unknown): Record<string, unknown> | undefined {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined;
}

function stringValue(input: unknown): string {
	if (typeof input !== "string" || !input) throw invalidResponse();
	return input;
}

function isoTimestamp(input: unknown): string {
	const value = stringValue(input);
	if (Number.isNaN(Date.parse(value))) throw invalidResponse();
	return value;
}

function invalidResponse(): DiffexCloudApiError {
	return new DiffexCloudApiError({
		status: 502,
		code: "invalid_response",
		message: "Diffex cloud returned an invalid response",
	});
}
