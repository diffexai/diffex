import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endpoint, installed, type RecordedEvent, reproduce } from "./fixtures/version-update-client.ts";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const [checkpoint] = [...changelog.matchAll(/^## \[([0-9]+\.[0-9]+\.[0-9]+)\]/gm)].map((match) => match[1]);

function expectCanonicalRequest(events: RecordedEvent[]) {
	expect(events.filter((event) => event.type === "request")).toEqual([
		{
			type: "request",
			url: endpoint,
			method: "GET",
			userAgent: expect.stringMatching(/^diffex\//),
			redirect: "manual",
		},
	]);
}

// Keep real startup and dispatch coverage here; response permutations live in package-command-paths.test.ts.
describe.skipIf(process.platform === "win32")("version discovery through the source CLI", () => {
	let sharedTempDir: string;
	let cacheFiles = new Map<string, number>();

	beforeAll(() => {
		sharedTempDir = mkdtempSync(join(tmpdir(), "diffex-version-suite-"));
		expect(readdirSync(sharedTempDir)).toEqual([]);
	});

	afterEach(() => {
		// Every child has exited and removed its own application state. Only tsx's compiler cache survives.
		const cacheDirectories = readdirSync(sharedTempDir);
		expect(cacheDirectories.length).toBeGreaterThan(0);
		const nextCacheFiles = new Map<string, number>();
		for (const directory of cacheDirectories) {
			expect(directory).toMatch(/^tsx-/);
			for (const entry of readdirSync(join(sharedTempDir, directory), { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const path = join(sharedTempDir, directory, entry.name);
				nextCacheFiles.set(path, statSync(path).mtimeMs);
			}
		}
		expect(nextCacheFiles.size).toBeGreaterThan(0);
		for (const [path, modified] of cacheFiles) expect(nextCacheFiles.get(path), path).toBe(modified);
		cacheFiles = nextCacheFiles;
	});

	afterAll(() => {
		rmSync(sharedTempDir, { recursive: true, force: true });
		expect(existsSync(sharedTempDir)).toBe(false);
	});

	it.each([
		{ name: "fresh install with a newer release", settings: {}, expectedRequests: 1, showChangelog: false },
		{
			name: "upgrade with legacy telemetry enabled and delayed network failure",
			settings: { lastChangelogVersion: "0.0.0", collapseChangelog: true, enableInstallTelemetry: true },
			changelog: `# Changelog\n\n## [${checkpoint}]\n\n- Controlled upgrade release.\n\n## [0.0.0]\n\n- Previous fixture release.\n`,
			legacyTelemetryEnv: "1",
			delayResponse: true,
			failure: true,
			expectedRequests: 1,
			showChangelog: true,
		},
		{
			name: "current install with automatic checks disabled and provider attribution enabled",
			settings: { lastChangelogVersion: checkpoint, enableProviderAttribution: true },
			providerAttributionEnv: "1",
			skip: true,
			expectedRequests: 0,
			showChangelog: false,
		},
		{
			name: "fresh install offline with automatic checks enabled",
			settings: {},
			offline: true,
			expectedRequests: 0,
			showChangelog: false,
		},
	])("accepts input and exits quietly for $name", async ({ expectedRequests, showChangelog, ...options }) => {
		const result = await reproduce({ ...options, interactive: true, sharedTempDir, packageName: installed.name });
		expect(result.code, result.output).toBe(0);
		expect(result.quitSent).toBe(true);
		expect(result.interactions).toEqual(["ci-ready", "ci-settled"]);
		expect(result.inputBeforeResponse).toBe(options.delayResponse === true);
		expect(result.settings).toEqual({
			theme: "dark",
			packages: [],
			...options.settings,
			lastChangelogVersion: checkpoint,
		});
		if (expectedRequests) {
			expectCanonicalRequest(result.events);
			expect(result.events.filter((event) => event.type === "discovery-settled")).toHaveLength(1);
		} else {
			expect(
				result.events.filter((event) => event.type === "request" || event.type === "discovery-settled"),
			).toEqual([]);
		}
		expect(result.events.filter((event) => event.type === "spawn" || event.type === "spawnSync")).toEqual([
			{ type: "spawnSync", command: "fd", args: ["--version"] },
			{ type: "spawnSync", command: "rg", args: ["--version"] },
		]);
		expect(result.output.includes("What's new"), result.output).toBe(showChangelog);
		expect(result.output.includes("Controlled upgrade release."), result.output).toBe(showChangelog);
		expect(result.output).not.toMatch(
			/New version|Could not determine latest|controlled network failure|update service|No published Diffex release|Refusing self-update/,
		);
	});

	it("installs the exact canonical newer version after automatic opt-out without uninstalling", async () => {
		const result = await reproduce({ sharedTempDir, skip: true, packageName: installed.name });
		expect(result.code, result.output).toBe(0);
		expectCanonicalRequest(result.events);
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
					`${installed.name}@9999.0.0`,
				],
			},
		]);
		expect(result.output).toContain(`Updated diffex from ${installed.version} to 9999.0.0`);
		expect(result.settings).toEqual({ theme: "dark", packages: [] });
	});

	it("rejects a foreign package with force before any installation command", async () => {
		const result = await reproduce({ sharedTempDir, force: true });
		expect(result.code, result.output).toBe(1);
		expectCanonicalRequest(result.events);
		expect(result.events.filter((event) => event.type === "spawn" || event.type === "spawnSync")).toEqual([]);
		expect(result.output).toContain("Refusing self-update: expected a stable @diffexai/diffex release.");
		expect(result.settings).toEqual({ theme: "dark", packages: [] });
	});

	it("suppresses manual discovery and installation with force while offline", async () => {
		const result = await reproduce({ sharedTempDir, offline: true, force: true });
		expect(result.code, result.output).toBe(1);
		expect(result.events).toEqual([]);
		expect(result.output).toContain("Could not determine latest diffex version.");
		expect(result.settings).toEqual({ theme: "dark", packages: [] });
	});
});
