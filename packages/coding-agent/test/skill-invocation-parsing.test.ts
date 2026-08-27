import { describe, expect, it } from "vitest";
import { parseSkillBlock, parseSkillInvocation } from "../src/core/agent-session.ts";

describe("skill invocation parsing", () => {
	it("parses multiple versioned skill blocks and one trailing user request", () => {
		const text = [
			'<skill name="first" location="/skills/first/SKILL.md" id="skill:first" version="sha256:one" source="local" scope="project" base="/skills/first">',
			"First instructions.",
			"</skill>",
			"",
			'<skill name="second" location="/skills/second/SKILL.md" id="skill:second" version="sha256:two" source="local" scope="project" base="/skills/second">',
			"Second instructions.",
			"</skill>",
			"",
			"Complete the task.",
		].join("\n");

		const invocation = parseSkillInvocation(text);

		expect(invocation?.skills.map((skill) => skill.name)).toEqual(["first", "second"]);
		expect(invocation?.skills.map((skill) => skill.content)).toEqual(["First instructions.", "Second instructions."]);
		expect(invocation?.userMessage).toBe("Complete the task.");
		expect(parseSkillBlock(text)).toBeNull();
	});

	it("preserves the legacy single-skill parser", () => {
		const text = '<skill name="legacy" location="/legacy/SKILL.md">\nLegacy instructions.\n</skill>\n\nDo it.';

		expect(parseSkillBlock(text)).toEqual({
			name: "legacy",
			location: "/legacy/SKILL.md",
			content: "Legacy instructions.",
			userMessage: "Do it.",
		});
	});
});
