import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessWorkspace } from "../src/core/harness-state-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createEvolvedSkillCatalog, createSkill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(label: string): string {
	const path = join(tmpdir(), `diffex-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(path, { recursive: true });
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function skillContent(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

describe("evolved skill catalogs", () => {
	it("includes only artifacts for the exact active workspace", async () => {
		const cwd = createTemporaryDirectory("evolved-scope");
		const agentDir = createTemporaryDirectory("evolved-agent");
		const active = await resolveHarnessWorkspace(cwd);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const reference = "# Scoped review checklist\n";
		const bundle = await store.saveVersion(
			{
				memory: "Scoped memory.\n",
				skills: [
					{
						path: "skills/scoped-review/SKILL.md",
						content: skillContent("scoped-review", "Review changes in this workspace."),
						workspace: active.workspace,
						files: [{ path: "references/checklist.md", content: reference }],
					},
				],
			},
			root.manifest.version,
		);

		const matching = createEvolvedSkillCatalog(bundle, active.workspace);
		expect(matching.diagnostics).toEqual([]);
		expect(matching.skills).toEqual([
			expect.objectContaining({
				name: "scoped-review",
				sourceKind: "evolved",
				scope: "workspace",
				version: bundle.state.skills[0]?.packageVersion,
				contentDigest: bundle.state.skills[0]?.contentHash,
				harnessRevision: bundle.manifest.version,
				filePath: bundle.state.skills[0]?.filePath,
			}),
		]);
		const evolved = matching.skills[0];
		if (evolved === undefined) throw new Error("Expected evolved skill");
		expect(readFileSync(join(evolved.baseDir, "references", "checklist.md"), "utf8")).toBe(reference);

		const mismatched = createEvolvedSkillCatalog(bundle, {
			repositoryId: active.workspace.repositoryId,
			directoryId: "different-directory",
		});
		expect(mismatched.skills).toEqual([]);
		expect(mismatched.diagnostics[0]).toMatchObject({
			type: "warning",
			path: bundle.state.skills[0]?.filePath,
		});
		expect(mismatched.diagnostics[0]?.message).toContain("does not match the active workspace");
	});

	it("keeps the harness overlay across reloads and disambiguates installed names", async () => {
		const cwd = createTemporaryDirectory("evolved-overlay");
		const agentDir = createTemporaryDirectory("evolved-overlay-agent");
		const active = await resolveHarnessWorkspace(cwd);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const bundle = await store.saveVersion(
			{
				memory: "Overlay memory.\n",
				skills: [
					{
						path: "skills/shared-name/SKILL.md",
						content: skillContent("shared-name", "Use the evolved workflow."),
						workspace: active.workspace,
					},
				],
			},
			root.manifest.version,
		);
		const installedPath = join(agentDir, "installed", "shared-name", "SKILL.md");
		mkdirSync(dirname(installedPath), { recursive: true });
		writeFileSync(installedPath, skillContent("shared-name", "Use the installed workflow."));
		const installed = createSkill({
			name: "shared-name",
			description: "Use the installed workflow.",
			filePath: installedPath,
			baseDir: dirname(installedPath),
			sourceInfo: createSyntheticSourceInfo(installedPath, { source: "test-installed" }),
			content: skillContent("shared-name", "Use the installed workflow."),
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			skillsOverride: () => ({ skills: [installed], diagnostics: [] }),
		});
		await loader.reload();
		loader.setEvolvedSkills(createEvolvedSkillCatalog(bundle, active.workspace));

		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["shared-name-Evolved", "shared-name"]);
		expect(loader.getSkills().diagnostics.some((diagnostic) => diagnostic.type === "collision")).toBe(true);
		await loader.reload();
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["shared-name-Evolved", "shared-name"]);
		expect(loader.getSkills().skills[0]?.harnessRevision).toBe(bundle.manifest.version);
	});
});
