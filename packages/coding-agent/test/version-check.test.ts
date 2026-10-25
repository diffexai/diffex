import { readFileSync } from "node:fs";
import { MockAgent, fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewDiffexVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestDiffexRelease,
	getLatestDiffexVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const endpoint = "https://api.diffex.ai/api/latest-version";
const release = { version: "1.2.4", packageName: "@diffexai/diffex" };
const fixtures = JSON.parse(
	readFileSync(new URL("../../../scripts/fixtures/release-contract.json", import.meta.url), "utf8"),
) as { responses: { name: string; status: number; body: unknown; valid: boolean }[] };

beforeEach(() => {
	allowNetwork();
	vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it.each(["1.2.4", "1.2.5"])("does not notify callers at %s about equal or older versions", async (current) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(release)),
		);
		await expect(checkForNewDiffexVersion(current)).resolves.toBeUndefined();
	});

	it("returns only validated newer versions", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(release)),
		);
		await expect(checkForNewDiffexVersion("1.2.3")).resolves.toEqual(release);
	});

	it("uses only the Diffex authority with a user agent and no credentials or redirects", async () => {
		const fetchMock = vi.fn(async () => Response.json(release));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(endpoint, {
			redirect: "manual",
			credentials: "omit",
			cache: "no-store",
			headers: { "User-Agent": expect.stringMatching(/^diffex\/1\.2\.3 /), accept: "application/json" },
			signal: expect.any(AbortSignal),
		});
	});

	it.each(fixtures.responses)("enforces the shared HTTP fixture: $name", async (fixture) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(fixture.body, { status: fixture.status })),
		);
		if (fixture.valid) {
			await expect(getLatestDiffexRelease("0.0.0")).resolves.toEqual(fixture.body);
		} else {
			await expect(getLatestDiffexRelease("0.0.0")).rejects.toThrow();
			await expect(checkForNewDiffexVersion("0.0.0")).resolves.toBeUndefined();
		}
	});

	it.each(["9007199254740992.0.0", "1.9007199254740992.0", "1.2.9007199254740992"])(
		"rejects unsupported semver numeric ranges: %s",
		async (version) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ ...release, version })),
			);
			await expect(getLatestDiffexRelease("1.2.3")).rejects.toMatchObject({ reason: "invalid-release" });
		},
	);

	it("does not consume notes outside the current HTTP contract", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ...release, note: "**Read this**" })),
		);
		await expect(getLatestDiffexRelease("1.2.3")).rejects.toMatchObject({ reason: "invalid-release" });
	});

	it("reports the exact no-release response without retries", async () => {
		const fetchMock = vi.fn(async () => Response.json({ error: "no_published_release" }, { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexRelease("1.2.3", { retry: true })).rejects.toMatchObject({ reason: "no-release" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each(
		[null, [], {}, { error: "not_found" }, { error: "no_published_release", extra: true }, release].map((body) => ({
			body,
		})),
	)("does not mistake an unrelated 404 for an absent release: $body", async ({ body }) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(body, { status: 404 })),
		);
		await expect(getLatestDiffexRelease("1.2.3")).rejects.toMatchObject({ reason: "unavailable" });
	});

	it.each([200, 404])("reports invalid JSON as unavailable for HTTP %s", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("<private origin error>", { status, headers: { "Content-Type": "application/json" } }),
			),
		);
		await expect(getLatestDiffexRelease("1.2.3")).rejects.toMatchObject({ reason: "unavailable" });
		await expect(checkForNewDiffexVersion("1.2.3")).resolves.toBeUndefined();
	});

	it.each([undefined, "text/html", "text/plain", "application/json-malformed"])(
		"rejects unexpected content type %s",
		async (contentType) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify(release), {
							headers: contentType ? { "Content-Type": contentType } : {},
						}),
				),
			);
			await expect(getLatestDiffexRelease("1.2.3")).rejects.toMatchObject({ reason: "unavailable" });
		},
	);

	it("accepts JSON content type with charset parameters", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(release, { headers: { "Content-Type": "application/json; charset=utf-8" } })),
		);
		await expect(getLatestDiffexRelease("1.2.3")).resolves.toEqual(release);
	});

	it.each([201, 204, 206, 304, 401, 403, 405, 500, 503])("rejects HTTP %s with no fallback", async (status) => {
		const fetchMock = vi.fn(async () => new Response(null, { status }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexRelease("1.2.3")).rejects.toMatchObject({ reason: "unavailable" });
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(endpoint, expect.anything());
	});

	it.each([301, 302, 303, 307, 308])(
		"does not forward HTTP %s to another origin in the real fetch implementation",
		async (status) => {
			const dispatcher = new MockAgent();
			dispatcher.disableNetConnect();
			const foreignRequest = vi.fn(() => JSON.stringify(release));
			dispatcher
				.get("https://api.diffex.ai")
				.intercept({ path: "/api/latest-version" })
				.reply(status, "", { headers: { location: "https://unreviewed.invalid/latest" } });
			dispatcher.get("https://unreviewed.invalid").intercept({ path: "/latest" }).reply(200, foreignRequest);
			const fetchMock = vi.fn((input: string, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				new Headers(init?.headers).forEach((value, key) => {
					headers[key] = value;
				});
				return undiciFetch(input, {
					headers,
					redirect: init?.redirect,
					signal: init?.signal,
					dispatcher,
				});
			});
			vi.stubGlobal("fetch", fetchMock);
			try {
				await expect(getLatestDiffexRelease("1.2.3", { retry: true })).rejects.toMatchObject({
					reason: "unavailable",
				});
				expect(fetchMock).toHaveBeenCalledOnce();
				expect(foreignRequest).not.toHaveBeenCalled();
				expect(dispatcher.pendingInterceptors()).toHaveLength(1);
			} finally {
				await dispatcher.close();
			}
		},
	);

	it("also rejects same-origin redirects without following them", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "/other-release" } }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexRelease("1.2.3", { retry: true })).rejects.toMatchObject({ reason: "unavailable" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("retries a transient version request only when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(Response.json(release));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexRelease("1.2.3", { retry: true })).resolves.toEqual(release);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("bounds manual HTTP retries and shares one ten-second budget", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexRelease("1.2.3", { retry: true })).rejects.toMatchObject({ reason: "unavailable" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(10000);
		expect(new Set(fetchMock.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
	});

	it("stops retrying as soon as the shared timeout expires", async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const fetchMock = vi.fn(async () => {
			controller.abort(new DOMException("Timed out", "TimeoutError"));
			controller.signal.throwIfAborted();
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(getLatestDiffexRelease("1.2.3", { retry: true })).rejects.toThrow("Timed out");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("keeps automatic checks quiet and bounded when the response body times out", async () => {
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const response = new Response(
				new ReadableStream({
					start(stream) {
						init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
			queueMicrotask(() => controller.abort(new DOMException("Timed out", "TimeoutError")));
			return response;
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewDiffexVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(timeout).toHaveBeenCalledExactlyOnceWith(10000);
	});

	it("keeps automatic version checks to one request on transport failure", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewDiffexVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});
		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("skips all API calls while offline", async () => {
		vi.stubEnv("DIFFEX_OFFLINE", "1");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewDiffexVersion("1.2.3")).resolves.toBeUndefined();
		await expect(getLatestDiffexRelease("1.2.3", { retry: true })).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips only automatic calls when automatic version checks are disabled", async () => {
		vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
		const fetchMock = vi.fn(async () => Response.json(release));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewDiffexVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		await expect(getLatestDiffexVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
