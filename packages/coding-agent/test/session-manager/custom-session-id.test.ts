import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("SessionManager.newSession with custom id", () => {
	it("stores task profile metadata in a new session header", () => {
		const profile = {
			id: "finance",
			hash: "profile-hash",
			routing: "auto" as const,
		};
		const session = SessionManager.inMemory(process.cwd(), { profile });

		expect(session.getHeader()?.profile).toEqual(profile);
	});

	it("updates task profile metadata for a resumable session", () => {
		const session = SessionManager.inMemory();

		session.setProfileMetadata({
			id: "legal",
			hash: "legal-hash",
			source: "/profiles/legal/profile.json",
			routing: "pinned",
		});

		expect(session.getHeader()?.profile).toEqual({
			id: "legal",
			hash: "legal-hash",
			source: "/profiles/legal/profile.json",
			routing: "pinned",
		});
	});

	it("uses the provided id instead of generating one", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("uses the provided id when creating an in-memory session", () => {
		const session = SessionManager.inMemory(process.cwd(), { id: "memory-session-id" });
		expect(session.getSessionId()).toBe("memory-session-id");
		expect(session.getHeader()!.id).toBe("memory-session-id");
		expect(session.getSessionFile()).toBeUndefined();
	});

	it("allows alphanumeric session ids with interior punctuation", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "abc-123_def.456" });
		expect(session.getSessionId()).toBe("abc-123_def.456");
	});

	it("rejects invalid custom session ids", () => {
		const invalidIds = ["", "-abc", "abc-", "_abc", "abc_", ".abc", "abc.", "abc/def", "abc\\def", "abc def"];

		for (const id of invalidIds) {
			const session = SessionManager.inMemory();
			expect(() => session.newSession({ id })).toThrow(
				"Session id must be non-empty, contain only alphanumeric characters",
			);
		}
	});

	it("generates a UUIDv7 id when no id is provided", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("generates a UUIDv7 id when options is provided without id", () => {
		const session = SessionManager.inMemory();
		session.newSession({ parentSession: "parent.jsonl" });
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("includes the custom id in the session header", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "header-test-id" });

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("header-test-id");
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("uses the provided id when creating a persisted session", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const session = SessionManager.create(tempDir, tempDir, { id: "created-session-id" });

		expect(session.getSessionId()).toBe("created-session-id");
		expect(session.getHeader()!.id).toBe("created-session-id");
		const sessionFile = session.getSessionFile()!;
		expect(sessionFile).toContain("created-session-id");
		expect(basename(sessionFile)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_created-session-id\.jsonl$/);
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("generates a UUIDv7 id when creating a branched session", () => {
		const profile = { id: "coding", hash: "coding-hash", routing: "auto" as const };
		const session = SessionManager.inMemory(process.cwd(), { profile });
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		session.createBranchedSession(firstId);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
		expect(session.getHeader()!.profile).toEqual(profile);
	});

	it("generates a UUIDv7 id when forking from another session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const sourcePath = join(tempDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-session-id",
					timestamp: new Date().toISOString(),
					cwd: tempDir,
					profile: { id: "research", hash: "research-hash", routing: "auto" },
				}),
				JSON.stringify({
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.4",
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
					},
				}),
			].join("\n")}
`,
		);

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir);
		const header = forked.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toMatch(UUID_V7_RE);
		expect(header!.parentSession).toBe(sourcePath);
		expect(header!.profile).toEqual({ id: "research", hash: "research-hash", routing: "auto" });
	});

	it("uses the provided id when forking from another session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const sourcePath = join(tempDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "source-session-id",
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			})}\n`,
		);

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir, { id: "forked-session-id" });
		const header = forked.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("forked-session-id");
		expect(header!.parentSession).toBe(sourcePath);
		const sessionFile = forked.getSessionFile()!;
		expect(sessionFile).toContain("forked-session-id");
		expect(basename(sessionFile)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_forked-session-id\.jsonl$/);
	});
});
