import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { ChatGPTRegistrationStore } from "../src/auth/oauth/chatgpt-registration.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";

const nativeFetch = globalThis.fetch;
const issuer = "https://auth.openai.com";
const clientId = "oaiapp_diffex_test";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const key = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(key.publicKey)), kid: "test-key", alg: "RS256" };
let directory: string;
let authorization: URL;
let tokenOverrides: Record<string, unknown>;
let claims: Record<string, unknown>;
let requests: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "diffex-chatgpt-oauth-"));
	vi.stubEnv("DIFFEX_CODING_AGENT_DIR", directory);
	tokenOverrides = {};
	claims = {};
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
			if (url.endsWith("/.well-known/openid-configuration"))
				return Response.json({ issuer, revocation_endpoint: `${issuer}/oauth/revoke` });
			if (url.endsWith("/oauth/revoke")) return new Response(null, { status: 200 });
			if (url !== `${issuer}/api/accounts/oauth/token`) throw new Error(`Unexpected request: ${url}`);
			const idToken = await new SignJWT({
				nonce: authorization.searchParams.get("nonce"),
				email: "person@example.com",
				...claims,
			})
				.setProtectedHeader({ alg: "RS256", kid: "test-key" })
				.setIssuer(issuer)
				.setAudience(clientId)
				.setSubject("account-subject")
				.setIssuedAt()
				.setExpirationTime("1h")
				.sign(key.privateKey);
			return Response.json({
				access_token: "opaque-access",
				refresh_token: "refresh-one",
				expires_in: 3600,
				token_type: "Bearer",
				scope: scopes,
				id_token: idToken,
				...tokenOverrides,
			});
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function startLogin(selection = clientId, signal = new AbortController().signal) {
	let ready: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const login = openaiCodexOAuth.login({
		signal,
		notify: (event) => {
			if (event.type === "auth_url") {
				authorization = new URL(event.url);
				ready();
			}
		},
		prompt: async (prompt) => (prompt.type === "select" ? selection : new Promise<string>(() => {})),
	});
	const outcome = login.catch((error: unknown) => error);
	await Promise.race([started, login]);
	return { login, outcome };
}

function callback(params: Record<string, string> = {}) {
	const url = new URL(authorization.searchParams.get("redirect_uri") ?? "");
	url.search = new URLSearchParams({
		state: authorization.searchParams.get("state") ?? "",
		code: "code",
		client_id: clientId,
		...params,
	}).toString();
	return url;
}

async function signIn() {
	const attempt = await startLogin();
	await nativeFetch(callback());
	return attempt.login;
}

describe.sequential("ChatGPT registration and session lifecycle", () => {
	it("persists the host before authorization and exchanges with the issued client and exact PKCE redirect", async () => {
		const attempt = await startLogin();
		const host = authorization.searchParams.get("ext_agent_host_id");
		expect(readFileSync(join(directory, "chatgpt", "host"), "utf8")).toBe(host);
		expect(authorization.searchParams.get("scope")).toBe(scopes);
		expect(authorization.searchParams.get("resource")).toBe("https://api.openai.com/v1");
		expect((await nativeFetch(callback({ state: "wrong" }))).status).toBe(400);
		expect(requests).toHaveLength(0);
		const response = await nativeFetch(callback());
		expect(await response.text()).toContain("Continue in Diffex");
		const credential = await attempt.login;
		expect(credential).toMatchObject({
			clientId,
			subject: "account-subject",
			extAgentHostId: host,
			access: "opaque-access",
		});
		const body = new URLSearchParams(String(requests[0].init?.body));
		expect(body.get("client_id")).toBe(clientId);
		expect(body.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier") ?? ""));
		expect(Buffer.from(digest).toString("base64url")).toBe(authorization.searchParams.get("code_challenge"));
		expect(statSync(join(directory, "chatgpt", `${clientId}.json`)).mode & 0o777).toBe(0o600);
	});

	it.each([
		["wrong nonce", { nonce: "wrong" }, {}],
		["wrong audience", {}, { id_token: "unsigned.token.value" }],
		["missing ID token", {}, { id_token: null }],
		["missing permission", {}, { scope: "openid profile email" }],
		["invalid expiry", {}, { expires_in: -1 }],
		["missing refresh", {}, { refresh_token: "" }],
	] as const)("rejects %s without saving an account identity", async (_name, nextClaims, overrides) => {
		claims = nextClaims;
		tokenOverrides = overrides;
		const attempt = await startLogin();
		await nativeFetch(callback());
		await expect(attempt.login).rejects.toThrow();
		expect(new ChatGPTRegistrationStore().list()[0].subject).toBeUndefined();
	});

	it("rejects missing issued IDs and authorization denial before exchange", async () => {
		const callbacks: Record<string, string>[] = [{ client_id: "dynamic_agent_client" }, { error: "access_denied" }];
		for (const params of callbacks) {
			const attempt = await startLogin();
			await nativeFetch(callback(params));
			await expect(attempt.login).rejects.toThrow();
		}
		expect(requests).toHaveLength(0);
	});

	it("reauthorizes the saved identity using its issued ID and stable host", async () => {
		const first = await signIn();
		const attempt = await startLogin();
		expect(authorization.searchParams.get("client_id")).toBe(clientId);
		expect(authorization.searchParams.get("ext_agent_host_id")).toBe(first.extAgentHostId);
		expect(authorization.searchParams.has("agent_name_hint")).toBe(false);
		expect(authorization.searchParams.get("id_token_hint")).toBe(first.idToken);
		const url = callback();
		url.searchParams.delete("client_id");
		await nativeFetch(url);
		await expect(attempt.login).resolves.toMatchObject({ clientId, subject: first.subject });
	});

	it("rejects a changed client during reauthorization", async () => {
		await signIn();
		const count = requests.length;
		const attempt = await startLogin();
		await nativeFetch(callback({ client_id: "oaiapp_other" }));
		await expect(attempt.login).rejects.toThrow("mismatched");
		expect(requests).toHaveLength(count);
	});

	it("refreshes with the saved issued ID, rotates tokens, and retains omitted scopes", async () => {
		const credential = await signIn();
		tokenOverrides = { id_token: undefined, scope: undefined, refresh_token: "refresh-two" };
		const refreshed = await openaiCodexOAuth.refresh(credential, new AbortController().signal);
		expect(refreshed).toMatchObject({
			refresh: "refresh-two",
			clientId,
			subject: credential.subject,
			scopes: credential.scopes,
		});
		const body = new URLSearchParams(String(requests.at(-1)?.init?.body));
		expect(Object.fromEntries(body)).toEqual({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: "refresh-one",
			resource: "https://api.openai.com/v1",
		});
	});

	it("revokes on logout, clears local tokens, and retains registration without ID-token hints", async () => {
		const credential = await signIn();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => credential);
		const models = createModels({ credentials });
		models.setProvider(
			createProvider({ id: "openai-codex", auth: { oauth: openaiCodexOAuth }, models: [], api: {} }),
		);
		await models.logout("openai-codex");
		expect(await credentials.read("openai-codex")).toBeUndefined();
		expect(new ChatGPTRegistrationStore().list()).toEqual([
			{ clientId, subject: credential.subject, email: credential.email },
		]);
		const request = requests.find((entry) => entry.url.endsWith("/oauth/revoke"));
		expect(Object.fromEntries(new URLSearchParams(String(request?.init?.body)))).toEqual({
			token: credential.refresh,
			token_type_hint: "refresh_token",
			client_id: clientId,
		});
	});

	it("clears local credentials even when remote revocation fails", async () => {
		const credential = await signIn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => credential);
		const models = createModels({ credentials });
		models.setProvider(
			createProvider({ id: "openai-codex", auth: { oauth: openaiCodexOAuth }, models: [], api: {} }),
		);
		await expect(models.logout("openai-codex")).rejects.toThrow("Remote revocation was not confirmed");
		expect(await credentials.read("openai-codex")).toBeUndefined();
	});

	it("requires reauthorization for inherited credentials", async () => {
		const credential: OAuthCredential = { type: "oauth", access: "legacy", refresh: "legacy", expires: 0 };
		await expect(openaiCodexOAuth.refresh(credential, new AbortController().signal)).rejects.toThrow("Run /login");
		await expect(openaiCodexOAuth.toAuth(credential)).rejects.toThrow("Run /login");
		expect(requests).toHaveLength(0);
	});
});
