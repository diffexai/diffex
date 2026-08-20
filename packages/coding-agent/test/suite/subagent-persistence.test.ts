import {
	copyFileSync,
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
import type { FauxModelDefinition } from "@earendil-works/diffex-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import {
	loadEntriesFromFile,
	persistSessionHeader,
	persistSessionState,
	SessionManager,
} from "../../src/core/session-manager.ts";
import {
	type ChildSnapshotV1,
	decodeSubagentRosterSnapshot,
	encodeSubagentRosterSnapshot,
	ParentOwnedSubagentSessionStore,
	readSelectedBranchSubagentRoster,
	SUBAGENT_ROSTER_CUSTOM_TYPE,
} from "../../src/core/subagents/persistence.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred, getLastUserText } from "./subagent-harness.ts";

const CHILD_ID_A = "018f4f7c-43b7-7abc-8def-0123456789ab";
const CHILD_ID_B = "018f4f7c-43b7-7abc-8def-0123456789ac";
const CHILD_ID_C = "018f4f7c-43b7-7abc-8def-0123456789ad";
const CHILD_ID_D = "018f4f7c-43b7-7abc-8def-0123456789ae";

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

	async function createRoot(
		options: {
			persist?: boolean;
			subagents?: false;
			models?: FauxModelDefinition[];
			modelId?: string;
			thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
			tools?: string[];
		} = {},
	) {
		const harness = await createHarness({
			models: options.models ?? [{ id: "faux-lifecycle", name: "Lifecycle", reasoning: true }],
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
			model: harness.getModel(options.modelId ?? "faux-lifecycle"),
			thinkingLevel: options.thinkingLevel ?? "high",
			tools: options.tools,
			subagents: options.subagents,
		});
		sessions.push(session);
		return { harness, services, session, sessionManager, cwd, agentDir, sessionDir };
	}

	async function reopenRoot(
		root: Awaited<ReturnType<typeof createRoot>>,
		options: { modelId?: string; thinkingLevel?: "low" | "high"; tools?: string[] } = {},
	) {
		const sessionFile = root.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing parent session file");
		const services = await createAgentSessionServices({
			cwd: root.cwd,
			agentDir: root.agentDir,
			modelRuntime: root.harness.session.modelRuntime,
			settingsManager: root.harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				reloadSettings: false,
			},
		});
		const sessionManager = SessionManager.open(sessionFile, root.sessionDir, root.cwd);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: root.harness.getModel(options.modelId ?? "faux-lifecycle"),
			thinkingLevel: options.thinkingLevel ?? "high",
			tools: options.tools,
		});
		sessions.push(session);
		return { ...root, services, session, sessionManager };
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

	function persistRoster(sessionManager: SessionManager, agents: unknown[]): void {
		sessionManager.appendCustomEntry(SUBAGENT_ROSTER_CUSTOM_TYPE, { schemaVersion: 1, agents });
		persistSessionState(sessionManager);
	}

	function persistChild(
		root: Awaited<ReturnType<typeof createRoot>>,
		config: ChildSnapshotV1["config"],
		name = "worker",
	): void {
		new ParentOwnedSubagentSessionStore(root.sessionManager).createChild(name, CHILD_ID_A);
		persistRoster(root.sessionManager, [childSnapshot({ name, childSessionId: CHILD_ID_A, config })]);
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

	it("restores terminal and interrupted records without calls, isolates bad histories, and opens lazily on wake", async () => {
		const root = await createRoot();
		const sessionFile = root.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing parent session file");
		const store = new ParentOwnedSubagentSessionStore(root.sessionManager);
		store.createChild("alpha", CHILD_ID_A);
		store.createChild("beta", CHILD_ID_B);
		const corrupt = store.createChild("corrupt", CHILD_ID_C);
		const corruptFile = corrupt.getSessionFile();
		if (!corruptFile) throw new Error("Missing corrupt child file");
		const corruptHeader = JSON.parse(readFileSync(corruptFile, "utf8")) as Record<string, unknown>;
		corruptHeader.parentSession = "another-parent";
		writeFileSync(corruptFile, `${JSON.stringify(corruptHeader)}\n`);
		const config = {
			model: { provider: "faux", id: "faux-lifecycle" },
			thinkingLevel: "high" as const,
			tools: ["read"] as const,
			harnessRevision: root.session.activeHarnessVersion ?? null,
		};
		persistRoster(root.sessionManager, [
			childSnapshot({ name: "alpha", childSessionId: CHILD_ID_A, config }),
			childSnapshot({
				name: "beta",
				childSessionId: CHILD_ID_B,
				status: "running",
				result: undefined,
				completedAt: undefined,
				config,
			}),
			childSnapshot({ name: "corrupt", childSessionId: CHILD_ID_C, config }),
			childSnapshot({ name: "missing", childSessionId: CHILD_ID_D, config }),
		]);
		await root.session.dispose();

		let providerCalls = 0;
		const seenPrompts: string[] = [];
		root.harness.setResponses([
			(context) => {
				providerCalls += 1;
				seenPrompts.push(getLastUserText(context));
				return fauxAssistantMessage("continued");
			},
			(context) => {
				providerCalls += 1;
				seenPrompts.push(getLastUserText(context));
				return fauxAssistantMessage("recovered");
			},
		]);
		const openChild = vi.spyOn(ParentOwnedSubagentSessionStore.prototype, "openChild");
		const reopened = await reopenRoot(root);
		expect(providerCalls).toBe(0);
		expect(openChild).not.toHaveBeenCalled();
		expect(reopened.session.messages).toEqual([]);
		expect(
			reopened.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" || entry.type === "custom_message"),
		).toEqual([]);
		await expect(getTool(reopened.session, "agents").execute("restored", { timeout_ms: 0 })).resolves.toMatchObject({
			details: {
				agents: [
					{ name: "alpha", status: "idle", result: "done" },
					{ name: "beta", status: "interrupted" },
					{ name: "corrupt", status: "failed", error: expect.stringContaining("identity mismatch") },
					{ name: "missing", status: "failed", error: expect.stringContaining("found 0") },
				],
			},
		});
		expect(reopened.services.diagnostics).toEqual(
			expect.arrayContaining([
				{ type: "warning", message: expect.stringContaining("corrupt history is unavailable") },
				{ type: "warning", message: expect.stringContaining("missing history is unavailable") },
			]),
		);

		await getTool(reopened.session, "agent_action").execute("wake-valid", {
			target: "alpha",
			action: "message",
			message: "continue valid",
			wake: true,
		});
		await getTool(reopened.session, "agents").execute("wait-valid", {
			timeout_ms: 1_000,
			targets: ["alpha"],
			until: "all",
		});
		expect(openChild).toHaveBeenCalledTimes(1);

		await getTool(reopened.session, "agent_action").execute("wake-isolated", {
			target: "corrupt",
			action: "message",
			message: "recovery only",
			wake: true,
		});
		await getTool(reopened.session, "agents").execute("wait-isolated", {
			timeout_ms: 1_000,
			targets: ["corrupt"],
			until: "all",
		});
		expect(providerCalls).toBe(2);
		expect(seenPrompts).toEqual(["continue valid", "recovery only"]);
		const latest = readSnapshots(sessionFile).at(-1) ?? [];
		expect(latest.find((entry) => entry.name === "corrupt")?.childSessionId).not.toBe(CHILD_ID_C);
		expect(existsSync(corruptFile)).toBe(true);
	});

	it("isolates duplicate persisted names without blocking a valid sibling", async () => {
		const root = await createRoot();
		new ParentOwnedSubagentSessionStore(root.sessionManager).createChild("alpha", CHILD_ID_A);
		persistRoster(root.sessionManager, [
			childSnapshot({ config: { ...childSnapshot().config, model: { provider: "faux", id: "faux-lifecycle" } } }),
			childSnapshot({ name: "duplicate", childSessionId: CHILD_ID_B }),
			childSnapshot({ name: "duplicate", childSessionId: CHILD_ID_C }),
		]);
		await root.session.dispose();
		const reopened = await reopenRoot(root);
		await expect(getTool(reopened.session, "agents").execute("duplicates", { timeout_ms: 0 })).resolves.toMatchObject(
			{
				details: {
					agents: [
						{ name: "alpha", status: "idle" },
						{ name: "duplicate", status: "failed", error: "Duplicate persisted subagent name: duplicate" },
					],
				},
			},
		);
		expect(reopened.services.diagnostics).toContainEqual({
			type: "warning",
			message: "Duplicate persisted subagent name: duplicate",
		});
	});

	it("uses the complete captured configuration on wake without treating authentication as fallback", async () => {
		const root = await createRoot({
			models: [
				{ id: "captured-model", name: "Captured", reasoning: true },
				{ id: "current-model", name: "Current", reasoning: true },
			],
			modelId: "captured-model",
		});
		const captured = {
			model: { provider: "faux", id: "captured-model" },
			thinkingLevel: "high" as const,
			tools: ["grep"] as const,
			harnessRevision: null,
		};
		persistChild(root, captured);
		await root.session.dispose();
		const reopened = await reopenRoot(root, { modelId: "current-model", thinkingLevel: "low" });
		reopened.session.setActiveToolsByName(["read", "agent_action", "agents"]);
		vi.spyOn(reopened.session.modelRuntime, "hasConfiguredAuth").mockImplementation(() => {
			throw new Error("authentication must not participate in restoration fallback");
		});
		root.harness.setResponses([fauxAssistantMessage("captured configuration used")]);

		await getTool(reopened.session, "agent_action").execute("captured", {
			target: "worker",
			action: "message",
			message: "wake captured",
			wake: true,
		});
		await getTool(reopened.session, "agents").execute("captured-wait", {
			timeout_ms: 1_000,
			targets: ["worker"],
			until: "all",
		});
		const sessionFile = reopened.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing parent session file");
		expect(readSnapshots(sessionFile).at(-1)?.[0]?.config).toEqual(captured);
		expect(
			reopened.services.diagnostics.filter((entry) => entry.message.includes("configuration is unusable")),
		).toEqual([]);
	});

	it("falls back to the complete wake-time parent configuration with one diagnostic", async () => {
		const cases: Array<{
			name: string;
			config: ChildSnapshotV1["config"];
			removeTool?: string;
		}> = [
			{
				name: "model",
				config: {
					model: { provider: "faux", id: "missing-model" },
					thinkingLevel: "high",
					tools: ["read"],
					harnessRevision: null,
				},
			},
			{
				name: "thinking",
				config: {
					model: { provider: "faux", id: "faux-lifecycle" },
					thinkingLevel: "max",
					tools: ["read"],
					harnessRevision: null,
				},
			},
			{
				name: "tool",
				config: {
					model: { provider: "faux", id: "faux-lifecycle" },
					thinkingLevel: "high",
					tools: ["grep"],
					harnessRevision: null,
				},
				removeTool: "grep",
			},
			{
				name: "harness",
				config: {
					model: { provider: "faux", id: "faux-lifecycle" },
					thinkingLevel: "high",
					tools: ["read"],
					harnessRevision: `sha256:${"f".repeat(64)}`,
				},
			},
		];

		for (const testCase of cases) {
			const root = await createRoot();
			persistChild(root, testCase.config);
			await root.session.dispose();
			const reopened = await reopenRoot(root);
			reopened.session.setThinkingLevel("low");
			reopened.session.setActiveToolsByName(["read", "agent_action", "agents"]);
			const availableTools = reopened.session.getAllTools();
			const toolSpy = testCase.removeTool
				? vi
						.spyOn(reopened.session, "getAllTools")
						.mockReturnValue(availableTools.filter((tool) => tool.name !== testCase.removeTool))
				: undefined;
			root.harness.setResponses([fauxAssistantMessage(`fallback ${testCase.name}`)]);
			const diagnosticCount = reopened.services.diagnostics.length;

			await getTool(reopened.session, "agent_action").execute(`fallback-${testCase.name}`, {
				target: "worker",
				action: "message",
				message: `wake ${testCase.name}`,
				wake: true,
			});
			await getTool(reopened.session, "agents").execute(`fallback-wait-${testCase.name}`, {
				timeout_ms: 1_000,
				targets: ["worker"],
				until: "all",
			});
			toolSpy?.mockRestore();

			const addedDiagnostics = reopened.services.diagnostics.slice(diagnosticCount);
			expect(addedDiagnostics, testCase.name).toHaveLength(1);
			expect(addedDiagnostics[0]?.message).toContain("configuration is unusable");
			const sessionFile = reopened.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Missing parent session file");
			expect(readSnapshots(sessionFile).at(-1)?.[0]?.config, testCase.name).toEqual({
				model: { provider: "faux", id: "faux-lifecycle" },
				thinkingLevel: "low",
				tools: ["read"],
				harnessRevision: reopened.session.activeHarnessVersion ?? null,
			});
			await expect(
				getTool(reopened.session, "agents").execute(`fallback-result-${testCase.name}`, {
					timeout_ms: 0,
					targets: ["worker"],
				}),
			).resolves.toMatchObject({
				details: { agents: [{ status: "idle", error: expect.stringContaining("configuration is unusable") }] },
			});
		}
	});

	it("isolates unavailable child histories in forked and imported parent files", async () => {
		const root = await createRoot();
		persistChild(root, {
			model: { provider: "faux", id: "faux-lifecycle" },
			thinkingLevel: "high",
			tools: ["read"],
			harnessRevision: null,
		});
		await root.session.dispose();
		const sourceFile = root.sessionManager.getSessionFile();
		if (!sourceFile) throw new Error("Missing source parent session file");
		const forkDirectory = join(root.harness.tempDir, "fork-sessions");
		const importDirectory = join(root.harness.tempDir, "import-sessions");
		mkdirSync(forkDirectory, { recursive: true });
		mkdirSync(importDirectory, { recursive: true });
		const fork = SessionManager.forkFrom(sourceFile, root.cwd, forkDirectory);
		const importedFile = join(importDirectory, "imported.jsonl");
		copyFileSync(sourceFile, importedFile);
		const imported = SessionManager.open(importedFile, importDirectory, root.cwd);

		for (const sessionManager of [fork, imported]) {
			const services = await createAgentSessionServices({
				cwd: root.cwd,
				agentDir: root.agentDir,
				modelRuntime: root.harness.session.modelRuntime,
				settingsManager: root.harness.settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					reloadSettings: false,
				},
			});
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: root.harness.getModel("faux-lifecycle"),
				thinkingLevel: "high",
			});
			sessions.push(session);
			await expect(getTool(session, "agents").execute("unavailable", { timeout_ms: 0 })).resolves.toMatchObject({
				details: {
					agents: [{ name: "worker", status: "failed", error: expect.stringContaining("history is unavailable") }],
				},
			});
			expect(services.diagnostics).toContainEqual({
				type: "warning",
				message: expect.stringContaining("worker history is unavailable"),
			});
		}
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
