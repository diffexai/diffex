import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { createSubagentServices } from "../../src/core/subagents/services.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const SUBAGENT_SYSTEM_PROMPT = [
	"You are a subagent working on a focused task delegated by a parent agent.",
	"Work independently in the shared working directory and return a concise, complete result to the parent.",
	"You do not have access to the parent's transcript unless it is included in your task.",
	"Do not attempt to create or coordinate other agents.",
	"Other agents may use the same filesystem, so avoid unrelated edits and report files you change.",
].join("\n");

interface ResourceFixture {
	projectDir: string;
	agentDir: string;
	configuredExtensionPath: string;
	appendSystemPromptPath: string;
}

function createResourceFixture(harness: Harness): ResourceFixture {
	const projectDir = join(harness.tempDir, "workspace", "project");
	const agentDir = join(harness.tempDir, "agent");
	const projectConfigDir = join(projectDir, ".diffex");
	const configuredExtensionPath = join(projectConfigDir, "extensions", "configured.ts");
	const appendSystemPromptPath = join(projectConfigDir, "APPEND_SYSTEM.md");
	mkdirSync(join(projectConfigDir, "extensions"), { recursive: true });
	mkdirSync(join(projectConfigDir, "skills", "focused-skill"), { recursive: true });
	mkdirSync(join(projectConfigDir, "skills", "invalid-skill"), { recursive: true });
	mkdirSync(join(projectConfigDir, "prompts"), { recursive: true });
	mkdirSync(join(projectConfigDir, "themes"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		configuredExtensionPath,
		`export default function(pi) {
	pi.registerCommand("configured-command", {
		description: "Configured command",
		handler: async () => {},
	});
}`,
	);
	writeFileSync(
		join(projectConfigDir, "skills", "focused-skill", "SKILL.md"),
		`---
name: focused-skill
description: Supports focused work
---
Focused instructions.`,
	);
	writeFileSync(
		join(projectConfigDir, "skills", "invalid-skill", "SKILL.md"),
		`---
name: invalid-skill
---
Missing description.`,
	);
	writeFileSync(
		join(projectConfigDir, "prompts", "root-prompt.md"),
		`---
description: Root prompt
---
Root prompt content.`,
	);
	const theme = JSON.parse(
		readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
	) as Record<string, unknown>;
	writeFileSync(join(projectConfigDir, "themes", "root-theme.json"), JSON.stringify({ ...theme, name: "root-theme" }));
	writeFileSync(join(projectDir, "AGENTS.md"), "Project agent instructions.");
	writeFileSync(join(projectConfigDir, "SYSTEM.md"), "Project system prompt.");
	writeFileSync(appendSystemPromptPath, "Project append prompt.");
	return { projectDir, agentDir, configuredExtensionPath, appendSystemPromptPath };
}

describe("createSubagentServices", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function setup() {
		const harness = await createHarness();
		harnesses.push(harness);
		const fixture = createResourceFixture(harness);
		const parent = await createAgentSessionServices({
			cwd: fixture.projectDir,
			agentDir: fixture.agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerCommand("inline-command", {
							description: "Inline command",
							handler: async () => {},
						});
					},
				],
			},
		});
		return { harness, fixture, parent };
	}

	it("isolates child resources while preserving contextual resources", async () => {
		const { harness, fixture, parent } = await setup();
		const [first, second] = await Promise.all([
			createSubagentServices({
				cwd: fixture.projectDir,
				agentDir: fixture.agentDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
			}),
			createSubagentServices({
				cwd: fixture.projectDir,
				agentDir: fixture.agentDir,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
			}),
		]);

		expect(parent.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
			fixture.configuredExtensionPath,
			"<inline:1>",
		]);
		expect(parent.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("root-prompt");
		expect(parent.resourceLoader.getThemes().themes.map((theme) => theme.name)).toContain("root-theme");
		for (const child of [first, second]) {
			expect(child.modelRuntime).toBe(parent.modelRuntime);
			expect(child.settingsManager).toBe(parent.settingsManager);
			expect(child.resourceLoader).not.toBe(parent.resourceLoader);
			expect(child.resourceLoader.getExtensions().extensions).toEqual([]);
			expect(child.resourceLoader.getPrompts().prompts).toEqual([]);
			expect(child.resourceLoader.getThemes().themes).toEqual([]);
			expect(child.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain("focused-skill");
			expect(child.resourceLoader.getAgentsFiles().agentsFiles).toContainEqual({
				path: join(fixture.projectDir, "AGENTS.md"),
				content: "Project agent instructions.",
			});
			expect(child.resourceLoader.getSystemPrompt()).toBe("Project system prompt.");
			expect(child.resourceLoader.getAppendSystemPrompt()).toEqual([
				"Project append prompt.",
				SUBAGENT_SYSTEM_PROMPT,
			]);
			expect(child.resourceLoader.getAppendSystemPromptSources()).toEqual([
				{ path: fixture.appendSystemPromptPath },
			]);
		}
		expect(first.resourceLoader).not.toBe(second.resourceLoader);
		const parentRuntime = parent.resourceLoader.getExtensions().runtime;
		const firstRuntime = first.resourceLoader.getExtensions().runtime;
		const secondRuntime = second.resourceLoader.getExtensions().runtime;
		expect(firstRuntime).not.toBe(parentRuntime);
		expect(firstRuntime).not.toBe(secondRuntime);
		firstRuntime.flagValues.set("first-only", true);
		expect(parentRuntime.flagValues.has("first-only")).toBe(false);
		expect(secondRuntime.flagValues.has("first-only")).toBe(false);
	});

	it("preserves shared settings and avoids reload and refresh side effects", async () => {
		const { harness, fixture } = await setup();
		harness.settingsManager.applyOverrides({ defaultModel: "in-memory-model" });
		const reloadSettings = vi.spyOn(harness.settingsManager, "reload");
		const refreshModels = vi.spyOn(harness.session.modelRuntime, "refresh");

		const children = await Promise.all(
			Array.from({ length: 4 }, () =>
				createSubagentServices({
					cwd: fixture.projectDir,
					agentDir: fixture.agentDir,
					modelRuntime: harness.session.modelRuntime,
					settingsManager: harness.settingsManager,
				}),
			),
		);
		await Promise.all(children.map((child) => child.resourceLoader.reload()));

		expect(reloadSettings).not.toHaveBeenCalled();
		expect(refreshModels).not.toHaveBeenCalled();
		expect(harness.settingsManager.getDefaultModel()).toBe("in-memory-model");
		expect(new Set(children.map((child) => child.resourceLoader)).size).toBe(children.length);
		expect(new Set(children.map((child) => child.resourceLoader.getExtensions().runtime)).size).toBe(children.length);
		expect(children.every((child) => child.resourceLoader.getExtensions().extensions.length === 0)).toBe(true);
	});

	it("normalizes paths and returns resource diagnostics without printing", async () => {
		const { harness, fixture } = await setup();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const cwd = join(fixture.projectDir, "nested", "..");
		const agentDir = join(fixture.agentDir, ".");
		const child = await createSubagentServices({
			cwd,
			agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
		});
		const generic = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				reloadSettings: false,
			},
		});

		expect(child.cwd).toBe(generic.cwd);
		expect(child.agentDir).toBe(generic.agentDir);
		expect(child.cwd).toBe(resolve(fixture.projectDir));
		expect(child.agentDir).toBe(resolve(fixture.agentDir));
		expect(child.resourceLoader.getSkills().diagnostics).toContainEqual({
			type: "warning",
			message: "description is required",
			path: join(fixture.projectDir, ".diffex", "skills", "invalid-skill", "SKILL.md"),
		});
		expect(child.diagnostics).toEqual([]);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
