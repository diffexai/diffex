import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDiffexManifest } from "../src/core/diffex-manifest.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { loadTaskProfiles } from "../src/core/profiles.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("profile package resources", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	function writeProfile(path: string, id: string, prompt = `${id} prompt`): void {
		mkdirSync(path, { recursive: true });
		writeFileSync(
			join(path, "profile.json"),
			JSON.stringify({
				schemaVersion: 1,
				id,
				name: id,
				description: `${id} tasks`,
				prompt,
				routing: { description: `${id} routing`, examples: [`Do ${id}`], keywords: [id] },
				tools: { default: ["read"], required: [], denied: ["write"] },
				guardrails: {
					highStakes: false,
					requireHumanReview: false,
					requireCurrentSources: false,
					disallowedActions: [],
					instructions: ["State uncertainty."],
				},
			}),
		);
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads profile entries from Diffex package manifests", () => {
		const packageJsonPath = join(tempDir, "package.json");
		writeFileSync(
			packageJsonPath,
			JSON.stringify({ diffex: { profiles: ["profiles/research", "profiles/finance/profile.json"] } }),
		);

		expect(readDiffexManifest(packageJsonPath)?.profiles).toEqual([
			"profiles/research",
			"profiles/finance/profile.json",
		]);

		writeFileSync(packageJsonPath, JSON.stringify({ diffex: { profiles: ["profiles/research", 42] } }));
		expect(readDiffexManifest(packageJsonPath)?.profiles).toBeUndefined();
	});

	it("auto-discovers user and trusted project profile directories", async () => {
		const userProfile = join(agentDir, "profiles", "general", "profile.json");
		const nestedProfile = join(agentDir, "profiles", "general", "nested", "profile.json");
		const projectProfile = join(tempDir, ".diffex", "profiles", "research", "profile.json");
		writeProfile(join(agentDir, "profiles", "general"), "general");
		writeProfile(join(agentDir, "profiles", "general", "nested"), "nested");
		writeProfile(join(tempDir, ".diffex", "profiles", "research"), "research");
		writeFileSync(join(agentDir, "profiles", "ignored.json"), "{}");

		const result = await packageManager.resolve();

		expect(result.profiles.map((resource) => resource.path)).toContain(userProfile);
		expect(result.profiles.map((resource) => resource.path)).toContain(projectProfile);
		expect(result.profiles.map((resource) => resource.path)).not.toContain(nestedProfile);
		expect(result.profiles.find((resource) => resource.path === userProfile)?.metadata.scope).toBe("user");
		expect(result.profiles.find((resource) => resource.path === projectProfile)?.metadata.scope).toBe("project");
	});

	it("uses deterministic profile discovery order for collision winners", async () => {
		const zetaPath = join(agentDir, "profiles", "zeta", "profile.json");
		const alphaPath = join(agentDir, "profiles", "alpha", "profile.json");
		writeProfile(join(agentDir, "profiles", "zeta"), "duplicate", "zeta wins only if discovery is unsorted");
		writeProfile(join(agentDir, "profiles", "alpha"), "duplicate", "alpha wins deterministically");

		const result = await packageManager.resolve();
		const userProfiles = result.profiles.filter((resource) => resource.metadata.scope === "user");
		const loaded = loadTaskProfiles(userProfiles.map((resource) => resource.path));

		expect(userProfiles.map((resource) => resource.path)).toEqual([alphaPath, zetaPath]);
		expect(loaded.registry.get("duplicate")?.prompt).toBe("alpha wins deterministically");
		expect(loaded.diagnostics.find((diagnostic) => diagnostic.type === "collision")?.collision).toEqual({
			id: "duplicate",
			winnerSource: alphaPath,
			loserSource: zetaPath,
		});
	});

	it("applies top-level settings patterns to profile directory names", async () => {
		const enabledProfile = join(agentDir, "profiles", "enabled", "profile.json");
		const disabledProfile = join(agentDir, "profiles", "disabled", "profile.json");
		writeProfile(join(agentDir, "profiles", "enabled"), "enabled");
		writeProfile(join(agentDir, "profiles", "disabled"), "disabled");
		settingsManager.setProfilePaths(["profiles", "!profiles/disabled"]);

		const result = await packageManager.resolve();

		expect(result.profiles.find((resource) => resource.path === enabledProfile)?.enabled).toBe(true);
		expect(result.profiles.find((resource) => resource.path === disabledProfile)?.enabled).toBe(false);
		expect(result.profiles.every((resource) => resource.metadata.source === "local")).toBe(true);
	});

	it("resolves manifest profile directories and exclusions from extension sources", async () => {
		const packageDir = join(tempDir, "manifest-package");
		const researchProfile = join(packageDir, "profiles", "research", "profile.json");
		const financeProfile = join(packageDir, "profiles", "finance", "profile.json");
		writeProfile(join(packageDir, "profiles", "research"), "research");
		writeProfile(join(packageDir, "profiles", "finance"), "finance");
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: "profile-package", diffex: { profiles: ["profiles/*", "!profiles/finance"] } }),
		);

		const result = await packageManager.resolveExtensionSources([packageDir]);

		expect(result.profiles.some((resource) => resource.path === researchProfile && resource.enabled)).toBe(true);
		expect(result.profiles.some((resource) => resource.path === financeProfile)).toBe(false);
	});

	it("applies package filters on top of conventional profile discovery", async () => {
		const packageDir = join(tempDir, "filtered-package");
		const researchProfile = join(packageDir, "profiles", "research", "profile.json");
		const financeProfile = join(packageDir, "profiles", "finance", "profile.json");
		writeProfile(join(packageDir, "profiles", "research"), "research");
		writeProfile(join(packageDir, "profiles", "finance"), "finance");
		settingsManager.setPackages([{ source: packageDir, profiles: ["profiles/research"] }]);

		const result = await packageManager.resolve();

		expect(result.profiles.find((resource) => resource.path === researchProfile)?.enabled).toBe(true);
		expect(result.profiles.find((resource) => resource.path === financeProfile)?.enabled).toBe(false);
	});
});
