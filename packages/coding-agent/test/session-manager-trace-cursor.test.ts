import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager trace cursors", () => {
	const tempDirectories: string[] = [];

	afterEach(() => {
		for (const directory of tempDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("returns immutable content references for appended entry boundaries", () => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-session-cursor-"));
		tempDirectories.push(directory);
		const manager = SessionManager.create(directory, join(directory, "sessions"));

		expect(manager.getEntryCount()).toBe(0);
		manager.appendModelChange("faux", "model");
		const firstEntryOrdinal = manager.getEntryCount();
		manager.appendThinkingLevelChange("medium");
		manager.appendSessionInfo("trace cursor");

		const entries = manager.getEntries();
		const range = manager.getEntryCursorRange(firstEntryOrdinal);
		expect(range).toEqual({
			start: {
				entryOrdinal: 1,
				entryId: entries[1].id,
				digest: {
					kind: "content",
					algorithm: "sha256",
					value: createHash("sha256").update(JSON.stringify(entries[1])).digest("hex"),
				},
			},
			end: {
				entryOrdinal: 2,
				entryId: entries[2].id,
				digest: {
					kind: "content",
					algorithm: "sha256",
					value: createHash("sha256").update(JSON.stringify(entries[2])).digest("hex"),
				},
			},
		});
		expect(manager.getEntryCursorRange(manager.getEntryCount())).toBeUndefined();
	});

	it("rejects invalid entry ordinals", () => {
		const manager = SessionManager.inMemory();
		expect(() => manager.getEntryCursorRange(-1)).toThrow("non-negative integer");
		expect(() => manager.getEntryCursorRange(0.5)).toThrow("non-negative integer");
	});
});
