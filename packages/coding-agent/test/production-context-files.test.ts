import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Config from "../src/config.ts";
import { DefaultResourceLoader, loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const distribution = vi.hoisted(() => ({ production: true }));
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	get IS_PRODUCTION_DISTRIBUTION() {
		return distribution.production;
	},
}));

describe("production default context files", () => {
	let directory: string;
	let packageDir: string;
	let agentDir: string;
	let cwd: string;
	let defaultPath: string;
	const instructions = readFileSync(new URL("../../../AGENTS_release.md", import.meta.url), "utf8");

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "diffex-production-context-"));
		packageDir = join(directory, "package");
		agentDir = join(directory, "agent");
		cwd = join(directory, "project");
		for (const path of [join(packageDir, "dist"), agentDir, cwd]) mkdirSync(path, { recursive: true });
		defaultPath = join(packageDir, "dist", "AGENTS.md");
		writeFileSync(defaultPath, instructions);
		vi.stubEnv("DIFFEX_PACKAGE_DIR", packageDir);
		distribution.production = true;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("loads the shipped AGENTS.md into a fresh user's prompt without creating user files", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory() });
		await loader.reload();
		expect(loader.getAgentsFiles().agentsFiles[0]).toEqual({ path: defaultPath, content: instructions });
		const prompt = buildSystemPrompt({ cwd, contextFiles: loader.getAgentsFiles().agentsFiles });
		expect(prompt).toContain(`<project_instructions path="${defaultPath}">\n${instructions}`);
		expect(prompt).not.toContain("AGENTS_release.md");
		expect(existsSync(join(agentDir, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
	});

	it("loads defaults before global and project overrides without changing their contents", () => {
		const globalPath = join(agentDir, "AGENTS.md");
		const projectPath = join(cwd, "AGENTS.override.md");
		writeFileSync(globalPath, "User instructions");
		writeFileSync(projectPath, "Project override instructions");
		writeFileSync(join(cwd, "AGENTS.md"), "Shadowed project instructions");
		const files = loadProjectContextFiles({ cwd, agentDir });
		expect(files).toEqual([
			{ path: defaultPath, content: instructions },
			{ path: globalPath, content: "User instructions" },
			{ path: projectPath, content: "Project override instructions" },
		]);
		expect(readFileSync(globalPath, "utf8")).toBe("User instructions");
		expect(readFileSync(projectPath, "utf8")).toBe("Project override instructions");
	});

	it("honors noContextFiles for defaults and user context", async () => {
		writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	});

	it("does not load distribution defaults in a development checkout", () => {
		distribution.production = false;
		expect(loadProjectContextFiles({ cwd, agentDir })).toEqual([]);
	});
});
