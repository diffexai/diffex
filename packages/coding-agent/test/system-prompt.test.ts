import { describe, expect, test } from "vitest";
import { APP_TITLE } from "../src/config.ts";
import { BUILTIN_TASK_PROFILES } from "../src/core/profiles.ts";
import { buildSystemPrompt, buildSystemPromptWithProvenance } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
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
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	test("uses the active profile prompt and context label", () => {
		const codingProfile = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "coding");
		expect(codingProfile).toBeDefined();
		const prompt = buildSystemPrompt({
			profile: codingProfile!,
			selectedTools: ["read"],
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Run the focused test." }],
			cwd: "/repo",
		});

		expect(prompt).toContain('<task_profile id="coding">');
		expect(prompt).toContain("You are an expert software engineering assistant.");
		expect(prompt).toContain('<profile_guardrails profile="coding" high_stakes="false">');
		expect(prompt).toContain("- Read relevant files completely before broad changes.");
		expect(prompt).toContain('<user_instructions label="Project instructions">');
	});

	test("customPrompt replaces only the profile layer", () => {
		const codingProfile = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "coding");
		expect(codingProfile).toBeDefined();
		const prompt = buildSystemPrompt({
			profile: codingProfile!,
			customPrompt: "Perform a bounded custom task.",
			appendSystemPrompt: "Return a short result.",
			selectedTools: ["read"],
			toolSnippets: { read: "Read a source" },
			contextFiles: [{ path: "/repo/AGENTS.md", content: "User-owned instruction." }],
			evolvedNotes: [{ path: "/agent/EVOLVED.md", content: "Prefer primary sources." }],
			cwd: "/repo",
		});

		expect(prompt).toContain("<harness_rules>");
		expect(prompt).toContain("Perform a bounded custom task.\n\nReturn a short result.");
		expect(prompt).not.toContain("You are an expert software engineering assistant.");
		expect(prompt).toContain('<profile_guardrails profile="coding" high_stakes="false">');
		expect(prompt).toContain("- read: Read a source");
		expect(prompt).toContain("User-owned instruction.");
		expect(prompt).toContain("Prefer primary sources.");
		expect(prompt).toContain("Current working directory: /repo");
	});

	test("returns ordered provenance for every prompt layer", () => {
		const result = buildSystemPromptWithProvenance({
			selectedTools: [],
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Instructions" }],
			evolvedNotes: [{ path: "/agent/EVOLVED.md", content: "Notes", truncated: true }],
			cwd: "/repo",
		});

		expect(result.blocks.map((block) => block.kind)).toEqual([
			"harness",
			"profile",
			"tools",
			"documentation",
			"user-instructions",
			"evolved",
			"runtime",
		]);
		expect(result.blocks.find((block) => block.kind === "profile")?.immutable).toBe(false);
		expect(result.blocks.filter((block) => block.kind !== "profile").every((block) => block.immutable)).toBe(true);
		expect(result.prompt).toContain('<evolved_note path="/agent/EVOLVED.md" truncated="true">');
		expect(result.prompt).toContain("[Earlier EVOLVED.md entries omitted]");
	});
});
