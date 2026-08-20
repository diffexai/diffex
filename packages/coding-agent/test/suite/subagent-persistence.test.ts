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
import type { AgentTool } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { loadEntriesFromFile, persistSessionHeader, SessionManager } from "../../src/core/session-manager.ts";
import {
	type ChildSnapshotV1,
	decodeSubagentRosterSnapshot,
	encodeSubagentRosterSnapshot,
	ParentOwnedSubagentSessionStore,
	readSelectedBranchSubagentRoster,
	SUBAGENT_ROSTER_CUSTOM_TYPE,
} from "../../src/core/subagents/persistence.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

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
		persistSessionHeader(parent);
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

describe("durable subagent lifecycle", () => {
	const harnesses: Harness[] = [];
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (sessions.length > 0) await sessions.pop()?.dispose();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function createRoot(options: { persist?: boolean; subagents?: false } = {}) {
		const harness = await createHarness({
			models: [{ id: "faux-lifecycle", name: "Lifecycle", reasoning: true }],
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		const cwd = join(harness.tempDir, "root");
		const agentDir = join(harness.tempDir, "agent");
		const sessionDir = join(harness.tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				reloadSettings: false,
			},
		});
		const sessionManager =
			options.persist === false ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: harness.getModel("faux-lifecycle"),
			thinkingLevel: "high",
			subagents: options.subagents,
		});
		sessions.push(session);
		return { harness, session, sessionManager, cwd, sessionDir };
	}

	function getTool(session: AgentSession, name: string): AgentTool {
		const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return tool;
	}

	function readSnapshots(sessionFile: string): ChildSnapshotV1[][] {
		return loadEntriesFromFile(sessionFile).flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== SUBAGENT_ROSTER_CUSTOM_TYPE) return [];
			const decoded = decodeSubagentRosterSnapshot(entry.data);
			return [decoded.children.flatMap((child) => (child.kind === "restorable" ? [child.snapshot] : []))];
		});
	}

	it("persists the child header and queued roster before direct spawn starts provider work", async () => {
		const started = deferred<void>();
		const { harness, session, sessionManager, cwd, sessionDir } = await createRoot();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing parent session file");
		let admissionObserved = false;
		harness.setResponses([
			async (_context, request) => {
				const snapshots = readSnapshots(sessionFile);
				const queued = snapshots.find((snapshot) => snapshot[0]?.status === "queued")?.[0];
				const ownedDirectory = resolve(dirname(sessionFile), ".subagents", session.sessionId);
				admissionObserved =
					queued !== undefined &&
					existsSync(ownedDirectory) &&
					readdirSync(ownedDirectory).some((name) => name.endsWith(`_${queued.childSessionId}.jsonl`));
				started.resolve();
				await new Promise<void>((resolvePromise) => {
					request?.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
				});
				return fauxAssistantMessage("stopped");
			},
		]);

		await getTool(session, "spawn_agent").execute("direct-spawn", {
			name: "worker",
			task: "inspect durability",
		});
		const reopened = SessionManager.open(sessionFile, sessionDir, cwd);
		const admitted = readSelectedBranchSubagentRoster(reopened);
		expect(admitted.children[0]).toMatchObject({
			kind: "restorable",
			snapshot: {
				name: "worker",
				task: "inspect durability",
				config: {
					model: { provider: "faux", id: "faux-lifecycle" },
					thinkingLevel: "high",
					tools: ["read", "bash", "edit", "write", "update_plan"],
					harnessRevision: session.activeHarnessVersion ?? null,
				},
			},
		});
		await started.promise;
		expect(admissionObserved).toBe(true);
	});

	it("rejects spawn without provider work when the initial roster cannot persist", async () => {
		const { harness, session, sessionManager } = await createRoot();
		let providerCalls = 0;
		harness.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("unexpected");
			},
		]);
		const append = vi.spyOn(sessionManager, "appendCustomEntry");
		append.mockImplementationOnce((customType, data) => {
			SessionManager.prototype.appendCustomEntry.call(sessionManager, customType, data);
			throw new Error("parent roster unavailable");
		});

		await expect(
			getTool(session, "spawn_agent").execute("failed-spawn", { name: "worker", task: "do not run" }),
		).rejects.toThrow("parent roster unavailable");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		expect(providerCalls).toBe(0);
		await expect(getTool(session, "agents").execute("list", { timeout_ms: 0 })).resolves.toMatchObject({
			details: { agents: [] },
		});
		expect(readSelectedBranchSubagentRoster(sessionManager)).toMatchObject({ found: false, children: [] });
	});

	it("rejects spawn without provider work when the child header cannot persist", async () => {
		const { harness, session } = await createRoot();
		let providerCalls = 0;
		harness.setResponses([
			() => {
				providerCalls += 1;
				return fauxAssistantMessage("unexpected");
			},
		]);
		vi.spyOn(ParentOwnedSubagentSessionStore.prototype, "createChild").mockImplementationOnce(() => {
			throw new Error("child header unavailable");
		});

		await expect(
			getTool(session, "spawn_agent").execute("failed-header", { name: "worker", task: "do not run" }),
		).rejects.toThrow("child header unavailable");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		expect(providerCalls).toBe(0);
		await expect(getTool(session, "agents").execute("list", { timeout_ms: 0 })).resolves.toMatchObject({
			details: { agents: [] },
		});
	});

	it("records lifecycle and child leaf snapshots and exposes later persistence errors", async () => {
		const { harness, session, sessionManager } = await createRoot();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing parent session file");
		harness.setResponses([fauxAssistantMessage("child complete")]);
		const append = vi.spyOn(sessionManager, "appendCustomEntry");
		const originalAppend = append.getMockImplementation();
		let calls = 0;
		append.mockImplementation((customType, data) => {
			calls += 1;
			if (calls === 2) throw new Error("later snapshot unavailable");
			return originalAppend
				? originalAppend(customType, data)
				: SessionManager.prototype.appendCustomEntry.call(sessionManager, customType, data);
		});

		await getTool(session, "spawn_agent").execute("spawn", { name: "worker", task: "finish" });
		const result = await getTool(session, "agents").execute("wait", { timeout_ms: 1_000, until: "all" });
		expect(result.details).toMatchObject({
			agents: [
				{
					name: "worker",
					status: "idle",
					result: "child complete",
					error: "Subagent roster persistence failed: later snapshot unavailable",
				},
			],
		});
		const snapshots = readSnapshots(sessionFile);
		expect(snapshots.map((snapshot) => snapshot[0]?.status)).toEqual(
			expect.arrayContaining(["queued", "running", "idle"]),
		);
		expect(snapshots.some((snapshot) => snapshot[0]?.childLeafId !== null)).toBe(true);
		expect(snapshots.at(-1)?.[0]).toMatchObject({
			status: "idle",
			result: "child complete",
		});
	});

	it("persists active children as interrupted before graceful disposal", async () => {
		const started = deferred<void>();
		const { harness, session, sessionManager } = await createRoot();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing parent session file");
		harness.setResponses([
			async (_context, request) => {
				started.resolve();
				await new Promise<void>((resolvePromise) => {
					request?.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
				});
				return fauxAssistantMessage("stopped");
			},
		]);

		await getTool(session, "spawn_agent").execute("spawn", { name: "worker", task: "keep running" });
		await started.promise;
		await session.dispose();
		const latest = readSnapshots(sessionFile).at(-1)?.[0];
		expect(latest).toMatchObject({ name: "worker", status: "interrupted" });
		expect(latest?.completedAt).toBeTypeOf("number");
	});

	it("still disposes gracefully when the interrupted roster cannot persist", async () => {
		const started = deferred<void>();
		const { harness, session, sessionManager } = await createRoot();
		harness.setResponses([
			async (_context, request) => {
				started.resolve();
				await new Promise<void>((resolvePromise) => {
					request?.signal?.addEventListener("abort", () => resolvePromise(), { once: true });
				});
				return fauxAssistantMessage("stopped");
			},
		]);

		await getTool(session, "spawn_agent").execute("spawn", { name: "worker", task: "keep running" });
		await started.promise;
		const previousLeafId = sessionManager.getLeafId();
		vi.spyOn(sessionManager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("graceful snapshot unavailable");
		});

		await expect(session.dispose()).resolves.toBeUndefined();
		expect(sessionManager.getLeafId()).toBe(previousLeafId);
	});

	it("keeps in-memory, disabled, and unsaved modes ephemeral", async () => {
		const inMemory = await createRoot({ persist: false });
		inMemory.harness.setResponses([fauxAssistantMessage("done")]);
		await getTool(inMemory.session, "spawn_agent").execute("spawn", { name: "worker", task: "ephemeral" });
		await getTool(inMemory.session, "agents").execute("wait", { timeout_ms: 1_000, until: "all" });
		expect(inMemory.sessionManager.getSessionFile()).toBeUndefined();

		const disabled = await createRoot({ subagents: false });
		expect(disabled.session.getToolDefinition("spawn_agent")).toBeUndefined();
		expect(existsSync(resolve(disabled.sessionDir, ".subagents"))).toBe(false);
	});
});
