import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { expandPromptTemplate, loadPromptTemplates } from "../src/core/prompt-templates.ts";

vi.mock("../src/config.ts", () => ({ CONFIG_DIR_NAME: ".diffex", IS_PRODUCTION_DISTRIBUTION: true }));

describe("production prompt templates", () => {
	test.each(["project", "global", "directory", "file"])(
		"hides /cl loaded from %s while preserving user prompts",
		(source) => {
			const root = mkdtempSync(join(tmpdir(), "diffex-production-prompts-"));
			try {
				const cwd = join(root, "project");
				const agentDir = join(root, "agent");
				const directory =
					source === "project"
						? join(cwd, ".diffex/prompts")
						: source === "global"
							? join(agentDir, "prompts")
							: join(root, "explicit");
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "cl.md"), "Audit repository changelogs");
				writeFileSync(join(directory, "review.md"), "Review $ARGUMENTS");
				const promptPaths =
					source === "file"
						? [join(directory, "cl.md"), join(directory, "review.md")]
						: source === "directory"
							? [directory]
							: [];
				const templates = loadPromptTemplates({ cwd, agentDir, promptPaths, includeDefaults: true });
				expect(templates.map((template) => template.name)).toEqual(["review"]);
				expect(expandPromptTemplate("/review changes", templates)).toBe("Review changes");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	test.each(["/cl", "/cl audit", "/cl\naudit"])("rejects %s even without loaded templates", (text) => {
		expect(() => expandPromptTemplate(text, [])).toThrow("/cl is unavailable in production Diffex installations.");
	});

	test("preserves ordinary text and similarly named commands", () => {
		for (const text of ["Discuss /cl", "/clear", "/clone", "/changelog"])
			expect(expandPromptTemplate(text, [])).toBe(text);
	});
});
