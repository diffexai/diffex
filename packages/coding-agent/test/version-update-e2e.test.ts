import { describe, expect, it } from "vitest";
import { endpoint, installed, type RecordedEvent, reproduce } from "./fixtures/version-update-client.ts";

function versionRequests(events: RecordedEvent[]) {
	return events.filter((event) => event.type === "request" && event.url === endpoint);
}

// The source CLI must reject untrusted targets before dispatching package commands.
describe.skipIf(process.platform === "win32")("version discovery through the source CLI", () => {
	it("contacts only the canonical authority with redirects disabled", async () => {
		const result = await reproduce({ packageName: "@diffexai/diffex" });
		expect(result.code, result.output).toBe(0);
		expect(result.events.filter((event) => event.type === "request")).toEqual([
			{
				type: "request",
				url: endpoint,
				method: "GET",
				userAgent: expect.stringMatching(/^diffex\//),
				redirect: "manual",
			},
		]);
	});

	it.each([
		{
			name: "no published release",
			status: 404,
			response: '{"error":"no_published_release"}',
			requests: 1,
			message: "No published Diffex release is available yet.",
		},
		{
			name: "service unavailable",
			status: 503,
			response: '{"error":"release_unavailable"}',
			requests: 3,
			message: "Diffex update service is unavailable.",
		},
		{
			name: "unrelated not found",
			status: 404,
			response: '{"error":"not_found"}',
			requests: 1,
			message: "Diffex update service is unavailable.",
		},
		{
			name: "invalid JSON",
			status: 200,
			response: "{",
			requests: 1,
			message: "Diffex update service is unavailable.",
		},
		{
			name: "missing identity",
			status: 200,
			response: '{"version":"9999.0.0"}',
			requests: 1,
			message: "Refusing self-update",
		},
		{
			name: "unexpected note",
			status: 200,
			response: '{"version":"9999.0.0","packageName":"@diffexai/diffex","note":"unverified note"}',
			requests: 1,
			message: "Refusing self-update",
		},
		{
			name: "foreign redirect",
			status: 302,
			response: "{}",
			redirect: "https://unreviewed.invalid/latest",
			requests: 1,
			message: "Diffex update service is unavailable.",
		},
	])("reports $name without package mutation, including force", async ({ requests, message, ...options }) => {
		const result = await reproduce({ ...options, force: true });
		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain(message);
		expect(versionRequests(result.events)).toHaveLength(requests);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
	});

	it.each(["0.0.0", installed.version])("does not install an older or equal release %s", async (version) => {
		const result = await reproduce({ packageName: "@diffexai/diffex", version });
		expect(result.code, result.output).toBe(0);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("already up to date");
	});

	it.each([false, true])("rejects foreign packages before any command with force=%s", async (force) => {
		const result = await reproduce({ force });
		expect(result.code, result.output).toBe(1);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("Refusing self-update: expected a stable @diffexai/diffex release.");
	});

	it.each([false, true])("pins canonical installation without uninstall with force=%s", async (force) => {
		const result = await reproduce({ force, packageName: "@diffexai/diffex" });
		expect(result.code, result.output).toBe(0);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([
			{
				type: "spawn",
				command: "npm",
				args: [
					"--prefix",
					result.prefix,
					"install",
					"-g",
					"--ignore-scripts",
					"--min-release-age=0",
					`@diffexai/diffex@${force ? installed.version : "9999.0.0"}`,
				],
			},
		]);
	});

	it.each([
		"npm:foreign@1.2.3",
		"https://example.invalid/install.tgz",
		"1.2.3-beta.1",
		"1.2.3+build",
		"v1.2.3",
		"01.2.3",
		"9007199254740992.0.0",
	])("rejects unsafe version %s even with force", async (version) => {
		const result = await reproduce({ force: true, packageName: "@diffexai/diffex", version });
		expect(result.code, result.output).toBe(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("Refusing self-update");
	});

	it.each([false, true])("offline suppresses manual discovery and commands with force=%s", async (force) => {
		const result = await reproduce({ offline: true, force });
		expect(result.code, result.output).toBe(1);
		expect(result.events).toEqual([]);
		expect(result.output).toContain("Could not determine latest diffex version.");
	});

	it("automatic opt-out permits manual discovery but cannot bypass package validation", async () => {
		const result = await reproduce({ skip: true });
		expect(result.code, result.output).toBe(1);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
	});

	it("manual network failure retries twice without attempting package mutation", async () => {
		const result = await reproduce({ failure: true });
		expect(result.code, result.output).toBe(1);
		expect(versionRequests(result.events)).toHaveLength(3);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("Diffex update service is unavailable: controlled network failure");
	});

	it.each([
		{ name: "foreign response", expectedRequests: 1 },
		{ name: "canonical response", packageName: "@diffexai/diffex", expectedRequests: 1 },
		{ name: "offline", offline: true, expectedRequests: 0 },
		{ name: "automatic opt-out", skip: true, expectedRequests: 0 },
		{ name: "network failure", failure: true, expectedRequests: 1 },
		{ name: "no release", status: 404, response: '{"error":"no_published_release"}', expectedRequests: 1 },
		{ name: "service failure", status: 503, response: '{"error":"release_unavailable"}', expectedRequests: 1 },
	])("interactive startup stays quiet for $name", async ({ expectedRequests, ...options }) => {
		const result = await reproduce({ ...options, interactive: true });
		expect(result.code, result.output).toBe(0);
		expect(result.quitSent).toBe(true);
		expect(versionRequests(result.events)).toHaveLength(expectedRequests);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).not.toContain("New version");
		expect(result.output).not.toContain("Could not determine latest");
		expect(result.output).not.toContain("controlled network failure");
		expect(result.output).not.toContain("update service");
		expect(result.output).not.toContain("No published Diffex release");
		expect(result.output).not.toContain("Refusing self-update");
	});
});
