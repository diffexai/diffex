import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runBillingCommand } from "../src/cli/billing-command.ts";
import type { DiffexAccountSession } from "../src/core/account-auth-storage.ts";
import { HostedDiffexAccountAuth } from "../src/core/diffex-account-auth.ts";

const org = "11111111-1111-4111-8111-111111111111";
function fixture(body: unknown) {
	const out = vi.fn(),
		error = vi.fn(),
		readBilling = vi.fn(async () => body);
	return {
		out,
		error,
		readBilling,
		run: (args: string[]) => runBillingCommand(args, { readBilling }, { out, error }),
	};
}
describe("billing commands", () => {
	it("offers help without accessing credentials or the network", async () => {
		const f = fixture(null);
		expect(await f.run(["billing", "--help"])).toBe(0);
		expect(await f.run(["billing", "delete"])).toBe(2);
		expect(await f.run(["--help"])).toBeNull();
		expect(f.readBilling).not.toHaveBeenCalled();
	});
	it("prints only allowlisted billing fields as JSON", async () => {
		const f = fixture({ organization_id: org, subscription: null, secret: "private" });
		expect(await f.run(["billing", "status", "--json"])).toBe(0);
		expect(f.readBilling).toHaveBeenCalledWith("subscription");
		expect(f.out).toHaveBeenCalledWith(`${JSON.stringify({ organization_id: org, subscription: null })}\n`);
		expect(f.error).not.toHaveBeenCalled();
	});
	it("renders confirmed subscription state without credentials", async () => {
		const f = fixture({
			organization_id: org,
			subscription: {
				id: org,
				purchase: { plan_key: "fixture_plan", plan_revision: 1 },
				status: "active",
				current_period_ends_at: null,
				cancel_at_period_end: true,
			},
		});
		expect(await f.run(["billing", "status"])).toBe(0);
		expect(f.out.mock.calls.flat().join("")).toContain("Status: active");
	});
	it("renders empty and provisional catalogs without invented pricing", async () => {
		const f = fixture({ plans: [] });
		expect(await f.run(["billing", "plans"])).toBe(0);
		expect(f.out).toHaveBeenCalledWith("No purchasable plans are available.\n");
		f.readBilling.mockResolvedValue({ plans: [{ key: "fixture", revision: 1, name: "Test only" }] });
		expect(await f.run(["billing", "plans"])).toBe(0);
		expect(f.out).toHaveBeenLastCalledWith('fixture@1: "Test only"\n');
	});
	it("rejects control sequences and arbitrary server exceptions", async () => {
		const f = fixture({ plans: [{ key: "fixture", revision: 1, name: "\u001b[31mprivate" }] });
		expect(await f.run(["billing", "plans"])).toBe(1);
		f.readBilling.mockRejectedValue(new Error("access_secret"));
		expect(await f.run(["billing", "status"])).toBe(1);
		expect(f.out).not.toHaveBeenCalled();
		expect(JSON.stringify(f.error.mock.calls)).not.toMatch(/private|access_secret/u);
	});
	it("refreshes a stored account token before a bounded bearer request", async () => {
		let session: DiffexAccountSession | undefined = {
			version: 1,
			apiOrigin: "https://api.diffex.ai",
			accessToken: "old",
			refreshToken: "old_refresh",
			expiresAt: 0,
			tokenType: "Bearer",
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "new",
					refresh_token: "new_refresh",
					token_type: "Bearer",
					expires_in: 3600,
				}),
			)
			.mockImplementationOnce(async () => {
				expect(session?.refreshToken).toBe("new_refresh");
				return Response.json({ organization_id: org, subscription: null });
			});
		const client = new HostedDiffexAccountAuth({
			dependencies: {
				fetch,
				now: () => 1,
				sleep: async () => {},
				storage: {
					read: async () => session,
					write: async (value) => {
						session = value;
					},
					delete: async () => {
						session = undefined;
					},
				},
			},
		});
		await client.readBilling("subscription");
		expect(fetch.mock.calls[0][1].redirect).toBe("error");
		expect(fetch.mock.calls[1][1]).toMatchObject({
			method: "GET",
			redirect: "error",
			headers: { authorization: "Bearer new", "cache-control": "no-store" },
		});
	});
	it("does not follow an HTTP redirect with a stored account credential", async () => {
		let redirectedRequests = 0;
		const server = createServer((request, response) => {
			if (request.url === "/v1/billing/subscription") response.writeHead(307, { location: "/capture" }).end();
			else {
				redirectedRequests++;
				response.end("{}");
			}
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing listener");
		const apiOrigin = `http://127.0.0.1:${address.port}`;
		const client = new HostedDiffexAccountAuth({
			apiOrigin,
			dependencies: {
				fetch: globalThis.fetch,
				now: () => 1,
				sleep: async () => {},
				storage: {
					read: async () => ({
						version: 1,
						apiOrigin,
						accessToken: "private_access",
						refreshToken: "private_refresh",
						expiresAt: 3600000,
						tokenType: "Bearer",
					}),
					write: async () => {},
					delete: async () => {},
				},
			},
		});
		try {
			await expect(client.readBilling("subscription")).rejects.toThrow("Unable to read Diffex billing");
			expect(redirectedRequests).toBe(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
