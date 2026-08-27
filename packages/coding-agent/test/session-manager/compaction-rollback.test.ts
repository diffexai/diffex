import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendCompactionTransaction, SessionManager } from "../../src/core/session-manager.ts";

function appendAssistant(sessionManager: SessionManager, text: string, timestamp: number): string {
	return sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	});
}

describe("SessionManager compaction rollback", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each(["in-memory", "persisted"] as const)(
		"removes only the exact latest compaction and preserves %s branch state",
		(storage) => {
			const tempDir = join(
				tmpdir(),
				`diffex-compaction-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(tempDir, { recursive: true });
			tempDirs.push(tempDir);
			const sessionManager =
				storage === "persisted" ? SessionManager.create(tempDir, tempDir) : SessionManager.inMemory(tempDir);
			const firstUserId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
			appendAssistant(sessionManager, "first response", 2);
			const priorCompactionId = sessionManager.appendCompaction("prior", firstUserId, 2);
			const currentUserId = sessionManager.appendMessage({ role: "user", content: "current", timestamp: 3 });
			const currentAssistantId = appendAssistant(sessionManager, "current response", 4);
			const entriesBefore = structuredClone(sessionManager.getEntries());

			const transaction = appendCompactionTransaction(sessionManager, "cancelled", currentUserId, 4);
			const extensionEntryId = sessionManager.appendCustomEntry("extension-side-effect", { preserved: true });
			transaction.rollback();
			const appendedAfterRollbackId = sessionManager.appendCustomEntry("after-rollback", { persisted: true });

			expect(sessionManager.getEntry(transaction.entry.id)).toBeUndefined();
			expect(sessionManager.getEntry(priorCompactionId)).toMatchObject({ type: "compaction", summary: "prior" });
			expect(sessionManager.getEntries().slice(0, entriesBefore.length)).toEqual(entriesBefore);
			expect(sessionManager.getEntry(extensionEntryId)).toMatchObject({
				type: "custom",
				parentId: currentAssistantId,
				data: { preserved: true },
			});
			expect(sessionManager.getLeafId()).toBe(appendedAfterRollbackId);
			expect(sessionManager.getBranch().some((entry) => entry.id === transaction.entry.id)).toBe(false);

			if (storage === "persisted") {
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");
				const reopened = SessionManager.open(sessionFile, tempDir);
				expect(reopened.getEntry(transaction.entry.id)).toBeUndefined();
				expect(reopened.getEntry(priorCompactionId)).toMatchObject({ type: "compaction", summary: "prior" });
				expect(reopened.getEntry(extensionEntryId)).toMatchObject({ parentId: currentAssistantId });
				expect(reopened.getLeafId()).toBe(appendedAfterRollbackId);
			}
		},
	);
});
