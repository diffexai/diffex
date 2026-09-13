import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("uses installed reference docs without pointing to an empty README or absent examples", () => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-package-docs-"));
		try {
			mkdirSync(join(directory, "docs"));
			writeFileSync(join(directory, "README.md"), "");
			vi.stubEnv("DIFFEX_PACKAGE_DIR", directory);
			const prompt = buildSystemPrompt({ cwd: process.cwd() });
			expect(prompt).toContain(`Additional docs: ${join(directory, "docs")}`);
			expect(prompt).toContain("skills (docs/skills.md)");
			expect(prompt).toContain("https://diffex.ai/");
			expect(prompt).not.toContain("README.md");
			expect(prompt).not.toContain("Examples:");
		} finally {
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	test("uses the product website when packaged documentation is absent", () => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-package-docs-"));
		try {
			vi.stubEnv("DIFFEX_PACKAGE_DIR", directory);
			const prompt = buildSystemPrompt({ cwd: process.cwd() });
			expect(prompt).toContain("https://diffex.ai/");
			expect(prompt).not.toContain("Main documentation:");
			expect(prompt).not.toContain("Additional docs:");
			expect(prompt).not.toContain("Examples:");
			expect(prompt).not.toContain(directory);
		} finally {
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		}
	});
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

		test("instructs models to resolve Diffex docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading Diffex docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
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

	describe("evolution memory", () => {
		test.each([
			{ label: "default", customPrompt: undefined },
			{ label: "custom", customPrompt: "Custom base prompt." },
		])("places non-empty memory before project context for the $label prompt", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				appendSystemPrompt: "Appended instructions.",
				evolutionMemory: {
					version: "sha256:1234",
					memory: "Prefer focused changes.",
				},
				contextFiles: [{ path: "AGENTS.md", content: "Project instructions." }],
				skills: [],
				cwd: process.cwd(),
			});

			const evolutionBlock =
				'<evolution_memory version="sha256:1234">\nPrefer focused changes.\n</evolution_memory>';
			expect(prompt).toContain(evolutionBlock);
			expect(prompt.indexOf("Appended instructions.")).toBeLessThan(prompt.indexOf(evolutionBlock));
			expect(prompt.indexOf(evolutionBlock)).toBeLessThan(prompt.indexOf("<project_context>"));
		});

		test("omits the evolution block for empty root memory", () => {
			const prompt = buildSystemPrompt({
				evolutionMemory: { version: "sha256:root", memory: "" },
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<evolution_memory");
		});
	});
});
