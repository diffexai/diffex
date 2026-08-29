import { setTimeout as sleep } from "node:timers/promises";
import {
	type DiffexAccountAuthStorage,
	type DiffexAccountSession,
	DiffexAccountStorageError,
	KeyringDiffexAccountAuthStorage,
} from "../core/account-auth-storage.ts";
import { openBrowser } from "../utils/open-browser.ts";

const DEFAULT_API_ORIGIN = "https://api.diffex.ai";
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_WINDOW_MS = 60_000;
const MAX_POLL_INTERVAL_MS = 30_000;

export type AccountAuthCommandKind = "login" | "status" | "logout";

export interface AccountAuthCommand {
	kind: AccountAuthCommandKind;
	apiOrigin: string;
	noBrowser: boolean;
	json: boolean;
}

export interface AccountAuthCommandDependencies {
	fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
	storage: DiffexAccountAuthStorage;
	openBrowser: (target: string) => void;
	writeLine: (line: string) => void;
	now: () => number;
	sleep: (milliseconds: number) => Promise<void>;
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

export class AccountAuthCommandError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AccountAuthCommandError";
	}
}

export function parseAccountAuthCommand(
	args: string[],
	env: Record<string, string | undefined> = process.env,
): AccountAuthCommand | undefined {
	if (args[0] !== "auth") return undefined;
	const kind = args[1];
	if (kind !== "login" && kind !== "status" && kind !== "logout") return undefined;

	let apiOrigin = normalizeApiOrigin(env.DIFFEX_API_URL ?? DEFAULT_API_ORIGIN);
	let noBrowser = false;
	let json = false;

	for (let index = 2; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--api-url") {
			const value = args[++index];
			if (!value) throw new AccountAuthCommandError("--api-url requires an origin");
			apiOrigin = normalizeApiOrigin(value);
			continue;
		}
		if (argument?.startsWith("--api-url=")) {
			apiOrigin = normalizeApiOrigin(argument.slice("--api-url=".length));
			continue;
		}
		if (argument === "--no-browser") {
			if (kind !== "login") throw new AccountAuthCommandError("--no-browser is only supported by auth login");
			noBrowser = true;
			continue;
		}
		if (argument === "--json") {
			if (kind !== "status") throw new AccountAuthCommandError("--json is only supported by auth status");
			json = true;
			continue;
		}
		throw new AccountAuthCommandError(`Unknown option for auth ${kind}: ${argument ?? ""}`);
	}

	return { kind, apiOrigin, noBrowser, json };
}

export async function executeAccountAuthCommand(
	command: AccountAuthCommand,
	dependencies: AccountAuthCommandDependencies = createDefaultDependencies(),
): Promise<number> {
	try {
		switch (command.kind) {
			case "login":
				return await login(command, dependencies);
			case "status":
				return await status(command, dependencies);
			case "logout":
				return await logout(command, dependencies);
		}
	} catch (error) {
		if (error instanceof DiffexAccountStorageError) {
			throw new AccountAuthCommandError(error.message, error);
		}
		throw error;
	}
}

function createDefaultDependencies(): AccountAuthCommandDependencies {
	return {
		fetch: (input, init) => globalThis.fetch(input, init),
		storage: new KeyringDiffexAccountAuthStorage(),
		openBrowser,
		writeLine: (line) => console.log(line),
		now: () => Date.now(),
		sleep: async (milliseconds) => {
			await sleep(milliseconds);
		},
	};
}

async function login(command: AccountAuthCommand, dependencies: AccountAuthCommandDependencies): Promise<number> {
	const started = await postJson(dependencies, command.apiOrigin, "/v1/auth/cli/start", {});
	if (!started.response.ok) throw responseError(started, "Unable to start Diffex sign in");
	const authorization = parseDeviceAuthorization(started.body, command.apiOrigin);
	const browserUrl = authorization.verificationUriComplete ?? authorization.verificationUri;

	dependencies.writeLine("Open this URL to sign in:");
	dependencies.writeLine(browserUrl);
	dependencies.writeLine(`Confirmation code: ${authorization.userCode}`);
	if (!command.noBrowser) dependencies.openBrowser(browserUrl);

	const token = await pollForToken(command.apiOrigin, authorization, dependencies);
	const session = toStoredSession(command.apiOrigin, token, dependencies.now());
	await dependencies.storage.write(session);
	dependencies.writeLine("Signed in to Diffex.");
	return 0;
}

async function status(command: AccountAuthCommand, dependencies: AccountAuthCommandDependencies): Promise<number> {
	let session = await dependencies.storage.read(command.apiOrigin);
	if (!session) {
		writeStatus(command, dependencies, "signed_out");
		return 1;
	}

	if (session.expiresAt <= dependencies.now() + REFRESH_WINDOW_MS) {
		session = await refreshSession(session, dependencies);
	}

	writeStatus(command, dependencies, "signed_in", session);
	return 0;
}

async function logout(command: AccountAuthCommand, dependencies: AccountAuthCommandDependencies): Promise<number> {
	const stored = await dependencies.storage.read(command.apiOrigin);
	if (!stored) {
		dependencies.writeLine("Already signed out.");
		return 0;
	}

	let remoteFailure: unknown;
	try {
		const session =
			stored.expiresAt <= dependencies.now() + REFRESH_WINDOW_MS
				? await refreshSession(stored, dependencies)
				: stored;
		const result = await postJson(
			dependencies,
			command.apiOrigin,
			"/v1/auth/logout",
			{},
			{ authorization: `Bearer ${session.accessToken}` },
		);
		if (!result.response.ok && result.response.status !== 401) {
			remoteFailure = responseError(result, "Unable to confirm server logout");
		}
	} catch (error) {
		remoteFailure = error;
	}

	await dependencies.storage.delete(command.apiOrigin);
	dependencies.writeLine("Signed out of Diffex.");
	if (remoteFailure) {
		throw new AccountAuthCommandError(
			"Local credentials were removed, but server logout could not be confirmed",
			remoteFailure,
		);
	}
	return 0;
}

async function pollForToken(
	apiOrigin: string,
	authorization: DeviceAuthorization,
	dependencies: AccountAuthCommandDependencies,
): Promise<TokenResponse> {
	const deadline = dependencies.now() + authorization.expiresIn * 1_000;
	let intervalMs = authorization.interval * 1_000;

	while (dependencies.now() < deadline) {
		const remaining = deadline - dependencies.now();
		await dependencies.sleep(Math.min(intervalMs, remaining));
		if (dependencies.now() >= deadline) break;

		let result: JsonResponse;
		try {
			result = await postJson(dependencies, apiOrigin, "/v1/auth/cli/poll", {
				device_code: authorization.deviceCode,
				interval: Math.ceil(intervalMs / 1_000),
			});
		} catch {
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

	throw new AccountAuthCommandError("The sign-in code expired. Run diffex auth login again.");
}

async function refreshSession(
	session: DiffexAccountSession,
	dependencies: AccountAuthCommandDependencies,
): Promise<DiffexAccountSession> {
	const result = await postJson(dependencies, session.apiOrigin, "/v1/auth/token/refresh", {
		refresh_token: session.refreshToken,
	});
	if (!result.response.ok) {
		const code = responseErrorCode(result.body);
		if (code === "invalid_grant" || code === "unauthenticated" || result.response.status === 401) {
			await dependencies.storage.delete(session.apiOrigin);
			throw new AccountAuthCommandError("Your Diffex session expired. Run diffex auth login again.");
		}
		throw responseError(result, "Unable to refresh the Diffex session");
	}

	const token = parseTokenResponse(result.body);
	const refreshed = toStoredSession(session.apiOrigin, token, dependencies.now(), session.context);
	await dependencies.storage.write(refreshed);
	return refreshed;
}

async function postJson(
	dependencies: AccountAuthCommandDependencies,
	apiOrigin: string,
	path: string,
	body: Record<string, unknown>,
	extraHeaders: Record<string, string> = {},
): Promise<JsonResponse> {
	let response: Response;
	try {
		response = await dependencies.fetch(new URL(path, apiOrigin), {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				...extraHeaders,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (error) {
		throw new AccountAuthCommandError("Unable to reach the Diffex authentication service", error);
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

function writeStatus(
	command: AccountAuthCommand,
	dependencies: AccountAuthCommandDependencies,
	statusValue: "signed_in" | "signed_out",
	session?: DiffexAccountSession,
): void {
	if (command.json) {
		dependencies.writeLine(
			JSON.stringify({
				status: statusValue,
				api_url: command.apiOrigin,
				...(session === undefined ? {} : { expires_at: new Date(session.expiresAt).toISOString() }),
			}),
		);
		return;
	}
	dependencies.writeLine(statusValue === "signed_in" ? "Signed in to Diffex." : "Not signed in to Diffex.");
}

function responseError(result: JsonResponse, fallback: string): AccountAuthCommandError {
	const code = responseErrorCode(result.body);
	const message =
		code === "access_denied"
			? "Diffex sign in was denied."
			: code === "expired_token"
				? "The sign-in code expired. Run diffex auth login again."
				: code === "rate_limited" || result.response.status === 429
					? "Too many authentication attempts. Try again shortly."
					: code === "auth_temporarily_unavailable" || result.response.status >= 500
						? "Diffex authentication is temporarily unavailable."
						: `${fallback} (${result.response.status})`;
	return new AccountAuthCommandError(message);
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
		throw new AccountAuthCommandError("Diffex API URL must be a valid origin", error);
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
		throw new AccountAuthCommandError("Diffex API URL must be an HTTPS origin without credentials or a path");
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

function invalidServerResponse(cause?: unknown): AccountAuthCommandError {
	return new AccountAuthCommandError("The Diffex authentication service returned an invalid response", cause);
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
