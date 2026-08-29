import { describe, expect, it, vi } from "vitest";
import {
	type AccountAuthCommand,
	type AccountAuthCommandDependencies,
	executeAccountAuthCommand,
	parseAccountAuthCommand,
} from "../src/cli/account-auth-command.ts";
import type { DiffexAccountAuthStorage, DiffexAccountSession } from "../src/core/account-auth-storage.ts";

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
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function command(kind: AccountAuthCommand["kind"]): AccountAuthCommand {
	return { kind, apiOrigin, noBrowser: false, json: false };
}

function dependencies(input: { responses?: Response[]; storage?: MemoryAccountStorage; now?: { value: number } }) {
	const responses = [...(input.responses ?? [])];
	const storage = input.storage ?? new MemoryAccountStorage();
	const now = input.now ?? { value: 0 };
	const output: string[] = [];
	const fetch = vi.fn<AccountAuthCommandDependencies["fetch"]>(async () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected request");
		return response;
	});
	const result: AccountAuthCommandDependencies = {
		fetch,
		storage,
		openBrowser: vi.fn(),
		writeLine: (line) => output.push(line),
		now: () => now.value,
		sleep: vi.fn(async (milliseconds) => {
			now.value += milliseconds;
		}),
	};
	return { dependencies: result, fetch, now, output, storage };
}

describe("Diffex account auth commands", () => {
	it("parses account commands without changing provider auth commands", () => {
		expect(
			parseAccountAuthCommand(["auth", "login", "--api-url", "https://api.staging.diffex.ai", "--no-browser"], {}),
		).toEqual({
			kind: "login",
			apiOrigin: "https://api.staging.diffex.ai",
			noBrowser: true,
			json: false,
		});
		expect(parseAccountAuthCommand(["auth", "check", "--provider", "anthropic"], {})).toBeUndefined();
		expect(() => parseAccountAuthCommand(["auth", "login", "--api-url", "http://attacker.example"], {})).toThrow(
			"HTTPS origin",
		);
	});

	it("completes device auth while keeping device and token secrets out of terminal output", async () => {
		const harness = dependencies({
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

		await expect(executeAccountAuthCommand(command("login"), harness.dependencies)).resolves.toBe(0);
		expect(harness.dependencies.openBrowser).toHaveBeenCalledWith(
			"https://auth.diffex.ai/device?user_code=ABCD-EFGH",
		);
		expect(harness.storage.session).toMatchObject({
			apiOrigin,
			accessToken: "access_secret",
			refreshToken: "refresh_secret",
			tokenType: "Bearer",
		});
		const terminal = harness.output.join("\n");
		expect(terminal).toContain("ABCD-EFGH");
		expect(terminal).not.toMatch(/device_secret|access_secret|refresh_secret/u);
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
	])("rejects $name before opening a browser", async ({ verificationUri, verificationUriComplete }) => {
		const harness = dependencies({
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

		await expect(executeAccountAuthCommand(command("login"), harness.dependencies)).rejects.toThrow(
			"invalid response",
		);
		expect(harness.dependencies.openBrowser).not.toHaveBeenCalled();
		expect(harness.storage.session).toBeUndefined();
	});

	it("permits local HTTP verification URLs only with a local API", async () => {
		const harness = dependencies({
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
		const localCommand = {
			...command("login"),
			apiOrigin: "http://api.diffex.test:4175",
			noBrowser: true,
		};

		await expect(executeAccountAuthCommand(localCommand, harness.dependencies)).resolves.toBe(0);
		expect(harness.dependencies.openBrowser).not.toHaveBeenCalled();
		expect(harness.storage.session?.apiOrigin).toBe("http://api.diffex.test:4175");
	});

	it("rotates an expiring refresh token before reporting signed-in status", async () => {
		const storage = new MemoryAccountStorage({
			version: 1,
			apiOrigin,
			accessToken: "old_access",
			refreshToken: "old_refresh",
			tokenType: "Bearer",
			expiresAt: 10,
		});
		const harness = dependencies({
			storage,
			responses: [
				jsonResponse({
					access_token: "rotated_access",
					refresh_token: "rotated_refresh",
					token_type: "Bearer",
					expires_in: 1_800,
				}),
			],
		});
		const statusCommand = { ...command("status"), json: true };

		await expect(executeAccountAuthCommand(statusCommand, harness.dependencies)).resolves.toBe(0);
		expect(storage.session?.refreshToken).toBe("rotated_refresh");
		expect(harness.output).toHaveLength(1);
		expect(harness.output[0]).toContain('"status":"signed_in"');
		expect(harness.output[0]).not.toMatch(/old_|rotated_/u);
	});

	it("removes local credentials even when remote logout is unavailable", async () => {
		const storage = new MemoryAccountStorage({
			version: 1,
			apiOrigin,
			accessToken: "access_secret",
			refreshToken: "refresh_secret",
			tokenType: "Bearer",
			expiresAt: 3_600_000,
		});
		const harness = dependencies({
			storage,
			responses: [jsonResponse({ error: { code: "temporarily_unavailable" } }, 503)],
		});

		await expect(executeAccountAuthCommand(command("logout"), harness.dependencies)).rejects.toThrow(
			"Local credentials were removed",
		);
		expect(storage.session).toBeUndefined();
		expect(harness.output).toEqual(["Signed out of Diffex."]);
	});
});
