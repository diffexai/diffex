import { describe, expect, it, vi } from "vitest";
import type { DiffexAccountAuthStorage, DiffexAccountSession } from "../src/core/account-auth-storage.ts";
import { type DiffexAccountAuthDependencies, HostedDiffexAccountAuth } from "../src/core/diffex-account-auth.ts";

const apiOrigin = "https://api.diffex.ai";

class MemoryAccountStorage implements DiffexAccountAuthStorage {
	session: DiffexAccountSession | undefined;

	constructor(session?: DiffexAccountSession) {
		this.session = session;
	}

	async read(requestedOrigin: string): Promise<DiffexAccountSession | undefined> {
		return this.session?.apiOrigin === requestedOrigin ? structuredClone(this.session) : undefined;
	}

	async write(session: DiffexAccountSession): Promise<void> {
		this.session = structuredClone(session);
	}

	async delete(requestedOrigin: string): Promise<void> {
		if (this.session?.apiOrigin === requestedOrigin) this.session = undefined;
	}
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function createHarness(input: { responses?: Response[]; storage?: MemoryAccountStorage; now?: { value: number } }) {
	const responses = [...(input.responses ?? [])];
	const storage = input.storage ?? new MemoryAccountStorage();
	const now = input.now ?? { value: 0 };
	const fetch = vi.fn<DiffexAccountAuthDependencies["fetch"]>(async () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected request");
		return response;
	});
	const dependencies: DiffexAccountAuthDependencies = {
		fetch,
		storage,
		now: () => now.value,
		sleep: vi.fn(async (milliseconds) => {
			now.value += milliseconds;
		}),
	};
	const auth = new HostedDiffexAccountAuth({ apiOrigin, dependencies });
	return { auth, dependencies, fetch, now, storage };
}

describe("Diffex account authentication", () => {
	it("completes device auth without exposing device or token secrets", async () => {
		const harness = createHarness({
			responses: [
				jsonResponse({
					device_code: "device_secret",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.diffex.ai/device",
					verification_uri_complete: "https://auth.diffex.ai/device?user_code=ABCD-EFGH",
					expires_in: 300,
					interval: 1,
				}),
				jsonResponse({ status: "authorization_pending", interval: 1 }, 202),
				jsonResponse({ error: { code: "slow_down" } }, 429, { "retry-after": "2" }),
				jsonResponse({
					access_token: "access_secret",
					refresh_token: "refresh_secret",
					token_type: "Bearer",
					expires_in: 3_600,
					context: { user: { id: "user-diffex-1" } },
				}),
			],
		});
		const prompts: unknown[] = [];

		await harness.auth.login({ onDeviceAuthorization: (prompt) => prompts.push(prompt) });

		expect(prompts).toEqual([
			{
				verificationUri: "https://auth.diffex.ai/device?user_code=ABCD-EFGH",
				userCode: "ABCD-EFGH",
			},
		]);
		expect(harness.storage.session).toMatchObject({
			apiOrigin,
			accessToken: "access_secret",
			refreshToken: "refresh_secret",
			tokenType: "Bearer",
		});
		expect(JSON.stringify(prompts)).not.toMatch(/device_secret|access_secret|refresh_secret/u);
		expect(harness.fetch).toHaveBeenCalledTimes(4);
	});

	it.each([
		{
			name: "plaintext verification URLs from a deployed API",
			verificationUri: "http://auth.diffex.ai/device",
			verificationUriComplete: "http://auth.diffex.ai/device?user_code=ABCD-EFGH",
		},
		{
			name: "verification URLs with embedded credentials",
			verificationUri: "https://user:password@auth.diffex.ai/device",
			verificationUriComplete: undefined,
		},
		{
			name: "complete verification URLs on another origin",
			verificationUri: "https://auth.diffex.ai/device",
			verificationUriComplete: "https://attacker.example/device?user_code=ABCD-EFGH",
		},
	])("rejects $name before notifying the UI", async ({ verificationUri, verificationUriComplete }) => {
		const harness = createHarness({
			responses: [
				jsonResponse({
					device_code: "device_secret",
					user_code: "ABCD-EFGH",
					verification_uri: verificationUri,
					...(verificationUriComplete === undefined ? {} : { verification_uri_complete: verificationUriComplete }),
					expires_in: 300,
					interval: 1,
				}),
			],
		});
		const onDeviceAuthorization = vi.fn();

		await expect(harness.auth.login({ onDeviceAuthorization })).rejects.toThrow("invalid response");
		expect(onDeviceAuthorization).not.toHaveBeenCalled();
		expect(harness.storage.session).toBeUndefined();
	});

	it("permits local HTTP verification URLs only with a local API", async () => {
		const harness = createHarness({
			responses: [
				jsonResponse({
					device_code: "device_secret",
					user_code: "ABCD-EFGH",
					verification_uri: "http://api.diffex.test:4175/device",
					verification_uri_complete: "http://api.diffex.test:4175/device?user_code=ABCD-EFGH",
					expires_in: 300,
					interval: 1,
				}),
				jsonResponse({
					access_token: "access_secret",
					refresh_token: "refresh_secret",
					token_type: "Bearer",
					expires_in: 3_600,
				}),
			],
		});
		const localAuth = new HostedDiffexAccountAuth({
			apiOrigin: "http://api.diffex.test:4175",
			dependencies: harness.dependencies,
		});

		await localAuth.login({ onDeviceAuthorization: vi.fn() });
		expect(harness.storage.session?.apiOrigin).toBe("http://api.diffex.test:4175");
	});

	it("reports whether a Diffex account session is stored", async () => {
		const storage = new MemoryAccountStorage({
			version: 1,
			apiOrigin,
			accessToken: "access_secret",
			refreshToken: "refresh_secret",
			tokenType: "Bearer",
			expiresAt: 3_600_000,
		});
		const harness = createHarness({ storage });

		await expect(harness.auth.hasSession()).resolves.toBe(true);
		await storage.delete(apiOrigin);
		await expect(harness.auth.hasSession()).resolves.toBe(false);
	});

	it("refreshes an expiring session before remote logout", async () => {
		const storage = new MemoryAccountStorage({
			version: 1,
			apiOrigin,
			accessToken: "old_access",
			refreshToken: "old_refresh",
			tokenType: "Bearer",
			expiresAt: 10,
		});
		const harness = createHarness({
			storage,
			responses: [
				jsonResponse({
					access_token: "rotated_access",
					refresh_token: "rotated_refresh",
					token_type: "Bearer",
					expires_in: 1_800,
				}),
				jsonResponse({}, 204),
			],
		});

		await expect(harness.auth.logout()).resolves.toEqual({ hadSession: true, remoteConfirmed: true });
		expect(storage.session).toBeUndefined();
		expect(harness.fetch).toHaveBeenCalledTimes(2);
	});

	it("removes local credentials when remote logout is unavailable", async () => {
		const storage = new MemoryAccountStorage({
			version: 1,
			apiOrigin,
			accessToken: "access_secret",
			refreshToken: "refresh_secret",
			tokenType: "Bearer",
			expiresAt: 3_600_000,
		});
		const harness = createHarness({
			storage,
			responses: [jsonResponse({ error: { code: "temporarily_unavailable" } }, 503)],
		});

		await expect(harness.auth.logout()).resolves.toEqual({ hadSession: true, remoteConfirmed: false });
		expect(storage.session).toBeUndefined();
	});
});
