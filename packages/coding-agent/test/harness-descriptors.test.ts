import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvolvedNote } from "../src/core/evolved.ts";
import {
	createHarnessDescriptor,
	getHarnessDescriptorsDirectory,
	loadHarnessDescriptors,
} from "../src/core/harness-descriptors.ts";

describe("harness descriptors", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});

	function makeAgentDir(): string {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-harness-descriptors-"));
		roots.push(agentDir);
		return agentDir;
	}

	it("stores normalized identity metadata without prompt content", () => {
		const agentDir = makeAgentDir();
		const descriptor = createHarnessDescriptor({
			agentDir,
			id: "portfolio-review-a1b2c3",
			name: "  Portfolio\n\u0000 review  ",
			description: "  Compare\t investment   risks.  ",
			baseProfileId: "finance",
			createdAt: "2026-08-01T00:00:00.000Z",
		});

		expect(descriptor.name).toBe("Portfolio review");
		expect(descriptor.description).toBe("Compare investment risks.");
		const stored = readFileSync(descriptor.sourcePath, "utf-8");
		expect(stored).not.toContain("prompt");
		expect(stored).not.toContain("revision");
		expect(getHarnessDescriptorsDirectory(agentDir)).toMatch(/\/harnesses$/);
	});

	it("derives a new revision from harness and global EVOLVED notes", () => {
		const agentDir = makeAgentDir();
		const descriptor = createHarnessDescriptor({
			agentDir,
			id: "evidence-review-a1b2c3",
			name: "Evidence review",
			description: "Review source evidence.",
			baseProfileId: "research",
		});
		const harnessNote = appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: descriptor.id,
			category: "sources",
			provenance: "test",
			content: "Prefer primary sources.",
		});
		const profileNote = appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: "research",
			category: "legacy",
			provenance: "test",
			content: "Legacy profile-wide guidance.",
		});

		const withoutNotes = loadHarnessDescriptors({ agentDir }).harnesses[0];
		const resolved = loadHarnessDescriptors({ agentDir, notes: [harnessNote, profileNote] }).harnesses[0];

		expect(withoutNotes?.revision).toBe(descriptor.revision);
		expect(withoutNotes?.evolvedNoteCount).toBe(0);
		expect(withoutNotes?.latestEvolutionAt).toBeUndefined();
		expect(resolved?.revision).not.toBe(descriptor.revision);
		expect(resolved?.evolvedNoteCount).toBe(1);
		expect(resolved?.harnessNoteCount).toBe(1);
	});

	it("rejects custom profile references during creation and load", () => {
		const agentDir = makeAgentDir();
		expect(() =>
			createHarnessDescriptor({
				agentDir,
				name: "Custom policy",
				description: "Attempt to route automatically to a user profile.",
				baseProfileId: "custom-policy",
			}),
		).toThrow("immutable built-in profile");

		const directory = getHarnessDescriptorsDirectory(agentDir, true);
		const sourcePath = join(directory, "custom-policy-task-a1b2c3.json");
		writeFileSync(
			sourcePath,
			`${JSON.stringify({
				schemaVersion: 1,
				id: "custom-policy-task-a1b2c3",
				name: "Custom policy task",
				description: "Tampered descriptor.",
				baseProfileId: "custom-policy",
				createdAt: "2026-08-01T00:00:00.000Z",
			})}\n`,
			"utf-8",
		);

		const loaded = loadHarnessDescriptors({ agentDir });
		expect(loaded.harnesses).toEqual([]);
		expect(loaded.diagnostics).toEqual([
			expect.objectContaining({ path: sourcePath, message: expect.stringContaining("immutable built-in profile") }),
		]);
	});

	it("rejects a descriptor directory symlink", () => {
		const agentDir = makeAgentDir();
		const outside = makeAgentDir();
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(agentDir, "harnesses"));

		expect(() =>
			createHarnessDescriptor({
				agentDir,
				name: "Unsafe task",
				description: "Must not traverse a symlink.",
				baseProfileId: "general",
			}),
		).toThrow("unsafe harness descriptor directory");
	});
});
