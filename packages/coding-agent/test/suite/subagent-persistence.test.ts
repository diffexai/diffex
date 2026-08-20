import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	type ChildSnapshotV1,
	decodeSubagentRosterSnapshot,
	encodeSubagentRosterSnapshot,
	ParentOwnedSubagentSessionStore,
	readSelectedBranchSubagentRoster,
	SUBAGENT_ROSTER_CUSTOM_TYPE,
} from "../../src/core/subagents/persistence.ts";

const CHILD_ID_A = "018f4f7c-43b7-7abc-8def-0123456789ab";
const CHILD_ID_B = "018f4f7c-43b7-7abc-8def-0123456789ac";

function childSnapshot(overrides: Partial<ChildSnapshotV1> = {}): ChildSnapshotV1 {
	return {
		name: "alpha",
		task: "Inspect the change",
		status: "idle",
		createdAt: 1,
		updatedAt: 2,
		completedAt: 2,
		result: "done",
		childSessionId: CHILD_ID_A,
		childLeafId: null,
		config: {
			model: { provider: "test", id: "test-model" },
			thinkingLevel: "medium",
			tools: ["read", "grep"],
			harnessRevision: null,
		},
		...overrides,
	};
}

describe("subagent roster persistence codec", () => {
	it("uses only the latest selected-branch snapshot and treats an empty roster as a reset barrier", () => {
		const session = SessionManager.inMemory();
		const original = session.appendCustomEntry(
			SUBAGENT_ROSTER_CUSTOM_TYPE,
			encodeSubagentRosterSnapshot([childSnapshot()]),
		);
		session.appendCustomEntry(SUBAGENT_ROSTER_CUSTOM_TYPE, { schemaVersion: 2, agents: [] });

		const masked = readSelectedBranchSubagentRoster(session);
		expect(masked.found).toBe(true);
		expect(masked.children).toEqual([]);
		expect(masked.warnings).toEqual([
			"Latest subagent roster snapshot is malformed or uses an unsupported schema version",
		]);

		session.branch(original);
		session.appendCustomEntry(SUBAGENT_ROSTER_CUSTOM_TYPE, encodeSubagentRosterSnapshot([]));
		const reset = readSelectedBranchSubagentRoster(session);
		expect(reset.children).toEqual([]);
		expect(reset.warnings).toEqual([]);
	});

	it("validates children independently and isolates identifiable invalid records", () => {
		const invalidTask = { ...childSnapshot({ name: "bad-task", childSessionId: CHILD_ID_B }), task: "" };
		const invalidName = { ...childSnapshot({ childSessionId: CHILD_ID_B }), name: "../escape" };
		const decoded = decodeSubagentRosterSnapshot({
			schemaVersion: 1,
			agents: [childSnapshot(), invalidTask, invalidName],
			futureField: true,
		});

		expect(decoded.recognized).toBe(true);
		expect(decoded.children).toEqual([
			{ kind: "restorable", snapshot: childSnapshot() },
			{
				kind: "isolated",
				name: "bad-task",
				error: "Invalid persisted subagent bad-task: task must be a non-empty string",
			},
		]);
		expect(decoded.warnings).toContain("Omitted subagent roster entry 2 because its name cannot be trusted");
	});

	it("collapses duplicate names and isolates every distinct name claiming one child id", () => {
		const decoded = decodeSubagentRosterSnapshot({
			schemaVersion: 1,
			agents: [
				childSnapshot(),
				childSnapshot({ name: "alpha", childSessionId: CHILD_ID_B }),
				childSnapshot({ name: "beta" }),
			],
		});

		expect(decoded.children).toEqual([
			{ kind: "isolated", name: "alpha", error: "Duplicate persisted subagent name: alpha" },
			{
				kind: "isolated",
				name: "beta",
				error: `Persisted child session ${CHILD_ID_A} is claimed by multiple subagents`,
			},
		]);
	});

	it("rejects invalid values when encoding a snapshot", () => {
		expect(() =>
			encodeSubagentRosterSnapshot([
				childSnapshot({
					config: { ...childSnapshot().config, tools: ["read", "read"] },
				}),
			]),
		).toThrow("config.tools must contain unique built-in tool names");
	});
});

describe("parent-owned subagent session storage", () => {
	const tempDirectories: string[] = [];

	afterEach(() => {
		for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function createParent(): { parent: SessionManager; root: string } {
		const root = mkdtempSync(join(tmpdir(), "diffex-subagent-persistence-"));
		tempDirectories.push(root);
		const parent = SessionManager.create(root, root, { id: "parent-session" });
		parent._persistHeader();
		return { parent, root };
	}

	it("creates the child header synchronously in the validated owned namespace", async () => {
		const { parent, root } = createParent();
		const store = new ParentOwnedSubagentSessionStore(parent);
		const child = store.createChild("alpha", CHILD_ID_A);
		const childFile = child.getSessionFile();

		expect(store.getOwnedDirectory()).toBe(resolve(root, ".subagents", "parent-session"));
		expect(childFile).toBeDefined();
		expect(existsSync(childFile!)).toBe(true);
		expect(readFileSync(childFile!, "utf8").trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(readFileSync(childFile!, "utf8"))).toMatchObject({
			type: "session",
			id: CHILD_ID_A,
			parentSession: "parent-session",
		});

		const listed = await SessionManager.list(root, root);
		expect(listed.map((session) => session.id)).toEqual(["parent-session"]);
	});

	it("rejects invalid names and child ids before creating namespace content", () => {
		const { parent } = createParent();
		const store = new ParentOwnedSubagentSessionStore(parent);

		expect(() => store.createChild("../escape", CHILD_ID_A)).toThrow("Invalid subagent name");
		expect(() => store.createChild("alpha", "../escape")).toThrow("Session id must be non-empty");
		expect(existsSync(store.getOwnedDirectory())).toBe(false);
	});

	it.each(["namespace", "owned directory"])("rejects a linked %s", (component) => {
		const { parent, root } = createParent();
		const outside = mkdtempSync(join(tmpdir(), "diffex-subagent-outside-"));
		tempDirectories.push(outside);
		const namespace = join(root, ".subagents");
		if (component === "namespace") {
			symlinkSync(outside, namespace, process.platform === "win32" ? "junction" : "dir");
		} else {
			const ownedTarget = join(outside, "owned");
			mkdirSync(ownedTarget);
			mkdirSync(namespace);
			symlinkSync(ownedTarget, join(namespace, "parent-session"), process.platform === "win32" ? "junction" : "dir");
		}

		const store = new ParentOwnedSubagentSessionStore(parent);
		expect(() => store.createChild("alpha", CHILD_ID_A)).toThrow("safe directory");
		expect(readdirSync(outside)).toEqual(component === "namespace" ? [] : ["owned"]);
	});

	it("validates child identity and leaf membership before exposing history", () => {
		const { parent } = createParent();
		const store = new ParentOwnedSubagentSessionStore(parent);
		const child = store.createChild("alpha", CHILD_ID_A);
		const leaf = child.appendMessage({ role: "user", content: "child history", timestamp: 1 });

		expect(store.openChild("alpha", CHILD_ID_A, leaf).getLeafId()).toBe(leaf);
		expect(store.openChild("alpha", CHILD_ID_A, null).getLeafId()).toBeNull();
		expect(() => store.openChild("alpha", CHILD_ID_A, "missing-leaf")).toThrow("is unavailable");

		const childFile = child.getSessionFile();
		if (!childFile) throw new Error("Expected child session file");
		const lines = readFileSync(childFile, "utf8").trimEnd().split("\n");
		const header = JSON.parse(lines[0]) as Record<string, unknown>;
		header.parentSession = "different-parent";
		lines[0] = JSON.stringify(header);
		writeFileSync(childFile, `${lines.join("\n")}\n`);
		expect(() => store.openChild("alpha", CHILD_ID_A, leaf)).toThrow("identity mismatch");
	});

	it("rejects a linked child path even when its name claims the expected id", () => {
		const { parent } = createParent();
		const store = new ParentOwnedSubagentSessionStore(parent);
		store.createChild("alpha", CHILD_ID_A);
		const outsideDirectory = join(dirname(store.getOwnedDirectory()), "outside-child");
		mkdirSync(outsideDirectory);
		const claimedFile = join(store.getOwnedDirectory(), `fake_${CHILD_ID_B}.jsonl`);
		symlinkSync(outsideDirectory, claimedFile, process.platform === "win32" ? "junction" : "dir");

		expect(() => store.openChild("beta", CHILD_ID_B, null)).toThrow("not a safe file");
	});
});
