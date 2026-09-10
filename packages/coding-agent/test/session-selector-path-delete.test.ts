import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setKeybindings } from "@diffexai/diffex-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import {
	deleteSessionWithOwnedSubagents,
	SessionSelectorComponent,
} from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSymlinkedSessionPaths(): {
	baseDir: string;
	parentAliasA: string;
	parentAliasB: string;
	childAliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	symlinkSync(sharedDir, aliasASessions);
	symlinkSync(sharedDir, aliasBSessions);

	const parentRealPath = join(sharedDir, "parent.jsonl");
	const childRealPath = join(sharedDir, "child.jsonl");
	writeFileSync(parentRealPath, "parent\n");
	writeFileSync(childRealPath, "child\n");

	return {
		baseDir,
		parentAliasA: join(aliasASessions, "parent.jsonl"),
		parentAliasB: join(aliasBSessions, "parent.jsonl"),
		childAliasB: join(aliasBSessions, "child.jsonl"),
	};
}

function createPersistedParentFixture(parentId = "parent-id"): {
	baseDir: string;
	parentFile: string;
	namespaceDirectory: string;
	ownedDirectory: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "diffex-parent-delete-"));
	const parentFile = join(baseDir, "parent.jsonl");
	writeFileSync(
		parentFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: parentId,
			timestamp: "2026-08-20T00:00:00.000Z",
			cwd: baseDir,
		})}\n`,
	);
	const namespaceDirectory = join(baseDir, ".subagents");
	return {
		baseDir,
		parentFile,
		namespaceDirectory,
		ownedDirectory: join(namespaceDirectory, parentId),
	};
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {
		// session selector uses the global theme instance
		initTheme("dark");
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([sessions[0]!.path]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedPath: string | null = null;
		list.onDeleteSession = async (sessionPath) => {
			deletedPath = sessionPath;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path]);

		list.handleInput("\r");
		expect(confirmationChanges).toEqual([sessions[0]!.path, null]);
		expect(deletedPath).toBe(sessions[0]!.path);
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).join("\n");
		expect(output).toContain("Resume Session (Current Folder)");
		expect(output).not.toContain("Resume Session (All)");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child paths use different symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				path: paths.parentAliasB,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				path: paths.childAliasB,
				parentSessionPath: paths.parentAliasA,
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("sorts threaded sessions by latest activity in their subtree", async () => {
		const parentOne = makeSession({
			id: "parent-one",
			name: "Parent one",
			modified: new Date("2026-01-02T00:00:00.000Z"),
		});
		const parentTwo = makeSession({
			id: "parent-two",
			name: "Parent two",
			modified: new Date("2026-01-01T00:00:00.000Z"),
		});
		const childTwo = makeSession({
			id: "child-two",
			name: "Child two",
			parentSessionPath: parentTwo.path,
			modified: new Date("2026-01-03T00:00:00.000Z"),
		});

		const selector = new SessionSelectorComponent(
			async () => [parentOne, parentTwo, childTwo],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		const parentTwoIndex = output.indexOf("Parent two");
		const childTwoIndex = output.indexOf("└─ Child two");
		const parentOneIndex = output.indexOf("Parent one");

		expect(parentTwoIndex).toBeGreaterThanOrEqual(0);
		expect(childTwoIndex).toBeGreaterThan(parentTwoIndex);
		expect(parentOneIndex).toBeGreaterThan(childTwoIndex);
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [makeSession({ id: "parent", path: paths.parentAliasB, name: "Parent" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			paths.parentAliasA,
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});

	it("trashes only the selected parent's owned directory before deleting the parent", async () => {
		const fixture = createPersistedParentFixture();
		tempDirs.push(fixture.baseDir);
		mkdirSync(fixture.ownedDirectory, { recursive: true });
		writeFileSync(
			join(fixture.ownedDirectory, "child.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "child-id",
				timestamp: "2026-08-20T00:00:00.000Z",
				cwd: fixture.baseDir,
				parentSession: fixture.parentFile,
			})}\n`,
		);
		const siblingDirectory = join(fixture.namespaceDirectory, "other-parent");
		mkdirSync(siblingDirectory);
		writeFileSync(join(siblingDirectory, "sibling.jsonl"), "sibling\n");

		const listed = await SessionManager.list(fixture.baseDir, fixture.baseDir);
		expect(listed.map((session) => session.path)).toEqual([fixture.parentFile]);

		const calls: string[] = [];
		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async (ownedDirectory) => {
				calls.push(`owned:${ownedDirectory}`);
				renameSync(ownedDirectory, join(fixture.baseDir, `trashed-${basename(ownedDirectory)}`));
			},
			async (parentFile) => {
				calls.push(`parent:${parentFile}`);
				renameSync(parentFile, join(fixture.baseDir, "trashed-parent.jsonl"));
				return { ok: true, method: "trash" };
			},
		);

		expect(result).toEqual({ ok: true, method: "trash" });
		expect(calls).toEqual([`owned:${fixture.ownedDirectory}`, `parent:${fixture.parentFile}`]);
		expect(existsSync(fixture.ownedDirectory)).toBe(false);
		expect(existsSync(siblingDirectory)).toBe(true);
		expect(existsSync(fixture.parentFile)).toBe(false);
	});

	it.each(["namespace", "owned"] as const)("deletes the parent when the %s directory is absent", async (missing) => {
		const fixture = createPersistedParentFixture();
		tempDirs.push(fixture.baseDir);
		if (missing === "owned") mkdirSync(fixture.namespaceDirectory);
		let cleanupCalled = false;

		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async () => {
				cleanupCalled = true;
			},
			async (parentFile) => {
				renameSync(parentFile, join(fixture.baseDir, "trashed-parent.jsonl"));
				return { ok: true, method: "trash" };
			},
		);

		expect(result.ok).toBe(true);
		expect(cleanupCalled).toBe(false);
		expect(existsSync(fixture.parentFile)).toBe(false);
	});

	it("retains the parent when owned-directory cleanup fails", async () => {
		const fixture = createPersistedParentFixture();
		tempDirs.push(fixture.baseDir);
		mkdirSync(fixture.ownedDirectory, { recursive: true });
		let parentDeletionCalled = false;

		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async () => {
				throw new Error("trash unavailable");
			},
			async () => {
				parentDeletionCalled = true;
				return { ok: true, method: "trash" };
			},
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("cleanup failed; parent session was retained");
		expect(result.error).toContain("trash unavailable");
		expect(parentDeletionCalled).toBe(false);
		expect(existsSync(fixture.parentFile)).toBe(true);
		expect(existsSync(fixture.ownedDirectory)).toBe(true);
	});

	it("retains the parent when cleanup reports success without moving the owned directory", async () => {
		const fixture = createPersistedParentFixture();
		tempDirs.push(fixture.baseDir);
		mkdirSync(fixture.ownedDirectory, { recursive: true });
		let parentDeletionCalled = false;

		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async () => {},
			async () => {
				parentDeletionCalled = true;
				return { ok: true, method: "trash" };
			},
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("remains after trash operation");
		expect(parentDeletionCalled).toBe(false);
		expect(existsSync(fixture.parentFile)).toBe(true);
	});

	it("reports partial deletion when parent deletion fails after owned cleanup", async () => {
		const fixture = createPersistedParentFixture();
		tempDirs.push(fixture.baseDir);
		mkdirSync(fixture.ownedDirectory, { recursive: true });

		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async (ownedDirectory) => {
				renameSync(ownedDirectory, join(fixture.baseDir, "trashed-owned"));
			},
			async () => ({ ok: false, method: "unlink", error: "parent locked" }),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toBe(
			"Parent-owned subagent sessions were moved to trash, but parent deletion failed: parent locked",
		);
		expect(existsSync(fixture.ownedDirectory)).toBe(false);
		expect(existsSync(fixture.parentFile)).toBe(true);
	});

	it("reports partial deletion when parent deletion throws after owned cleanup", async () => {
		const fixture = createPersistedParentFixture();
		tempDirs.push(fixture.baseDir);
		mkdirSync(fixture.ownedDirectory, { recursive: true });

		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async (ownedDirectory) => {
				renameSync(ownedDirectory, join(fixture.baseDir, "trashed-owned"));
			},
			async () => {
				throw new Error("parent callback failed");
			},
		);

		expect(result).toEqual({
			ok: false,
			method: "trash",
			error: "Parent-owned subagent sessions were moved to trash, but parent deletion failed: parent callback failed",
		});
		expect(existsSync(fixture.ownedDirectory)).toBe(false);
		expect(existsSync(fixture.parentFile)).toBe(true);
	});

	it.each(["namespace-file", "namespace-link", "owned-file", "owned-link"] as const)(
		"rejects an unsafe %s without deleting the parent",
		async (unsafeComponent) => {
			const fixture = createPersistedParentFixture();
			tempDirs.push(fixture.baseDir);
			const linkTarget = join(fixture.baseDir, "link-target");
			mkdirSync(linkTarget);
			if (unsafeComponent === "namespace-file") {
				writeFileSync(fixture.namespaceDirectory, "not a directory\n");
			} else if (unsafeComponent === "namespace-link") {
				symlinkSync(linkTarget, fixture.namespaceDirectory, process.platform === "win32" ? "junction" : "dir");
			} else {
				mkdirSync(fixture.namespaceDirectory);
				if (unsafeComponent === "owned-file") writeFileSync(fixture.ownedDirectory, "not a directory\n");
				else symlinkSync(linkTarget, fixture.ownedDirectory, process.platform === "win32" ? "junction" : "dir");
			}
			let parentDeletionCalled = false;

			const result = await deleteSessionWithOwnedSubagents(
				fixture.parentFile,
				async () => {},
				async () => {
					parentDeletionCalled = true;
					return { ok: true, method: "trash" };
				},
			);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("is not a safe directory");
			expect(parentDeletionCalled).toBe(false);
			expect(existsSync(fixture.parentFile)).toBe(true);
		},
	);

	it("rejects an invalid parent header id without touching another path", async () => {
		const fixture = createPersistedParentFixture("../outside");
		tempDirs.push(fixture.baseDir);
		const outsidePath = join(fixture.baseDir, "outside");
		mkdirSync(outsidePath);
		let cleanupCalled = false;
		let parentDeletionCalled = false;

		const result = await deleteSessionWithOwnedSubagents(
			fixture.parentFile,
			async () => {
				cleanupCalled = true;
			},
			async () => {
				parentDeletionCalled = true;
				return { ok: true, method: "trash" };
			},
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Session id must be non-empty");
		expect(cleanupCalled).toBe(false);
		expect(parentDeletionCalled).toBe(false);
		expect(existsSync(outsidePath)).toBe(true);
		expect(existsSync(fixture.parentFile)).toBe(true);
	});
});
