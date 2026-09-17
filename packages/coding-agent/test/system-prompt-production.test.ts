import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as Config from "../src/config.ts";
import { createSkill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../src/core/system-prompt.ts";

const distribution = vi.hoisted(() => ({ production: true }));
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	get IS_PRODUCTION_DISTRIBUTION() {
		return distribution.production;
	},
}));

const documentation = `Diffex documentation (read the documentation website only when the user asks about Diffex itself, its SDK, extensions, or skills):
- Documentation website: https://diffex.ai/docs/overview/
- When working on Diffex topics, read the docs before implementing`;

describe("production system prompt selection", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "diffex-production-prompt-"));
		vi.stubEnv("DIFFEX_PACKAGE_DIR", directory);
		distribution.production = true;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	test.each([true, false])("uses only website documentation with local docs present: %s", (localDocs) => {
		if (localDocs) {
			mkdirSync(join(directory, "docs"));
			mkdirSync(join(directory, "examples"));
		}
		const prompt = buildSystemPrompt({ cwd: "/project" });
		expect(prompt.slice(prompt.indexOf("Diffex documentation"))).toBe(
			`${documentation}\nCurrent working directory: /project`,
		);
		expect(prompt.match(/Diffex documentation/g)).toHaveLength(1);
		expect(prompt).not.toContain(directory);
	});

	test("keeps local documentation and examples for repository development", () => {
		mkdirSync(join(directory, "docs"));
		mkdirSync(join(directory, "examples"));
		distribution.production = false;
		vi.stubEnv("NODE_ENV", "production");
		const prompt = buildSystemPrompt({ cwd: "/project" });
		expect(prompt).toContain(`Additional docs: ${join(directory, "docs")}`);
		expect(prompt).toContain(`Examples: ${join(directory, "examples")}`);
		expect(prompt).toContain("read the docs and follow .md cross-references before implementing");
		expect(prompt).not.toContain(documentation);
	});

	test.each([undefined, "Custom system prompt."])(
		"preserves tools, appended instructions, memory, context, and skills with custom prompt: %s",
		(customPrompt) => {
			const options: BuildSystemPromptOptions = {
				cwd: "/project",
				customPrompt,
				selectedTools: ["read", "custom_tool"],
				toolSnippets: { read: "Read files", custom_tool: "Inspect project" },
				promptGuidelines: { custom_tool: ["Verify results."] },
				appendSystemPrompt: "Appended instructions.",
				evolutionMemory: { version: "v1", memory: "Remember this." },
				contextFiles: [{ path: "/project/AGENTS.md", content: "Project instructions." }],
				skills: [
					createSkill({
						name: "example",
						description: "Example skill",
						filePath: "/skills/example/SKILL.md",
						baseDir: "/skills/example",
						sourceInfo: createSyntheticSourceInfo("/skills/example/SKILL.md", { source: "test" }),
						content: "Example instructions.",
					}),
				],
			};
			const production = buildSystemPrompt(options);
			distribution.production = false;
			const development = buildSystemPrompt(options);
			if (customPrompt) {
				expect(production).toBe(development);
				expect(production).not.toContain("Diffex documentation");
			} else {
				expect(production).toBe(
					development.replace(/Diffex documentation.*?(?=\n\nAppended instructions\.)/s, documentation),
				);
			}
		},
	);
});
