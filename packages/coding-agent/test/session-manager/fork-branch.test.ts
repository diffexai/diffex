import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../message-fixtures.ts";

describe("SessionManager forkBranch", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("copies a complete in-memory branch into an independent session", () => {
		const source = SessionManager.inMemory("/workspace");
		const modelId = source.appendModelChange("test-provider", "test-model");
		const thinkingId = source.appendThinkingLevelChange("high");
		const userId = source.appendMessage(userMsg("root prompt"));
		source.appendMessage(assistantMsg("root response"));
		const customId = source.appendCustomEntry("state", { nested: { value: "source" } });
		const compactionId = source.appendCompaction("compacted context", userId, 200, {
			nested: { value: "compaction" },
		});
		const summaryId = source.branchWithSummary(compactionId, "branch context", {
			nested: { value: "summary" },
		});
		const customMessageId = source.appendCustomMessageEntry(
			"notice",
			[{ type: "text", text: "custom context" }],
			true,
			{ nested: { value: "custom message" } },
		);
		const targetId = source.appendMessage(userMsg("selected leaf"));

		source.branch(userId);
		source.appendMessage(userMsg("excluded branch"));
		source.appendLabelChange(userId, "root");
		source.appendLabelChange(targetId, "selected");

		const sourceId = source.getSessionId();
		const sourceEntries = structuredClone(source.getEntries());
		const selectedSourceEntries = structuredClone(
			source.getBranch(targetId).filter((entry) => entry.type !== "label"),
		);
		const sourceLeafId = source.getLeafId();
		const fork = source.forkBranch(targetId);

		expect(fork).not.toBe(source);
		expect(fork.isPersisted()).toBe(false);
		expect(fork.getSessionFile()).toBeUndefined();
		expect(fork.getSessionId()).not.toBe(sourceId);
		expect(fork.getHeader()?.parentSession).toBe(sourceId);
		expect(fork.getBranch().map((entry) => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
			"message",
			"message",
			"custom",
			"compaction",
			"branch_summary",
			"custom_message",
			"message",
			"label",
			"label",
		]);
		expect(fork.getBranch().map((entry) => entry.id)).toEqual(
			expect.arrayContaining([
				modelId,
				thinkingId,
				userId,
				customId,
				compactionId,
				summaryId,
				customMessageId,
				targetId,
			]),
		);
		expect(fork.getLabel(userId)).toBe("root");
		expect(fork.getLabel(targetId)).toBe("selected");
		expect(fork.buildSessionContext()).toMatchObject({
			thinkingLevel: "high",
			model: { provider: "anthropic", modelId: "test" },
		});

		const forkEntries = fork.getEntries();
		for (const sourceEntry of selectedSourceEntries) {
			const forkEntry = forkEntries.find((entry) => entry.id === sourceEntry.id);
			expect(forkEntry).toEqual(sourceEntry);
			expect(forkEntry).not.toBe(source.getEntry(sourceEntry.id));
			if (forkEntry?.type === "message") {
				const sourceMessageEntry = source.getEntry(sourceEntry.id);
				expect(forkEntry.message).not.toBe(
					sourceMessageEntry?.type === "message" ? sourceMessageEntry.message : undefined,
				);
			}
		}

		const forkCustom = fork.getEntry(customId);
		if (forkCustom?.type !== "custom") throw new Error("Missing forked custom entry");
		(forkCustom.data as { nested: { value: string } }).nested.value = "fork";
		expect(source.getEntry(customId)).toMatchObject({ data: { nested: { value: "source" } } });
		expect(source.getEntries()).toEqual(sourceEntries);
		expect(source.getLeafId()).toBe(sourceLeafId);
		expect(source.getSessionId()).toBe(sourceId);

		const forkCount = fork.getEntries().length;
		source.appendMessage(userMsg("source-only append"));
		expect(fork.getEntries()).toHaveLength(forkCount);
		const sourceCount = source.getEntries().length;
		fork.appendMessage(userMsg("fork-only append"));
		expect(source.getEntries()).toHaveLength(sourceCount);

		expect(sourceLeafId).not.toBe(targetId);
		expect(sourceEntries.at(-1)?.id).toBe(sourceLeafId);
	});

	it("forks a persisted source without creating files or mutating it", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "diffex-fork-branch-"));
		tempDirs.push(tempDir);
		const source = SessionManager.create(tempDir, tempDir);
		source.appendMessage(userMsg("prompt"));
		const targetId = source.appendMessage(assistantMsg("response"));
		source.appendLabelChange(targetId, "checkpoint");

		const sourceFile = source.getSessionFile();
		const beforeFiles = readdirSync(tempDir).sort();
		const beforeHeader = structuredClone(source.getHeader());
		const beforeEntries = structuredClone(source.getEntries());
		const beforeLeafId = source.getLeafId();
		const fork = source.forkBranch(targetId);

		expect(sourceFile).toBeDefined();
		expect(fork.getHeader()?.parentSession).toBe(sourceFile);
		expect(fork.isPersisted()).toBe(false);
		expect(fork.getSessionFile()).toBeUndefined();
		expect(readdirSync(tempDir).sort()).toEqual(beforeFiles);
		expect(source.getHeader()).toEqual(beforeHeader);
		expect(source.getEntries()).toEqual(beforeEntries);
		expect(source.getLeafId()).toBe(beforeLeafId);
		expect(source.getSessionFile()).toBe(sourceFile);
		expect(source.isPersisted()).toBe(true);
	});

	it("rejects an unknown entry ID without changing the source", () => {
		const source = SessionManager.inMemory();
		source.appendMessage(userMsg("prompt"));
		const before = structuredClone(source.getEntries());

		expect(() => source.forkBranch("missing")).toThrow("Entry missing not found");
		expect(source.getEntries()).toEqual(before);
	});
});
