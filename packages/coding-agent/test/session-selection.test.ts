import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { applySessionName, createSessionManager, validateSessionIdFlags } from "../src/cli/session-selection.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("CLI session selection", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;
	const exit = new Error("process.exit");

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "diffex-session-selection-")));
		cwd = join(root, "project");
		sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	function writeSession(id: string): string {
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, `${id}.jsonl`);
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
		);
		return path;
	}

	it.each([["--help"], ["--no-session", "--help"], ["--list-models"]])(
		"does not reserve a session for %j",
		async (...args) => {
			const parsed = parseArgs(["--session-id", "read-only-id", ...args]);
			validateSessionIdFlags(parsed);
			const session = await createSessionManager(parsed, cwd, sessionDir, SettingsManager.inMemory());

			expect(session.getSessionId()).toBe("read-only-id");
			expect(session.getSessionFile()).toBeUndefined();
			expect(existsSync(sessionDir)).toBe(false);
			expect(process.exit).not.toHaveBeenCalled();
		},
	);

	it("warns when a missing session ID creates a new session", async () => {
		const session = await createSessionManager(
			parseArgs(["--session-id", "missing-id"]),
			cwd,
			sessionDir,
			SettingsManager.inMemory(),
		);

		expect(session.getSessionId()).toBe("missing-id");
		expect(session.getSessionFile()).toBeDefined();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"Warning: No project session found with id 'missing-id'; creating a new session with that id.",
			),
		);
	});

	it("opens an existing session ID without warning or mutation", async () => {
		const path = writeSession("existing-id");
		const before = readFileSync(path, "utf8");
		const session = await createSessionManager(
			parseArgs(["--session-id", "existing-id"]),
			cwd,
			sessionDir,
			SettingsManager.inMemory(),
		);

		expect(session.getSessionId()).toBe("existing-id");
		expect(session.getSessionFile()).toBe(path);
		expect(console.error).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("rejects an existing fork target without mutating either session", async () => {
		const source = writeSession("source-id");
		const target = writeSession("existing-id");
		const before = [source, target].map((path) => readFileSync(path, "utf8"));
		await expect(
			createSessionManager(
				parseArgs(["--fork", "source-id", "--session-id", "existing-id"]),
				cwd,
				sessionDir,
				SettingsManager.inMemory(),
			),
		).rejects.toBe(exit);

		expect(process.exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Session already exists with id 'existing-id'"),
		);
		expect([source, target].map((path) => readFileSync(path, "utf8"))).toEqual(before);
	});

	it.each(["-bad", "bad id"])("rejects invalid session ID %j before storage changes", (id) => {
		expect(() => validateSessionIdFlags(parseArgs(["--session-id", id]))).toThrow(exit);
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Session id must be non-empty"));
		expect(existsSync(sessionDir)).toBe(false);
	});

	it("rejects a blank name without changing stored session bytes", () => {
		const path = writeSession("existing-id");
		const before = readFileSync(path, "utf8");
		const session = SessionManager.open(path);
		expect(() => applySessionName(parseArgs(["--name", "   "]), session)).toThrow(exit);
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--name requires a non-empty value"));
		expect(session.getSessionName()).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
