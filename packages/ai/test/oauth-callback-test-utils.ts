import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthAuth } from "../src/auth/types.ts";

const nativeFetch = globalThis.fetch;
const privateDetail = '<script>private-token="secret"&code=secret-code</script>';

export function defineOAuthCallbackTests(
	provider: OAuthAuth,
	options: {
		name: string;
		authorizeUrl: string;
		tokenUrl: string;
		clientId?: string;
		scope?: string;
		redirectUri?: string;
	},
): void {
	describe.sequential(`${options.name} browser callback`, () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("keeps callback validation, PKCE, and exchange timing while returning Diffex pages", async () => {
			let finishExchange: (response: Response) => void = () => {
				throw new Error("No pending exchange");
			};
			let exchangeBody: Record<string, string> | undefined;
			const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				expect(String(input)).toBe(options.tokenUrl);
				expect(init?.method).toBe("POST");
				exchangeBody =
					init?.body instanceof URLSearchParams
						? Object.fromEntries(init.body)
						: (JSON.parse(String(init?.body)) as Record<string, string>);
				return new Promise<Response>((resolve, reject) => {
					finishExchange = resolve;
					init?.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
				});
			});
			vi.stubGlobal("fetch", fetchMock);
			let authorize: URL | undefined;
			let callback: URL | undefined;
			let manualSignal: AbortSignal | undefined;
			let settled = false;
			const controller = new AbortController();
			const login = provider.login({
				signal: controller.signal,
				notify: (event) => {
					if (event.type !== "auth_url") return;
					authorize = new URL(event.url);
					callback = new URL(
						authorize.searchParams.get("redirect_uri") ?? authorize.searchParams.get("callback_url") ?? "",
					);
					callback.hostname = "127.0.0.1";
				},
				prompt: async (prompt) => {
					if (prompt.type === "select") return "browser";
					manualSignal = prompt.signal;
					return waitForCancellation(controller.signal);
				},
			});
			const outcome = login.then(
				(credential) => {
					settled = true;
					return credential;
				},
				(error: unknown) => {
					settled = true;
					throw error;
				},
			);
			try {
				await vi.waitFor(() => expect(callback).toBeDefined());
				if (!callback || !authorize) throw new Error("No browser callback");
				expect(`${authorize.origin}${authorize.pathname}`).toBe(options.authorizeUrl);
				if (options.clientId) expect(authorize.searchParams.get("client_id")).toBe(options.clientId);
				if (options.scope) expect(authorize.searchParams.get("scope")).toBe(options.scope);
				if (options.redirectUri) expect(authorize.searchParams.get("redirect_uri")).toBe(options.redirectUri);
				expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
				const state = authorize.searchParams.get("state");
				if (state) callback.searchParams.set("state", state);

				const invalid = new URL(callback);
				invalid.pathname = "/invalid-route";
				let response = await nativeFetch(invalid);
				expect(response.status).toBe(404);
				assertErrorPage(await response.text());

				response = await nativeFetch(callback);
				expect(response.status).toBe(400);
				assertErrorPage(await response.text());
				if (state) {
					invalid.pathname = callback.pathname;
					invalid.searchParams.set("code", "mock-code");
					invalid.searchParams.set("state", "wrong-state");
					response = await nativeFetch(invalid);
					expect(response.status).toBe(400);
					expect(await response.text()).toContain("State mismatch.");
				}
				expect(fetchMock).not.toHaveBeenCalled();
				callback.searchParams.set("code", "mock-code");
				let callbackArrived = false;
				const callbackResponse = nativeFetch(callback).then((result) => {
					callbackArrived = true;
					return result;
				});
				await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
				// OpenRouter replies after exchange; Codex and Anthropic reply before it completes.
				if (options.name === "OpenRouter") expect(callbackArrived).toBe(false);
				else assertSuccessPage(await (await callbackResponse).text());
				expect(settled).toBe(false);
				expect(exchangeBody?.code).toBe("mock-code");
				const verifier = exchangeBody?.code_verifier;
				expect(verifier).toBeTruthy();
				const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
				expect(Buffer.from(digest).toString("base64url")).toBe(authorize.searchParams.get("code_challenge"));
				if (options.clientId) expect(exchangeBody?.client_id).toBe(options.clientId);
				if (options.redirectUri) expect(exchangeBody?.redirect_uri).toBe(options.redirectUri);
				const payload = Buffer.from(
					JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "mock-account" } }),
				).toString("base64");
				finishExchange(
					Response.json({
						key: "mock-key",
						access_token: `e30.${payload}.signature`,
						refresh_token: "mock-refresh",
						expires_in: 3600,
					}),
				);
				await expect(outcome).resolves.toMatchObject({ type: "oauth" });
				const success = await callbackResponse;
				expect(success.status).toBe(200);
				if (options.name === "OpenRouter") assertSuccessPage(await success.text());
				expect(manualSignal?.aborted).toBe(true);
			} finally {
				controller.abort();
				await outcome.catch(() => {});
			}
		});

		if (options.name !== "OpenAI Codex") {
			it("omits raw provider error content from the browser", async () => {
				const fetchMock = vi.fn();
				vi.stubGlobal("fetch", fetchMock);
				let callback: URL | undefined;
				const controller = new AbortController();
				const login = provider.login({
					signal: controller.signal,
					prompt: async () => waitForCancellation(controller.signal),
					notify: (event) => {
						if (event.type !== "auth_url") return;
						const auth = new URL(event.url);
						callback = new URL(
							auth.searchParams.get("redirect_uri") ?? auth.searchParams.get("callback_url") ?? "",
						);
						callback.hostname = "127.0.0.1";
						callback.searchParams.set("error", privateDetail);
						callback.searchParams.set("error_description", privateDetail);
					},
				});
				const outcome = login.catch((error: unknown) => error);
				try {
					await vi.waitFor(() => expect(callback).toBeDefined());
					if (!callback) throw new Error("No callback");
					const response = await nativeFetch(callback);
					expect(response.status).toBe(400);
					const html = await response.text();
					assertErrorPage(html);
					expect(html).not.toContain("private-token");
					expect(fetchMock).not.toHaveBeenCalled();
					if (options.name === "OpenRouter") expect(await outcome).toBeInstanceOf(Error);
				} finally {
					controller.abort();
					await outcome;
				}
			});
		}
	});
}

function waitForCancellation(signal: AbortSignal): Promise<string> {
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
	});
}

function assertSuccessPage(html: string): void {
	expect(html).toContain("<title>Continue in Diffex</title>");
	expect(html).toContain("<h1>Continue in Diffex</h1>");
	expect(html).toContain("You can close this tab and return to Diffex.");
	expect(html).toContain("Check the terminal for sign-in status.");
	expect(html).not.toMatch(/authentication (successful|completed)|signed in|window\.close|<script/i);
}

function assertErrorPage(html: string): void {
	expect(html).toContain("<title>Diffex sign-in error</title>");
	expect(html).toContain("<h1>Could not complete sign-in</h1>");
	expect(html).toContain("Return to Diffex and run /login to try again.");
	expect(html).not.toContain("<script");
}
