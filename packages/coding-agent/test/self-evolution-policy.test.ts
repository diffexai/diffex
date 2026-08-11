import { describe, expect, it } from "vitest";
import { findSelfEvolutionPolicyViolation } from "../src/core/self-evolution-policy.ts";

const cwd = "/workspace/project";
const protectedPaths = [
	"/workspace/project/AGENTS.md",
	"/workspace/project/.pi/EVOLVED.md",
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
			findSelfEvolutionPolicyViolation("write", { path: ".pi/EVOLVED.md" }, { cwd, protectedPaths: [] })?.path,
		).toBe("/workspace/project/.pi/EVOLVED.md");
	});

	it("allows unrelated writes and all dedicated evolution calls", () => {
		expect(findSelfEvolutionPolicyViolation("write", { path: "report.md" }, { cwd, protectedPaths })).toBeUndefined();
		expect(
			findSelfEvolutionPolicyViolation("evolve", { note: "Prefer primary sources" }, { cwd, protectedPaths }),
		).toBeUndefined();
	});

	it("blocks mutating shell commands that reference protected files", () => {
		expect(
			findSelfEvolutionPolicyViolation("bash", { command: "printf 'new' > .pi/EVOLVED.md" }, { cwd, protectedPaths })
				?.path,
		).toBe("/workspace/project/.pi/EVOLVED.md");
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
			findSelfEvolutionPolicyViolation("bash", { command: "rg TODO .pi/EVOLVED.md" }, { cwd, protectedPaths }),
		).toBeUndefined();
	});
});
