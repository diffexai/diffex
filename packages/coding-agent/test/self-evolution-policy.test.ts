import { describe, expect, it } from "vitest";
import { findSelfEvolutionPolicyViolation } from "../src/core/self-evolution-policy.ts";

const cwd = "/workspace/project";
const protectedPaths = [
	"/workspace/project/AGENTS.md",
	"/workspace/project/.diffex/EVOLVED.md",
	"/config/pi/profiles/generated/analysis/PROMPT.md",
];

describe("self-evolution policy", () => {
	it("blocks direct edit and write calls for protected files", () => {
		expect(findSelfEvolutionPolicyViolation("edit", { path: "AGENTS.md" }, { cwd, protectedPaths })?.path).toBe(
			"/workspace/project/AGENTS.md",
		);
		expect(
			findSelfEvolutionPolicyViolation(
				"write",
				{ path: "/config/pi/profiles/generated/analysis/PROMPT.md" },
				{ cwd, protectedPaths },
			)?.path,
		).toBe("/config/pi/profiles/generated/analysis/PROMPT.md");
		expect(
			findSelfEvolutionPolicyViolation("write", { path: ".diffex/EVOLVED.md" }, { cwd, protectedPaths: [] })?.path,
		).toBe("/workspace/project/.diffex/EVOLVED.md");
	});

	it("allows unrelated writes and all dedicated evolution calls", () => {
		expect(findSelfEvolutionPolicyViolation("write", { path: "report.md" }, { cwd, protectedPaths })).toBeUndefined();
		expect(
			findSelfEvolutionPolicyViolation("evolve", { note: "Prefer primary sources" }, { cwd, protectedPaths }),
		).toBeUndefined();
	});

	it("blocks mutating shell commands that reference protected files", () => {
		expect(
			findSelfEvolutionPolicyViolation(
				"bash",
				{ command: "printf 'new' > .diffex/EVOLVED.md" },
				{ cwd, protectedPaths },
			)?.path,
		).toBe("/workspace/project/.diffex/EVOLVED.md");
		expect(
			findSelfEvolutionPolicyViolation(
				"bash",
				{ command: "sed -i 's/a/b/' /config/pi/profiles/generated/analysis/PROMPT.md" },
				{ cwd, protectedPaths },
			)?.path,
		).toBe("/config/pi/profiles/generated/analysis/PROMPT.md");
		expect(
			findSelfEvolutionPolicyViolation(
				"bash",
				{ command: "python3 -c \"open('AGENTS.md', 'w').write('override')\"" },
				{ cwd, protectedPaths },
			)?.path,
		).toBe("/workspace/project/AGENTS.md");
	});

	it("allows read-only shell commands", () => {
		expect(
			findSelfEvolutionPolicyViolation("bash", { command: "sed -n '1,40p' AGENTS.md" }, { cwd, protectedPaths }),
		).toBeUndefined();
		expect(
			findSelfEvolutionPolicyViolation("bash", { command: "rg TODO .diffex/EVOLVED.md" }, { cwd, protectedPaths }),
		).toBeUndefined();
	});

	it("allows read-only commands that name a protected file while redirecting elsewhere", () => {
		expect(
			findSelfEvolutionPolicyViolation(
				"bash",
				{ command: 'grep -rn "CLAUDE.md" src > /tmp/out' },
				{ cwd, protectedPaths },
			),
		).toBeUndefined();
		expect(
			findSelfEvolutionPolicyViolation("bash", { command: "cat AGENTS.md > /dev/null" }, { cwd, protectedPaths }),
		).toBeUndefined();
	});

	it("still blocks redirects whose target is the protected file", () => {
		expect(
			findSelfEvolutionPolicyViolation("bash", { command: "echo x >> AGENTS.md" }, { cwd, protectedPaths })?.path,
		).toBe("/workspace/project/AGENTS.md");
	});

	it("only protects instruction file names that could be loaded for this session", () => {
		// cwd, its ancestors, and the project config directory are in scope.
		expect(findSelfEvolutionPolicyViolation("write", { path: "AGENTS.md" }, { cwd, protectedPaths: [] })?.path).toBe(
			"/workspace/project/AGENTS.md",
		);
		expect(
			findSelfEvolutionPolicyViolation("write", { path: "/workspace/CLAUDE.md" }, { cwd, protectedPaths: [] })?.path,
		).toBe("/workspace/CLAUDE.md");
		expect(
			findSelfEvolutionPolicyViolation("write", { path: ".diffex/EVOLVED.md" }, { cwd, protectedPaths: [] })?.path,
		).toBe("/workspace/project/.diffex/EVOLVED.md");
		// A same-named file in a subdirectory is not loaded, so scaffolding it stays allowed.
		expect(
			findSelfEvolutionPolicyViolation("write", { path: "packages/new-pkg/AGENTS.md" }, { cwd, protectedPaths: [] }),
		).toBeUndefined();
	});
});
