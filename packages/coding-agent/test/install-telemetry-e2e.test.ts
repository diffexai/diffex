import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { endpoint, installed, reproduce } from "./fixtures/version-update-client.ts";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const [checkpoint, previousCheckpoint] = [...changelog.matchAll(/^## \[([0-9]+\.[0-9]+\.[0-9]+)\]/gm)].map(
	(match) => match[1],
);

// Run the real CLI in a PTY with isolated settings and all outbound traffic intercepted.
describe.skipIf(process.platform === "win32")("interactive startup without install reporting", () => {
	it.each([
		{ name: "first install", settings: {} },
		{ name: "upgrade", settings: { lastChangelogVersion: previousCheckpoint, collapseChangelog: true } },
		{ name: "current install", settings: { lastChangelogVersion: checkpoint } },
		{ name: "legacy opt-in", settings: { enableInstallTelemetry: true }, legacyTelemetryEnv: "1" },
		{ name: "legacy opt-out", settings: { enableInstallTelemetry: false }, legacyTelemetryEnv: "0" },
		{
			name: "provider attribution opt-in",
			settings: { enableProviderAttribution: true },
			providerAttributionEnv: "1",
		},
		{ name: "offline", settings: {}, offline: true },
		{ name: "version check enabled", settings: {}, skip: false },
	])("never sends an install report for $name", async ({ name: _name, ...options }) => {
		const result = await reproduce({ interactive: true, skip: true, packageName: installed.name, ...options });
		expect(result.code, result.output).toBe(0);
		expect(result.quitSent).toBe(true);
		expect(result.settings.lastChangelogVersion).toBe(checkpoint);
		expect(result.events.filter((event) => event.type === "request").map((event) => event.url)).toEqual(
			options.skip === false ? [endpoint] : [],
		);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
	});
});
