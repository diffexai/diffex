import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { OAuthSessionExpiredError } from "../errors.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { type ChatGPTRegistration, ChatGPTRegistrationStore } from "./chatgpt-registration.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const TERMINAL_REFRESH_ERRORS = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

async function tokenCredentials(
	response: Response,
	clientId: string,
	hostId: string,
	signal: AbortSignal,
	options: { nonce?: string; previous?: OAuthCredential; registration?: ChatGPTRegistration },
): Promise<OAuthCredential> {
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
		const code =
			typeof error === "string"
				? error
				: error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
		if (options.previous && typeof code === "string" && TERMINAL_REFRESH_ERRORS.has(code)) {
			throw new OAuthSessionExpiredError(`ChatGPT session expired (${code}). Run /login.`);
		}
		throw new Error(
			`ChatGPT token request failed (${response.status}). ${response.status >= 500 ? "Try again later." : "Sign in again with /login."}`,
		);
	}
	const json = (await response.json()) as Record<string, unknown>;
	if (
		typeof json.access_token !== "string" ||
		!json.access_token ||
		typeof json.refresh_token !== "string" ||
		!json.refresh_token ||
		typeof json.expires_in !== "number" ||
		!Number.isFinite(json.expires_in) ||
		json.expires_in <= 0 ||
		!Number.isSafeInteger(Date.now() + json.expires_in * 1000) ||
		typeof json.token_type !== "string" ||
		json.token_type.toLowerCase() !== "bearer"
	) {
		throw new Error("Invalid ChatGPT token response");
	}
	const scopes = typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : options.previous?.scopes;
	if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string"))
		throw new Error("Missing ChatGPT granted scopes");
	let subject = options.previous?.subject;
	let email = options.previous?.email;
	let idToken = options.previous?.idToken;
	if (typeof json.id_token === "string") {
		const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
			[customFetch]: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, init.signal]) }),
		});
		const { payload } = await jwtVerify(json.id_token, jwks, {
			issuer: ISSUER,
			audience: clientId,
			algorithms: ["RS256", "ES256"],
			requiredClaims: ["sub", "exp", "iat", ...(options.nonce ? ["nonce"] : [])],
			clockTolerance: 5,
		});
		if (options.nonce && payload.nonce !== options.nonce) throw new Error("ChatGPT ID token nonce mismatch");
		if (
			!payload.sub ||
			(payload.azp !== undefined && payload.azp !== clientId) ||
			(Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
		)
			throw new Error("Invalid ChatGPT ID token identity");
		const expectedSubject = options.registration?.subject ?? options.previous?.subject;
		if (expectedSubject && payload.sub !== expectedSubject) throw new Error("ChatGPT account identity changed");
		subject = payload.sub;
		email = typeof payload.email === "string" ? payload.email : undefined;
		idToken = json.id_token;
	} else if (options.nonce) throw new Error("ChatGPT sign-in response is missing an ID token");
	signal.throwIfAborted();
	if (typeof subject !== "string" || !subject) throw new Error("Missing validated ChatGPT identity. Run /login.");
	return {
		type: "oauth",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		clientId,
		extAgentHostId: hostId,
		issuer: ISSUER,
		subject,
		email,
		idToken,
		scopes,
	};
}

function requireRegistration(credential: OAuthCredential): { clientId: string; hostId: string } {
	if (
		typeof credential.clientId !== "string" ||
		!/^oaiapp_[\w-]+$/.test(credential.clientId) ||
		typeof credential.extAgentHostId !== "string" ||
		typeof credential.subject !== "string"
	) {
		throw new Error("ChatGPT registration is missing. Run /login to register Diffex.");
	}
	return { clientId: credential.clientId, hostId: credential.extAgentHostId };
}

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const store = new ChatGPTRegistrationStore();
	const hostId = store.hostId();
	const registrations = store.list();
	let registration: ChatGPTRegistration | undefined;
	if (registrations.length) {
		const selected = await interaction.prompt({
			type: "select",
			message: "Continue with ChatGPT",
			options: [
				...registrations.map((entry) => ({
					id: entry.clientId,
					label: `${entry.scopes && !entry.scopes.includes(PLAN_SCOPE) ? "Enable ChatGPT plan usage: " : ""}${entry.email ?? entry.subject ?? "Complete registration"} (${entry.clientId})`,
				})),
				{ id: "new", label: "Add a ChatGPT account or workspace" },
			],
		});
		registration = registrations.find((entry) => entry.clientId === selected);
		if (!registration && selected !== "new") throw new Error("Unknown ChatGPT registration");
	}
	const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(10 * 60 * 1000)]);
	signal.throwIfAborted();
	const state = randomBytes(32).toString("base64url");
	const nonce = randomBytes(32).toString("base64url");
	const { verifier, challenge } = await generatePKCE();
	let accept: (url: URL) => void = () => {};
	const callback = new Promise<URL>((resolve) => {
		accept = resolve;
	});
	let consumed = false;
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "", "http://127.0.0.1");
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Cache-Control", "no-store");
		if (req.method !== "GET" || url.pathname !== "/auth/callback") {
			res.writeHead(404).end(oauthErrorHtml("Callback route not found."));
		} else if (consumed || url.searchParams.get("state") !== state) {
			res.writeHead(400).end(oauthErrorHtml("State mismatch or sign-in already completed."));
		} else if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
			res.writeHead(400).end(oauthErrorHtml("Missing authorization code."));
		} else {
			consumed = true;
			res.end(url.searchParams.has("error") ? oauthErrorHtml("Sign-in was declined.") : oauthSuccessHtml());
			accept(url);
		}
	});
	const promptController = new AbortController();
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		const address = server.address();
		signal.throwIfAborted();
		if (!address || typeof address === "string") throw new Error("ChatGPT callback listener unavailable");
		const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
		const authorize = new URL(`${ISSUER}/api/accounts/authorize`);
		authorize.search = new URLSearchParams({
			client_id: registration?.clientId ?? "dynamic_agent_client",
			ext_agent_host_id: hostId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPE,
			resource: RESOURCE,
			state,
			nonce,
			code_challenge_method: "S256",
			code_challenge: challenge,
		}).toString();
		if (!registration) authorize.searchParams.set("agent_name_hint", "Diffex");
		if (registration?.idToken) authorize.searchParams.set("id_token_hint", registration.idToken);
		if (registration?.email) authorize.searchParams.set("login_hint", registration.email);
		if (registration?.scopes && !registration.scopes.includes(PLAN_SCOPE))
			authorize.searchParams.set("prompt", "consent");
		interaction.notify({
			type: "auth_url",
			url: authorize.toString(),
			instructions: "Continue with ChatGPT in your browser.",
		});
		const manual = interaction
			.prompt({
				type: "manual_code",
				message: "Complete sign-in in your browser, or paste the full redirect URL:",
				placeholder: redirectUri,
				signal: promptController.signal,
			})
			.then((input) => {
				const url = new URL(input.trim());
				if (`${url.origin}${url.pathname}` !== redirectUri) throw new Error("ChatGPT redirect URI mismatch");
				return url;
			});
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("ChatGPT sign-in cancelled or timed out"));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		const url = await Promise.race([callback, manual, cancelled]);
		consumed = true;
		if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state)
			throw new Error("ChatGPT state mismatch");
		if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in was declined. Run /login to try again.");
		const code = url.searchParams.get("code");
		const clientId = url.searchParams.get("client_id") ?? registration?.clientId;
		if (
			!code ||
			url.searchParams.getAll("code").length !== 1 ||
			!clientId ||
			!/^oaiapp_[\w-]+$/.test(clientId) ||
			url.searchParams.getAll("client_id").length > 1 ||
			(registration && registration.clientId !== clientId)
		) {
			throw new Error("Incomplete or mismatched ChatGPT registration callback");
		}
		// A code may expire before exchange. Keep the issued ID for a fresh authorization attempt.
		const issuedRegistration = registration ?? store.list().find((entry) => entry.clientId === clientId);
		if (!issuedRegistration) store.save({ clientId });
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal,
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: clientId,
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
				resource: RESOURCE,
			}),
		});
		const credential = await tokenCredentials(response, clientId, hostId, signal, {
			nonce,
			registration: issuedRegistration,
		});
		store.save({
			clientId,
			subject: credential.subject as string,
			email: credential.email as string | undefined,
			idToken: credential.idToken as string,
			scopes: credential.scopes as string[],
		});
		if (!(credential.scopes as string[]).includes(PLAN_SCOPE)) {
			interaction.notify({
				type: "info",
				message:
					"Signed in to ChatGPT. Plan usage is disabled. Run /login and select Enable ChatGPT plan usage, or configure an OpenAI API key.",
			});
		}
		return credential;
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		promptController.abort();
		server.close();
		server.closeAllConnections();
	}
}

export const openaiCodexOAuth: OAuthAuth = {
	name: "ChatGPT",
	isSubscription: true,
	loginLabel: "Continue with ChatGPT",
	login,
	async refresh(credential, signal) {
		const { clientId, hostId } = requireRegistration(credential);
		signal.throwIfAborted();
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal,
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: clientId,
				refresh_token: credential.refresh,
				resource: RESOURCE,
			}),
		});
		try {
			return await tokenCredentials(response, clientId, hostId, signal, { previous: credential });
		} catch (error) {
			if (error instanceof OAuthSessionExpiredError) {
				new ChatGPTRegistrationStore().save({
					clientId,
					subject: credential.subject as string,
					email: credential.email as string | undefined,
				});
			}
			throw error;
		}
	},
	async logout(credential, signal) {
		const { clientId } = requireRegistration(credential);
		const store = new ChatGPTRegistrationStore();
		const registration = store.list().find((entry) => entry.clientId === clientId);
		if (registration) store.save({ ...registration, idToken: undefined });
		try {
			let endpoint: URL | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					if (!endpoint) {
						const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal });
						if (!discovery.ok) {
							if (discovery.status < 500) break;
							throw new Error("Discovery temporarily unavailable");
						}
						const metadata = (await discovery.json()) as { issuer?: string; revocation_endpoint?: string };
						const discovered = new URL(metadata.revocation_endpoint ?? "");
						if (metadata.issuer !== ISSUER || discovered.origin !== ISSUER) break;
						endpoint = discovered;
					}
					const response = await fetch(endpoint, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						signal,
						body: new URLSearchParams({
							token: credential.refresh,
							token_type_hint: "refresh_token",
							client_id: clientId,
						}),
					});
					if (response.status === 200) return;
					if (response.status < 500) break;
				} catch {
					if (signal.aborted) break;
				}
				if (attempt < 2) await sleep(250 * 2 ** attempt, undefined, { signal });
			}
		} catch {}
		throw new Error(
			"Signed out locally. Remote revocation was not confirmed; disconnect Diffex in ChatGPT Settings.",
		);
	},
	async toAuth(credential) {
		requireRegistration(credential);
		if (!credential.access || credential.reauthorizationRequired)
			throw new Error("ChatGPT session expired. Run /login.");
		if (
			!Array.isArray(credential.scopes) ||
			!credential.scopes.includes(PLAN_SCOPE) ||
			!credential.scopes.includes("resource.invoke")
		) {
			throw new Error("ChatGPT plan usage is not authorized. Run /login.");
		}
		return { apiKey: credential.access, baseUrl: RESOURCE };
	},
};
