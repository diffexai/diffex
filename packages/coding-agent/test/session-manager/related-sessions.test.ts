import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_RELATED_SESSION_REFERENCES,
	MAX_SESSION_ID_LENGTH,
	normalizeRelatedSessionReferences,
	readSessionHeaderForDiscovery,
	SessionManager,
} from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-related-sessions-"));
	tempDirs.push(tempDir);
	return tempDir;
}

function writeHeader(
	path: string,
	input: {
		id: string;
		timestamp: string;
		cwd: string;
		profileId?: string;
		harnessId?: string;
		relatedSessions?: unknown;
	},
): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: input.id,
			timestamp: input.timestamp,
			cwd: input.cwd,
			...(input.profileId
				? {
						profile: {
							id: input.profileId,
							hash: `${input.profileId}-hash`,
							routing: "auto",
							harnessId: input.harnessId,
						},
					}
				: {}),
			...(input.relatedSessions !== undefined ? { relatedSessions: input.relatedSessions } : {}),
		})}\n`,
	);
}

function persistAssistantMessage(session: SessionManager): void {
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("related session metadata", () => {
	it("normalizes, deduplicates, bounds, and keeps relations independent from parentSession", () => {
		const additional = Array.from({ length: MAX_RELATED_SESSION_REFERENCES + 8 }, (_, index) => ({
			sessionId: `session-${index}`,
			harnessId: `harness-${index}`,
		}));
		const session = SessionManager.inMemory(process.cwd(), {
			id: "current",
			relatedSessions: [
				{ sessionId: " prior-session ", harnessId: " finance-harness " },
				{ sessionId: "prior-session", harnessId: "ignored-duplicate" },
				{ sessionId: "current", harnessId: "self-harness" },
				{ sessionId: "../../outside", harnessId: "unsafe" },
				...additional,
			],
		});

		expect(session.getHeader()?.parentSession).toBeUndefined();
		expect(session.getRelatedSessions()).toHaveLength(MAX_RELATED_SESSION_REFERENCES);
		expect(session.getRelatedSessions()[0]).toEqual({
			sessionId: "prior-session",
			harnessId: "finance-harness",
		});
		expect(session.getRelatedSessions()).not.toContainEqual({ sessionId: "current", harnessId: "self-harness" });

		session.mergeRelatedSessions([{ sessionId: "new-priority", harnessId: "new-harness" }]);
		expect(session.getRelatedSessions()[0]).toEqual({ sessionId: "new-priority", harnessId: "new-harness" });
		expect(session.getHeader()?.parentSession).toBeUndefined();
		const longSessionId = `s${"x".repeat(512)}`;
		expect(normalizeRelatedSessionReferences([{ sessionId: longSessionId, harnessId: "long-harness" }])).toEqual([]);
		expect(() => SessionManager.inMemory(process.cwd(), { id: `s${"x".repeat(MAX_SESSION_ID_LENGTH)}` })).toThrow(
			`at most ${MAX_SESSION_ID_LENGTH} characters`,
		);
	});

	it("persists new-session references and setter replacements on disk", () => {
		const tempDir = createTempDir();
		const session = SessionManager.create(tempDir, tempDir, {
			id: "current-session",
			relatedSessions: [{ sessionId: "finance-session", harnessId: "finance-harness" }],
		});
		persistAssistantMessage(session);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(readSessionHeaderForDiscovery(sessionFile!)?.relatedSessions).toEqual([
			{ sessionId: "finance-session", harnessId: "finance-harness" },
		]);
		expect(readSessionHeaderForDiscovery(sessionFile!)?.parentSession).toBeUndefined();

		session.setRelatedSessions([{ sessionId: "coding-session", harnessId: "coding-harness" }]);
		expect(readSessionHeaderForDiscovery(sessionFile!)?.relatedSessions).toEqual([
			{ sessionId: "coding-session", harnessId: "coding-harness" },
		]);
		expect(SessionManager.open(sessionFile!, tempDir).getRelatedSessions()).toEqual([
			{ sessionId: "coding-session", harnessId: "coding-harness" },
		]);
	});

	it("sanitizes malformed persisted relation metadata without rewriting the file", () => {
		const tempDir = createTempDir();
		const sessionFile = join(tempDir, "malformed.jsonl");
		const validReferences = Array.from({ length: MAX_RELATED_SESSION_REFERENCES + 4 }, (_, index) => ({
			sessionId: `valid-${index}`,
			harnessId: `harness-${index}`,
		}));
		writeHeader(sessionFile, {
			id: "current-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
			relatedSessions: [
				null,
				{ sessionId: 12, harnessId: "finance" },
				{ sessionId: "../outside", harnessId: "finance" },
				{ sessionId: "valid-0", harnessId: "duplicate" },
				...validReferences,
			],
		});
		const original = readFileSync(sessionFile, "utf8");

		const header = readSessionHeaderForDiscovery(sessionFile);
		expect(header?.relatedSessions).toHaveLength(MAX_RELATED_SESSION_REFERENCES);
		expect(header?.relatedSessions?.[0]).toEqual({ sessionId: "valid-0", harnessId: "duplicate" });
		expect(SessionManager.open(sessionFile, tempDir).getRelatedSessions()).toEqual(header?.relatedSessions);
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
		expect(normalizeRelatedSessionReferences("not-an-array")).toEqual([]);
	});
});

describe("header-only related session discovery", () => {
	it("resolves only verified referenced sessions without transcript reads", async () => {
		const tempDir = createTempDir();
		const financeOldPath = join(tempDir, "finance-old.jsonl");
		const financeNewPath = join(tempDir, "finance-new.jsonl");
		writeHeader(financeOldPath, {
			id: "finance-old",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		writeHeader(financeNewPath, {
			id: "finance-new",
			timestamp: "2026-02-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		utimesSync(financeNewPath, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));
		utimesSync(financeOldPath, new Date("2026-04-01T00:00:00.000Z"), new Date("2026-04-01T00:00:00.000Z"));
		writeHeader(join(tempDir, "coding-session.jsonl"), {
			id: "coding-session",
			timestamp: "2026-03-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "coding",
			harnessId: "coding-harness",
		});
		writeHeader(join(tempDir, "current-copy.jsonl"), {
			id: "current-session",
			timestamp: "2026-04-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		writeHeader(join(tempDir, "invalid-profile.jsonl"), {
			id: "invalid-profile",
			timestamp: "2026-05-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "../finance-harness",
		});
		const symlinkTarget = join(tempDir, "symlink-target.txt");
		writeHeader(symlinkTarget, {
			id: "symlink-session",
			timestamp: "2026-06-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		if (process.platform !== "win32") symlinkSync(symlinkTarget, join(tempDir, "symlink-session.jsonl"));

		const manager = SessionManager.create(tempDir, tempDir, {
			id: "current-session",
			relatedSessions: [
				{ sessionId: "finance-old", harnessId: "finance-harness" },
				{ sessionId: "finance-new", harnessId: "finance-harness" },
				{ sessionId: "coding-session", harnessId: "wrong-harness" },
				{ sessionId: "symlink-session", harnessId: "finance-harness" },
			],
		});

		expect(manager.discoverRelatedSessions()).toEqual([
			expect.objectContaining({
				sessionId: "finance-old",
				harnessId: "finance-harness",
				sessionPath: financeOldPath,
				profileId: "finance",
				timestamp: "2026-01-01T00:00:00.000Z",
			}),
			expect.objectContaining({
				sessionId: "finance-new",
				harnessId: "finance-harness",
				sessionPath: financeNewPath,
				profileId: "finance",
				timestamp: "2026-02-01T00:00:00.000Z",
			}),
		]);
		const listed = await SessionManager.list(tempDir, tempDir);
		const financeSession = listed.find((session) => session.id === "finance-new");
		expect(financeSession?.profileId).toBe("finance");
		expect(financeSession?.harnessId).toBe("finance-harness");
	});

	it("rejects duplicate IDs and path replacement after discovery", () => {
		const tempDir = createTempDir();
		const originalPath = join(tempDir, "finance-session.jsonl");
		writeHeader(originalPath, {
			id: "finance-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		const manager = SessionManager.create(tempDir, tempDir, {
			id: "current-session",
			relatedSessions: [{ sessionId: "finance-session", harnessId: "finance-harness" }],
		});
		const discovered = manager.discoverRelatedSessions()[0];
		if (!discovered) throw new Error("Expected a discovered Finance session");

		writeHeader(join(tempDir, "2026-02-01T00-00-00-000Z_finance-session.jsonl"), {
			id: "finance-session",
			timestamp: "2026-02-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		expect(manager.discoverRelatedSessions()).toEqual([]);

		rmSync(originalPath);
		if (process.platform !== "win32") {
			const target = join(tempDir, "outside.txt");
			writeFileSync(target, "outside\n");
			symlinkSync(target, originalPath);
			expect(() => manager.openDiscoveredRelatedSession(discovered)).toThrow("changed before it could be opened");
			expect(readFileSync(target, "utf8")).toBe("outside\n");
		}
	});

	it("pins resumed reads and writes to the discovered file identity", () => {
		if (process.platform === "win32") return;
		const tempDir = createTempDir();
		const sessionPath = join(tempDir, "finance-session.jsonl");
		writeHeader(sessionPath, {
			id: "finance-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
			profileId: "finance",
			harnessId: "finance-harness",
		});
		const manager = SessionManager.create(tempDir, tempDir, {
			id: "current-session",
			relatedSessions: [{ sessionId: "finance-session", harnessId: "finance-harness" }],
		});
		const discovered = manager.discoverRelatedSessions()[0];
		if (!discovered) throw new Error("Expected a discovered Finance session");
		const resumed = manager.openDiscoveredRelatedSession(discovered);

		const movedSessionPath = join(tempDir, "moved-finance-session.txt");
		const outsidePath = join(tempDir, "outside.txt");
		writeFileSync(outsidePath, "outside\n");
		renameSync(sessionPath, movedSessionPath);
		symlinkSync(outsidePath, sessionPath);

		expect(() => persistAssistantMessage(resumed)).toThrow();
		expect(readFileSync(outsidePath, "utf8")).toBe("outside\n");
		expect(readFileSync(movedSessionPath, "utf8")).toContain('"id":"finance-session"');
	});
});
