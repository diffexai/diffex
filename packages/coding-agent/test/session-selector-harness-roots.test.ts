import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeSession(overrides: Partial<SessionInfo> & { id: string; name: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "/tmp/project",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		profileId: overrides.profileId,
		harnessId: overrides.harnessId,
		created: overrides.created ?? new Date("2026-08-12T00:00:00.000Z"),
		modified: overrides.modified ?? new Date("2026-08-12T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 2,
		firstMessage: overrides.firstMessage ?? overrides.name,
		allMessagesText: overrides.allMessagesText ?? overrides.name,
	};
}

async function renderThreadedSessions(sessions: SessionInfo[]): Promise<string> {
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => [],
		() => {},
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return selector
		.render(120)
		.join("\n")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("session selector harness roots", () => {
	beforeAll(() => initTheme("dark"));

	beforeEach(() => setKeybindings(new KeybindingsManager()));

	test("renders a legacy Finance to Coding task transition as independent roots", async () => {
		const finance = makeSession({
			id: "finance",
			name: "Finance Roth IRA",
			profileId: "finance",
			harnessId: "roth-ira-guidance",
			modified: new Date("2026-08-12T01:00:00.000Z"),
		});
		const coding = makeSession({
			id: "coding",
			name: "Coding Chatbot",
			parentSessionPath: finance.path,
			profileId: "coding",
			harnessId: "python-chatbot",
			modified: new Date("2026-08-12T02:00:00.000Z"),
		});

		const output = await renderThreadedSessions([finance, coding]);

		expect(output).toContain("Finance Roth IRA");
		expect(output).toContain("Coding Chatbot");
		expect(output).not.toContain("└─ Finance Roth IRA");
		expect(output).not.toContain("└─ Coding Chatbot");
	});

	test("keeps a same-harness fork nested", async () => {
		const parent = makeSession({
			id: "coding-parent",
			name: "Coding parent",
			profileId: "coding",
			harnessId: "python-chatbot",
		});
		const fork = makeSession({
			id: "coding-fork",
			name: "Coding fork",
			parentSessionPath: parent.path,
			profileId: "coding",
			harnessId: "python-chatbot",
			modified: new Date("2026-08-12T02:00:00.000Z"),
		});

		const output = await renderThreadedSessions([parent, fork]);

		expect(output).toContain("Coding parent");
		expect(output).toContain("└─ Coding fork");
	});

	test("uses profile mismatch to flatten legacy sessions without harness metadata", async () => {
		const finance = makeSession({
			id: "legacy-finance",
			name: "Legacy Finance",
			profileId: "finance",
		});
		const coding = makeSession({
			id: "legacy-coding",
			name: "Legacy Coding",
			parentSessionPath: finance.path,
			profileId: "coding",
		});

		const output = await renderThreadedSessions([finance, coding]);

		expect(output).not.toContain("└─ Legacy Coding");
	});

	test("preserves legacy nesting when metadata cannot disambiguate the sessions", async () => {
		const parent = makeSession({ id: "unknown-parent", name: "Unknown parent" });
		const child = makeSession({
			id: "unknown-child",
			name: "Unknown child",
			parentSessionPath: parent.path,
		});

		const output = await renderThreadedSessions([parent, child]);

		expect(output).toContain("└─ Unknown child");
	});

	test("keeps malformed self and two-session parent cycles visible", async () => {
		const self = makeSession({
			id: "self-cycle",
			name: "Self cycle",
			parentSessionPath: "/tmp/self-cycle.jsonl",
			harnessId: "shared-harness",
		});
		const first = makeSession({
			id: "cycle-first",
			name: "Cycle first",
			parentSessionPath: "/tmp/cycle-second.jsonl",
			harnessId: "shared-harness",
		});
		const second = makeSession({
			id: "cycle-second",
			name: "Cycle second",
			parentSessionPath: "/tmp/cycle-first.jsonl",
			harnessId: "shared-harness",
		});

		const output = await renderThreadedSessions([self, first, second]);

		expect(output).toContain("Self cycle");
		expect(output).toContain("Cycle first");
		expect(output).toContain("Cycle second");
		expect(output).not.toMatch(/[└├]─ Self cycle/);
		expect(output).not.toMatch(/[└├]─ Cycle first/);
		expect(output).not.toMatch(/[└├]─ Cycle second/);
		expect(output).not.toContain("Failed to load sessions");
	});

	test("loads a deeply nested fork chain without recursive overflow", async () => {
		const sessions = Array.from({ length: 5_000 }, (_, index) =>
			makeSession({
				id: `deep-${index}`,
				name: `Deep ${index}`,
				parentSessionPath: index === 0 ? undefined : `/tmp/deep-${index - 1}.jsonl`,
				harnessId: "shared-harness",
				modified: new Date(1_700_000_000_000 + index),
			}),
		);

		const output = await renderThreadedSessions(sessions);

		expect(output).toContain("Deep 0");
		expect(output).toContain("(1/5000)");
		expect(output).not.toContain("Failed to load sessions");
	});
});
