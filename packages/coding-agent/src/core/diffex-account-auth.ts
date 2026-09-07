import { setTimeout as sleep } from "node:timers/promises";
import {
	type DiffexAccountAuthStorage,
	type DiffexAccountSession,
	DiffexAccountStorageError,
	KeyringDiffexAccountAuthStorage,
} from "./account-auth-storage.ts";

const DEFAULT_API_ORIGIN = "https://api.diffex.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_WINDOW_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 30_000;

export interface DiffexDeviceAuthorizationPrompt {
	verificationUri: string;
	userCode: string;
}

export interface DiffexAccountLoginOptions {
	signal?: AbortSignal;
	onDeviceAuthorization: (prompt: DiffexDeviceAuthorizationPrompt) => void;
}

export interface DiffexAccountLogoutResult {
	hadSession: boolean;
	remoteConfirmed: boolean;
}

export interface DiffexAccountAuth {
	readonly apiOrigin: string;
	hasSession(signal?: AbortSignal): Promise<boolean>;
	login(options: DiffexAccountLoginOptions): Promise<void>;
	logout(signal?: AbortSignal): Promise<DiffexAccountLogoutResult>;
}

export interface DiffexAccountAuthDependencies {
	fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
	storage: DiffexAccountAuthStorage;
	now: () => number;
	sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface HostedDiffexAccountAuthOptions {
	apiOrigin?: string;
	env?: Record<string, string | undefined>;
	dependencies?: DiffexAccountAuthDependencies;
}

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	interval: number;
};

type TokenResponse = {
	accessToken: string;
	refreshToken: string;
	tokenType: "Bearer";
	expiresIn: number;
	context?: Record<string, unknown>;
};

type JsonResponse = {
	response: Response;
	body: unknown;
};

export class DiffexAccountAuthError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "DiffexAccountAuthError";
	}
}

export class HostedDiffexAccountAuth implements DiffexAccountAuth {
	readonly apiOrigin: string;
	readonly #dependencies: DiffexAccountAuthDependencies;

	constructor(options: HostedDiffexAccountAuthOptions = {}) {
		this.apiOrigin = normalizeApiOrigin(
			options.apiOrigin ?? options.env?.DIFFEX_API_URL ?? process.env.DIFFEX_API_URL ?? DEFAULT_API_ORIGIN,
		);
		this.#dependencies = options.dependencies ?? createDefaultDependencies();
	}

	async hasSession(signal?: AbortSignal): Promise<boolean> {
		try {
			return (await this.#dependencies.storage.read(this.apiOrigin, signal)) !== undefined;
		} catch (error) {
			throw normalizeStorageError(error);
		}
	}

	/** Read-only commerce access. Credentials stay inside the account client. */
	async readBilling(resource: "plans" | "subscription", signal?: AbortSignal): Promise<unknown> {
		if (resource !== "plans" && resource !== "subscription")
			throw new DiffexAccountAuthError("Invalid billing resource");
		try {
			const stored = await this.#dependencies.storage.read(this.apiOrigin, signal);
			if (!stored) throw new DiffexAccountAuthError("Sign in to Diffex with /login before checking billing.");
			const session =
				stored.expiresAt <= this.#dependencies.now() + REFRESH_WINDOW_MS
					? await refreshSession(stored, this.#dependencies, signal)
					: stored;
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const response = await this.#dependencies.fetch(new URL(`/v1/billing/${resource}`, this.apiOrigin), {
				method: "GET",
				redirect: "error",
				headers: {
					accept: "application/json",
					"cache-control": "no-store",
					authorization: `Bearer ${session.accessToken}`,
				},
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (response.status === 401)
				throw new DiffexAccountAuthError("Your Diffex session is no longer authorized. Use /login again.");
			if (response.status === 403) throw new DiffexAccountAuthError("Your organization role cannot view billing.");
			if (response.status === 404) throw new DiffexAccountAuthError("Billing is not enabled on this Diffex API.");
			if (!response.ok) throw new DiffexAccountAuthError("Billing is temporarily unavailable. Try again shortly.");
			return await response.json();
		} catch (error) {
			if (error instanceof DiffexAccountAuthError) throw new DiffexAccountAuthError(error.message);
			throw new DiffexAccountAuthError("Unable to read Diffex billing. Check your connection and account sign-in.");
		}
	}

	async login(options: DiffexAccountLoginOptions): Promise<void> {
		try {
			throwIfLoginCancelled(options.signal);
			const started = await postJson(
				this.#dependencies,
				this.apiOrigin,
				"/v1/auth/cli/start",
				{},
				{},
				options.signal,
			);
			if (!started.response.ok) throw responseError(started, "Unable to start Diffex sign in");
			const authorization = parseDeviceAuthorization(started.body, this.apiOrigin);
			options.onDeviceAuthorization({
				verificationUri: authorization.verificationUriComplete ?? authorization.verificationUri,
				userCode: authorization.userCode,
			});

			const token = await pollForToken(this.apiOrigin, authorization, this.#dependencies, options.signal);
			const session = toStoredSession(this.apiOrigin, token, this.#dependencies.now());
			await this.#dependencies.storage.write(session, options.signal);
		} catch (error) {
			if (options.signal?.aborted) throw loginCancelled(error);
			throw normalizeStorageError(error);
		}
	}

	async logout(signal?: AbortSignal): Promise<DiffexAccountLogoutResult> {
		let stored: DiffexAccountSession | undefined;
		try {
			stored = await this.#dependencies.storage.read(this.apiOrigin, signal);
		} catch (error) {
			throw normalizeStorageError(error);
		}
		if (!stored) return { hadSession: false, remoteConfirmed: true };

		let remoteConfirmed = true;
		try {
			const session =
				stored.expiresAt <= this.#dependencies.now() + REFRESH_WINDOW_MS
					? await refreshSession(stored, this.#dependencies, signal)
					: stored;
			const result = await postJson(
				this.#dependencies,
				this.apiOrigin,
				"/v1/auth/logout",
				{},
				{ authorization: `Bearer ${session.accessToken}` },
				signal,
			);
			remoteConfirmed = result.response.ok || result.response.status === 401;
		} catch {
			remoteConfirmed = false;
		}

		try {
			await this.#dependencies.storage.delete(this.apiOrigin);
		} catch (error) {
			throw normalizeStorageError(error);
		}
		return { hadSession: true, remoteConfirmed };
	}
}

function createDefaultDependencies(): DiffexAccountAuthDependencies {
	return {
		fetch: (input, init) => globalThis.fetch(input, init),
		storage: new KeyringDiffexAccountAuthStorage(),
		now: () => Date.now(),
		sleep: async (milliseconds, signal) => {
			await sleep(milliseconds, undefined, signal ? { signal } : undefined);
		},
	};
}

async function pollForToken(
	apiOrigin: string,
	authorization: DeviceAuthorization,
	dependencies: DiffexAccountAuthDependencies,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const deadline = dependencies.now() + authorization.expiresIn * 1_000;
	let intervalMs = authorization.interval * 1_000;

	while (dependencies.now() < deadline) {
		throwIfLoginCancelled(signal);
		const remaining = deadline - dependencies.now();
		try {
			await dependencies.sleep(Math.min(intervalMs, remaining), signal);
		} catch (error) {
			if (signal?.aborted) throw loginCancelled(error);
			throw error;
		}
		throwIfLoginCancelled(signal);
		if (dependencies.now() >= deadline) break;

		let result: JsonResponse;
		try {
			result = await postJson(
				dependencies,
				apiOrigin,
				"/v1/auth/cli/poll",
				{
					device_code: authorization.deviceCode,
					interval: Math.ceil(intervalMs / 1_000),
				},
				{},
				signal,
			);
		} catch (error) {
			if (signal?.aborted) throw loginCancelled(error);
			intervalMs = Math.min(intervalMs * 2, MAX_POLL_INTERVAL_MS);
			continue;
		}

		if (result.response.status === 202) continue;
		if (result.response.ok) return parseTokenResponse(result.body);
		if (result.response.status === 429) {
			const retryAfter = parseRetryAfter(result.response.headers.get("retry-after"));
			intervalMs =
				retryAfter === undefined
					? Math.min(intervalMs + 5_000, MAX_POLL_INTERVAL_MS)
					: Math.min(retryAfter * 1_000, MAX_POLL_INTERVAL_MS);
			continue;
		}
		if (result.response.status >= 500) {
			intervalMs = Math.min(intervalMs * 2, MAX_POLL_INTERVAL_MS);
			continue;
		}
		throw responseError(result, "Diffex sign in was not completed");
	}

	throw new DiffexAccountAuthError("The sign-in code expired. Use /login to try again.");
}

async function refreshSession(
	session: DiffexAccountSession,
	dependencies: DiffexAccountAuthDependencies,
	signal?: AbortSignal,
): Promise<DiffexAccountSession> {
	const result = await postJson(
		dependencies,
		session.apiOrigin,
		"/v1/auth/token/refresh",
		{ refresh_token: session.refreshToken },
		{},
		signal,
	);
	if (!result.response.ok) {
		const code = responseErrorCode(result.body);
		if (code === "invalid_grant" || code === "unauthenticated" || result.response.status === 401) {
			await dependencies.storage.delete(session.apiOrigin);
			throw new DiffexAccountAuthError("Your Diffex session expired. Use /login to sign in again.");
		}
		throw responseError(result, "Unable to refresh the Diffex session");
	}

	const token = parseTokenResponse(result.body);
	const refreshed = toStoredSession(session.apiOrigin, token, dependencies.now(), session.context);
	await dependencies.storage.write(refreshed, signal);
	return refreshed;
}

async function postJson(
	dependencies: DiffexAccountAuthDependencies,
	apiOrigin: string,
	path: string,
	body: Record<string, unknown>,
	extraHeaders: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<JsonResponse> {
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		response = await dependencies.fetch(new URL(path, apiOrigin), {
			method: "POST",
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				...extraHeaders,
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (error) {
		if (signal?.aborted) throw loginCancelled(error);
		throw new DiffexAccountAuthError("Unable to reach the Diffex authentication service", error);
	}

	let responseBody: unknown = {};
	try {
		responseBody = await response.json();
	} catch {
		responseBody = {};
	}
	return { response, body: responseBody };
}

function parseDeviceAuthorization(value: unknown, apiOrigin: string): DeviceAuthorization {
	if (!isRecord(value)) throw invalidServerResponse();
	if (
		typeof value.device_code !== "string" ||
		value.device_code.length === 0 ||
		typeof value.user_code !== "string" ||
		value.user_code.length === 0 ||
		typeof value.verification_uri !== "string" ||
		!isPositiveNumber(value.expires_in) ||
		!isPositiveNumber(value.interval)
	) {
		throw invalidServerResponse();
	}
	const verificationUri = validateVerificationUrl(value.verification_uri, apiOrigin);
	const verificationUriComplete =
		typeof value.verification_uri_complete === "string" && value.verification_uri_complete.length > 0
			? validateVerificationUrl(value.verification_uri_complete, apiOrigin)
			: undefined;
	if (
		verificationUriComplete !== undefined &&
		new URL(verificationUriComplete).origin !== new URL(verificationUri).origin
	) {
		throw invalidServerResponse();
	}

	return {
		deviceCode: value.device_code,
		userCode: value.user_code,
		verificationUri,
		...(verificationUriComplete === undefined ? {} : { verificationUriComplete }),
		expiresIn: Math.min(Math.floor(value.expires_in), 3_600),
		interval: Math.max(1, Math.floor(value.interval)),
	};
}

function parseTokenResponse(value: unknown): TokenResponse {
	if (
		!isRecord(value) ||
		typeof value.access_token !== "string" ||
		value.access_token.length === 0 ||
		typeof value.refresh_token !== "string" ||
		value.refresh_token.length === 0 ||
		value.token_type !== "Bearer" ||
		!isPositiveNumber(value.expires_in) ||
		(value.context !== undefined && !isRecord(value.context))
	) {
		throw invalidServerResponse();
	}
	return {
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		tokenType: "Bearer",
		expiresIn: Math.floor(value.expires_in),
		...(value.context === undefined ? {} : { context: value.context }),
	};
}

function toStoredSession(
	apiOrigin: string,
	token: TokenResponse,
	now: number,
	previousContext?: Record<string, unknown>,
): DiffexAccountSession {
	const context = token.context ?? previousContext;
	return {
		version: 1,
		apiOrigin,
		accessToken: token.accessToken,
		refreshToken: token.refreshToken,
		tokenType: token.tokenType,
		expiresAt: now + token.expiresIn * 1_000,
		...(context === undefined ? {} : { context }),
	};
}

function responseError(result: JsonResponse, fallback: string): DiffexAccountAuthError {
	const code = responseErrorCode(result.body);
	const message =
		code === "access_denied"
			? "Diffex sign in was denied."
			: code === "expired_token"
				? "The sign-in code expired. Use /login to try again."
				: code === "rate_limited" || result.response.status === 429
					? "Too many authentication attempts. Try again shortly."
					: code === "auth_temporarily_unavailable" || result.response.status >= 500
						? "Diffex authentication is temporarily unavailable."
						: `${fallback} (${result.response.status})`;
	return new DiffexAccountAuthError(message);
}

function responseErrorCode(value: unknown): string | undefined {
	if (!isRecord(value) || !isRecord(value.error)) return undefined;
	return typeof value.error.code === "string" ? value.error.code : undefined;
}

function normalizeApiOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new DiffexAccountAuthError("Diffex API URL must be a valid origin", error);
	}
	const localHttp = url.protocol === "http:" && isLocalApiHostname(url.hostname);
	if (
		(url.protocol !== "https:" && !localHttp) ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new DiffexAccountAuthError("Diffex API URL must be an HTTPS origin without credentials or a path");
	}
	return url.origin;
}

function validateVerificationUrl(value: string, apiOrigin: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw invalidServerResponse(error);
	}
	const apiUrl = new URL(apiOrigin);
	const localHttp =
		apiUrl.protocol === "http:" &&
		isLocalApiHostname(apiUrl.hostname) &&
		url.protocol === "http:" &&
		isLocalApiHostname(url.hostname);
	if ((url.protocol !== "https:" && !localHttp) || url.username !== "" || url.password !== "") {
		throw invalidServerResponse();
	}
	return url.toString();
}

function isLocalApiHostname(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "api.diffex.test"
	);
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function invalidServerResponse(cause?: unknown): DiffexAccountAuthError {
	return new DiffexAccountAuthError("The Diffex authentication service returned an invalid response", cause);
}

function loginCancelled(cause?: unknown): DiffexAccountAuthError {
	return new DiffexAccountAuthError("Sign in cancelled", cause);
}

function throwIfLoginCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw loginCancelled(signal.reason);
}

function normalizeStorageError(error: unknown): unknown {
	return error instanceof DiffexAccountStorageError ? new DiffexAccountAuthError(error.message, error) : error;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
