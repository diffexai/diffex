import { describe, expect, test } from "vitest";
import { APP_TITLE } from "../src/config.ts";
import { BUILTIN_TASK_PROFILES } from "../src/core/profiles.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt, buildSystemPromptWithProvenance } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("uses a genuinely thin DEFAULT base when no profile is resolved", () => {
		const result = buildSystemPromptWithProvenance({
			selectedTools: [],
			cwd: "/workspace",
		});

		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]).toMatchObject({ id: "base", kind: "base", immutable: true });
		expect(result.prompt).toContain('<base_prompt type="DEFAULT" id="default">');
		expect(result.prompt).toContain("Complete the user's task accurately, concisely, and transparently.");
		expect(result.prompt).toContain(
			"For consequential health, legal, financial, or safety matters, use current authoritative sources",
		);
		expect(result.prompt).toContain("Available tools:\n(none)");
		expect(result.prompt).toContain("documentation (read only when the user asks");
		expect(result.prompt).not.toContain("<skills>");
	});

	test("includes all default tools when snippets are provided", () => {
		const prompt = buildSystemPrompt({
			toolSnippets: {
				read: "Read file contents",
				bash: "Execute bash commands",
				edit: "Make surgical edits",
				write: "Create or overwrite files",
				update_plan: "track progress with an ordered task checklist",
			},
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("- read:");
		expect(prompt).toContain("- bash:");
		expect(prompt).toContain("- edit:");
		expect(prompt).toContain("- write:");
		expect(prompt).toContain("- update_plan:");
	});

	test("folds an immutable profile, guardrails, runtime guidance, and tool facts into one base", () => {
		const finance = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "finance");
		expect(finance).toBeDefined();

		const result = buildSystemPromptWithProvenance({
			profile: finance,
			selectedTools: ["read", "evolve"],
			toolSnippets: { read: "Read source material", evolve: "Record a durable lesson" },
			promptGuidelines: ["Use evolve only for durable lessons."],
			cwd: "/workspace",
		});
		expect(result.blocks).toHaveLength(1);
		expect(result.prompt).toContain('<base_prompt type="PROMPT_PROFILE" id="finance">');
		expect(result.prompt).toContain("Provide careful financial research and analysis.");
		expect(result.prompt).toContain("Treat this as a high-stakes task.");
		expect(result.prompt).toContain("Require qualified human review before consequential action.");
		expect(result.prompt).toContain("Use evolve only for durable lessons.");
		expect(result.prompt).toContain("Current working directory: /workspace");
		expect(result.prompt).toContain("- read: Read source material");
		expect(result.prompt).toContain("- evolve: Record a durable lesson");
		expect(result.prompt).not.toContain("<profile_guardrails");
	});

	test("instructs models to resolve Diffex docs and examples under absolute base paths", () => {
		const prompt = buildSystemPrompt({
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).toContain(
			`- When reading ${APP_TITLE} docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory`,
		);
		expect(prompt).toContain("environment variables (docs/environment-variables.md)");
	});

	test("keeps explicit custom and append prompt text inside the base instead of adding layers", () => {
		const coding = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "coding");
		expect(coding).toBeDefined();

		const result = buildSystemPromptWithProvenance({
			profile: coding,
			customPrompt: "Perform a bounded custom task.",
			appendSystemPrompt: "Return a short result.",
			selectedTools: ["read"],
			cwd: "/repo",
		});

		expect(result.blocks.map((block) => block.kind)).toEqual(["base"]);
		expect(result.prompt).toContain("Perform a bounded custom task.\n\nReturn a short result.");
		expect(result.prompt).not.toContain("You are an expert software engineering assistant.");
	});

	test("composes only base, user instructions, and evolved notes in that order", () => {
		const result = buildSystemPromptWithProvenance({
			selectedTools: [],
			contextFiles: [
				{ path: "/agent/AGENTS.md", content: "Global user instruction." },
				{ path: "/repo/CLAUDE.md", content: "Compatibility instruction." },
			],
			evolvedNotes: [{ path: "/agent/EVOLVED.md", content: "Prefer primary sources.", truncated: true }],
			cwd: "/repo",
		});

		expect(result.blocks.map((block) => block.kind)).toEqual(["base", "user-instructions", "evolved"]);
		expect(result.blocks.every((block) => block.immutable)).toBe(true);
		expect(result.prompt.indexOf("<base_prompt")).toBeLessThan(result.prompt.indexOf("<user_instructions"));
		expect(result.prompt.indexOf("<user_instructions")).toBeLessThan(result.prompt.indexOf("<evolved_notes>"));
		expect(result.prompt).toContain('<instruction_file path="/agent/AGENTS.md">');
		expect(result.prompt).toContain('<instruction_file path="/repo/CLAUDE.md">');
		expect(result.prompt).toContain('<evolved_note path="/agent/EVOLVED.md" truncated="true">');
		expect(result.prompt).toContain("[Earlier EVOLVED.md entries omitted]");
	});

	test("folds skill mechanics into base without adding a fourth layer", () => {
		const result = buildSystemPromptWithProvenance({
			selectedTools: ["read"],
			skills: [
				{
					name: "private-skill",
					description: "A test skill",
					filePath: "/skills/private/SKILL.md",
					baseDir: "/skills/private",
					sourceInfo: createSyntheticSourceInfo("/skills/private/SKILL.md", { source: "test" }),
					disableModelInvocation: false,
				},
			],
			cwd: "/repo",
		});

		expect(result.blocks.map((block) => block.kind)).toEqual(["base"]);
		expect(result.prompt).toContain("private-skill");
		expect(result.prompt).toContain("/skills/private/SKILL.md");
	});

	test("rejects mutable prompt profiles", () => {
		const coding = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "coding");
		expect(coding).toBeDefined();

		expect(() =>
			buildSystemPrompt({
				profile: { ...coding!, immutable: false },
				cwd: "/repo",
			}),
		).toThrow('Task profile "coding" must be immutable');
	});
});
