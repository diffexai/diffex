import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("BUILTIN_SLASH_COMMANDS", () => {
	it("uses /clear and /exit for session control commands", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).toContain("clear");
		expect(commandNames).toContain("exit");
		expect(commandNames).not.toContain("new");
		expect(commandNames).not.toContain("quit");
	});

	it("includes the argument-free /subagents command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "subagents",
			description: "Show sub-agents in the current session",
		});
	});

	it("registers plan mode with optional on/off arguments", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "plan",
			description: "Toggle plan mode",
			argumentHint: "[on|off]",
		});
	});
});
