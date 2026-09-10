import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fauxAssistantMessage } from "@diffexai/diffex-ai";
import {
	readJsonlTraceFile,
	type TraceFooterRecord,
	type TraceRecord,
	type TraceSessionAttachRecord,
	type TraceSpanEventRecord,
} from "@diffexai/diffex-harness-trace";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvolutionScope } from "#evolution";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { TraceEvidenceCatalog } from "../src/core/evolution-runtime.ts";
import { resolveEvolutionWorkspaceStateDirectory, resolveHarnessWorkspace } from "../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../src/core/invocation-trace.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsconfigPath = resolve(__dirname, "../../../tsconfig.json");
const FAUX_EXTENSION_SOURCE = `
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@diffexai/diffex-ai/compat";

const faux = registerFauxProvider();
faux.setResponses([
	process.env.DIFFEX_TRACE_FAUX_FAILURE === "1"
		? fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "intentional tracing test failure",
			})
		: process.env.DIFFEX_TRACE_SKILL_PATH
			? fauxAssistantMessage(fauxToolCall("read", { path: process.env.DIFFEX_TRACE_SKILL_PATH }), {
					stopReason: "toolUse",
				})
			: fauxAssistantMessage("first response"),
	fauxAssistantMessage("replacement response"),
]);

export default function (diffex) {
	const model = faux.getModel();
	diffex.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	diffex.registerCommand("replace-trace-session", {
		description: "Replace the active session during tracing tests",
		handler: async (_args, context) => {
			await context.newSession({
				withSession: async (replacement) => {
					await replacement.sendUserMessage("replacement prompt");
				},
			});
		},
	});
}
`;

interface TestDirectories {
	root: string;
	agentDir: string;
	projectDir: string;
	extensionPath: string;
}

interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

const tempDirectories: string[] = [];
const activeChildren = new Set<ChildProcessWithoutNullStreams>();

afterEach(() => {
	for (const child of activeChildren) child.kill("SIGKILL");
	activeChildren.clear();
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function setup(): TestDirectories {
	const root = mkdtempSync(join(tmpdir(), "diffex-invocation-trace-"));
	tempDirectories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const extensionPath = join(root, "faux-extension.ts");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(extensionPath, FAUX_EXTENSION_SOURCE);
	return { root, agentDir, projectDir, extensionPath };
}

function commonArgs(directories: TestDirectories): string[] {
	return ["-e", directories.extensionPath, "--model", "faux/faux-1"];
}

function startCli(
	directories: TestDirectories,
	args: string[],
	extraEnv?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, [`--import=${import.meta.resolve("tsx")}`, cliPath, ...args], {
		cwd: directories.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: directories.agentDir,
			DIFFEX_OFFLINE: "1",
			TSX_TSCONFIG_PATH: tsconfigPath,
			...extraEnv,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	activeChildren.add(child);
	return child;
}

async function collectCli(child: ChildProcessWithoutNullStreams): Promise<CliResult> {
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return await new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			activeChildren.delete(child);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			activeChildren.delete(child);
			resolvePromise({ code, signal, stdout, stderr });
		});
	});
}

async function waitForStdout(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		let stdout = "";
		const timeout = setTimeout(() => {
			child.stdout.off("data", onData);
			reject(new Error(`Timed out waiting for RPC output containing ${expected}`));
		}, 10_000);
		const onData = (chunk: Buffer) => {
			stdout += chunk.toString();
			if (!stdout.includes(expected)) return;
			clearTimeout(timeout);
			child.stdout.off("data", onData);
			resolvePromise();
		};
		child.stdout.on("data", onData);
	});
}

async function runCli(directories: TestDirectories, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<CliResult> {
	const child = startCli(directories, args, extraEnv);
	const resultPromise = collectCli(child);
	child.stdin.end();
	return resultPromise;
}

function tracePaths(agentDir: string): string[] {
	const roots = [agentDir];
	const workspaceRoot = join(agentDir, "evolution-workspaces");
	try {
		roots.push(
			...readdirSync(workspaceRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(workspaceRoot, entry.name)),
		);
	} catch {}
	return roots
		.flatMap((root) => {
			const directory = join(root, "traces");
			try {
				return readdirSync(directory)
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => join(directory, name));
			} catch {
				return [];
			}
		})
		.sort();
}

function traceStorageDirectory(path: string): string {
	return dirname(dirname(path));
}

function onlyTracePath(agentDir: string): string {
	const paths = tracePaths(agentDir);
	expect(paths).toHaveLength(1);
	const [path] = paths;
	if (!path) throw new Error("Invocation trace file was not found");
	return path;
}

async function readTrace(path: string): Promise<readonly TraceRecord[]> {
	const result = await readJsonlTraceFile(path);
	expect(result.diagnostics).toEqual([]);
	return result.records;
}

function sessionFile(agentDir: string): string {
	const sessionsRoot = join(agentDir, "sessions");
	for (const directoryName of readdirSync(sessionsRoot)) {
		const directory = join(sessionsRoot, directoryName);
		for (const fileName of readdirSync(directory)) {
			if (fileName.endsWith(".jsonl")) return join(directory, fileName);
		}
	}
	throw new Error("Persisted session file was not found");
}

function attachments(records: readonly TraceRecord[]): readonly TraceSessionAttachRecord[] {
	return records.filter((record): record is TraceSessionAttachRecord => record.type === "session_attach");
}

function footer(records: readonly TraceRecord[]): TraceFooterRecord | undefined {
	return records.find((record): record is TraceFooterRecord => record.type === "trace_footer");
}

describe("CLI invocation tracing", () => {
	it("locks an active trace until the invocation closes", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		await trace.startSpan({ name: "test.operation" }, () => {});
		const path = trace.destinationPath;
		if (!path) throw new Error("Invocation trace path was not created");

		await expect(lockfile.check(path, { realpath: false })).resolves.toBe(true);
		await trace.close();
		await expect(lockfile.check(path, { realpath: false })).resolves.toBe(false);
	});

	it("publishes settled operations while the invocation remains running", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		await trace.attachSession(manager, "startup");
		const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
		const catalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });

		expect(await catalog.highWaterCursor(scope)).toBe(0);
		const firstEntryOrdinal = manager.getEntryCount();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first operation" }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("first response"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "operation-1" },
			},
			() => {},
		);
		await trace.startSpan({ name: "test.task" }, () => {});
		const firstPath = trace.destinationPath;
		if (!firstPath) throw new Error("Invocation trace path was not created");
		await trace.operationSettled({
			operationId: "operation-1",
			taskLineageId: "operation-1",
			sessionManager: manager,
			firstEntryOrdinal,
		});

		await expect(lockfile.check(firstPath, { realpath: false })).resolves.toBe(false);
		expect(await catalog.highWaterCursor(scope)).toBe(1);
		expect(await catalog.listSuccessful(scope, 0, 1)).toHaveLength(1);
		expect(footer(await readTrace(firstPath))?.terminationStatus).toBe("completed");
		expect((await readTrace(firstPath)).find((record) => record.type === "session_segment")).toMatchObject({
			taskLineageId: "operation-1",
		});

		const secondEntryOrdinal = manager.getEntryCount();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second operation" }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("second response"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "operation-2" },
			},
			() => {},
		);
		await trace.startSpan({ name: "test.task" }, () => {});
		const secondPath = trace.destinationPath;
		if (!secondPath) throw new Error("Second invocation trace path was not created");
		expect(secondPath).not.toBe(firstPath);
		await expect(lockfile.check(secondPath, { realpath: false })).resolves.toBe(true);
		await trace.operationSettled({
			operationId: "operation-2",
			sessionManager: manager,
			firstEntryOrdinal: secondEntryOrdinal,
		});

		expect(await catalog.highWaterCursor(scope)).toBe(2);
		expect(await catalog.listSuccessful(scope, 1, 2)).toHaveLength(1);
		expect(tracePaths(directories.agentDir)).toHaveLength(2);
		await trace.close();
		expect(tracePaths(directories.agentDir)).toHaveLength(2);
	});

	it("switches trace storage when the active workspace changes", async () => {
		const directories = setup();
		const secondProjectDir = join(directories.root, "second-project");
		const secondStorageDir = join(directories.root, "second-evolution-state");
		mkdirSync(secondProjectDir);
		const firstManager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const secondManager = SessionManager.create(secondProjectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({
			agentDir: directories.agentDir,
			sessionManager: firstManager,
		});
		await trace.attachSession(firstManager, "startup");
		firstManager.appendMessage({ role: "user", content: "workspace A", timestamp: Date.now() });
		firstManager.appendMessage(fauxAssistantMessage("workspace A response"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "workspace-a", "diffex.operation.kind": "prompt" },
			},
			() => {},
		);
		await trace.operationSettled({
			operationId: "workspace-a",
			sessionManager: firstManager,
			firstEntryOrdinal: 0,
		});

		await trace.setStorageDirectory(secondStorageDir);
		await trace.attachSession(secondManager, "switch");
		secondManager.appendMessage({ role: "user", content: "workspace B", timestamp: Date.now() });
		secondManager.appendMessage(fauxAssistantMessage("workspace B response"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "workspace-b", "diffex.operation.kind": "prompt" },
			},
			() => {},
		);
		await trace.operationSettled({
			operationId: "workspace-b",
			sessionManager: secondManager,
			firstEntryOrdinal: 0,
		});

		const firstRecords = await readTrace(onlyTracePath(directories.agentDir));
		const secondRecords = await readTrace(onlyTracePath(secondStorageDir));
		expect(attachments(firstRecords)).toHaveLength(1);
		expect(attachments(firstRecords)[0]?.path).toBe(firstManager.getSessionFile());
		expect(attachments(secondRecords)).toHaveLength(1);
		expect(attachments(secondRecords)[0]?.path).toBe(secondManager.getSessionFile());
		expect(JSON.stringify(secondRecords)).not.toContain(firstManager.getSessionFile());
		await trace.close();
	});

	it("settles concurrent process traces without overwriting either file", async () => {
		const directories = setup();
		const peerProjectDir = join(directories.root, "peer-project");
		mkdirSync(peerProjectDir);
		const firstManager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const secondManager = SessionManager.create(peerProjectDir, join(directories.agentDir, "sessions"));
		const [{ trace: firstTrace }, { trace: secondTrace }] = await Promise.all([
			createInvocationTrace({ agentDir: directories.agentDir, sessionManager: firstManager }),
			createInvocationTrace({ agentDir: directories.agentDir, sessionManager: secondManager }),
		]);
		await Promise.all([
			firstTrace.attachSession(firstManager, "startup"),
			secondTrace.attachSession(secondManager, "startup"),
		]);
		await Promise.all([
			firstTrace.startSpan({ name: "test.task" }, () => {}),
			secondTrace.startSpan({ name: "test.task" }, () => {}),
		]);
		firstManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first process" }],
			timestamp: Date.now(),
		});
		secondManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second process" }],
			timestamp: Date.now(),
		});
		firstManager.appendMessage(fauxAssistantMessage("first process response"));
		secondManager.appendMessage(fauxAssistantMessage("second process response"));
		await Promise.all([
			firstTrace.startSpan(
				{
					name: "diffex.coding_agent.operation",
					attributes: { "diffex.operation.id": "first-operation" },
				},
				() => {},
			),
			secondTrace.startSpan(
				{
					name: "diffex.coding_agent.operation",
					attributes: { "diffex.operation.id": "second-operation" },
				},
				() => {},
			),
		]);
		const firstPath = firstTrace.destinationPath;
		const secondPath = secondTrace.destinationPath;
		if (!firstPath || !secondPath) throw new Error("Concurrent invocation trace paths were not created");
		expect(firstPath).not.toBe(secondPath);

		await Promise.all([
			firstTrace.operationSettled({
				operationId: "first-operation",
				sessionManager: firstManager,
				firstEntryOrdinal: 0,
			}),
			secondTrace.operationSettled({
				operationId: "second-operation",
				sessionManager: secondManager,
				firstEntryOrdinal: 0,
			}),
		]);

		expect(tracePaths(directories.agentDir)).toHaveLength(2);
		await expect(Promise.all([lockfile.check(firstPath), lockfile.check(secondPath)])).resolves.toEqual([
			false,
			false,
		]);
		const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
		const firstCatalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });
		const secondCatalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });
		expect(await Promise.all([firstCatalog.highWaterCursor(scope), secondCatalog.highWaterCursor(scope)])).toEqual([
			2, 2,
		]);
		const materializations = await firstCatalog.listSuccessful(scope, 0, 2);
		expect(materializations).toHaveLength(2);
		expect(new Set(materializations.map((entry) => entry.materializationId)).size).toBe(2);
		await Promise.all([firstTrace.close(), secondTrace.close()]);
	});

	it("keeps overlapping operations in one immutable trace interval", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		await trace.attachSession(manager, "startup");
		const firstEntryOrdinal = manager.getEntryCount();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "overlapping operations" }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("response"));
		let releaseFirst: (() => void) | undefined;
		const firstOperation = trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "first-operation" },
			},
			() =>
				new Promise<void>((resolveOperation) => {
					releaseFirst = resolveOperation;
				}),
		);
		await vi.waitFor(() => expect(releaseFirst).toBeDefined());
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "second-operation" },
			},
			() => {},
		);
		await trace.operationSettled({ operationId: "second-operation", sessionManager: manager, firstEntryOrdinal });
		const path = trace.destinationPath;
		if (!path) throw new Error("Overlapping invocation trace path was not created");
		await expect(lockfile.check(path, { realpath: false })).resolves.toBe(true);

		releaseFirst?.();
		await firstOperation;
		await trace.operationSettled({ operationId: "first-operation", sessionManager: manager, firstEntryOrdinal });

		await expect(lockfile.check(path, { realpath: false })).resolves.toBe(false);
		expect(tracePaths(directories.agentDir)).toEqual([path]);
		const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
		const catalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });
		const [materialization] = await catalog.listSuccessful(scope, 0, await catalog.highWaterCursor(scope));
		const sessionEvidence =
			materialization?.invocation.evidence.filter((entry) => entry.kind === "session_item") ?? [];
		expect(sessionEvidence).toHaveLength(2);
		expect(new Set(sessionEvidence.map((entry) => entry.evidenceId)).size).toBe(2);
		await trace.close();
	});

	it("records completed and resumed persisted invocations", async () => {
		const directories = setup();
		const first = await runCli(directories, [...commonArgs(directories), "-p", "hello"]);
		expect(first).toMatchObject({ code: 0, signal: null, stdout: "first response\n", stderr: "" });

		const firstTracePath = onlyTracePath(directories.agentDir);
		const firstRecords = await readTrace(firstTracePath);
		expect(attachments(firstRecords)).toHaveLength(1);
		expect(attachments(firstRecords)[0]).toMatchObject({ reason: "startup", sessionFormat: "coding-agent" });
		expect(firstRecords.some((record) => record.type === "harness_activate")).toBe(true);
		expect(firstRecords.some((record) => record.type === "session_segment")).toBe(true);
		expect(footer(firstRecords)?.terminationStatus).toBe("completed");

		if (process.platform !== "win32") {
			expect(statSync(dirname(firstTracePath)).mode & 0o777).toBe(0o700);
			expect(statSync(firstTracePath).mode & 0o777).toBe(0o600);
		}

		const persistedSession = sessionFile(directories.agentDir);
		const resumed = await runCli(directories, [
			...commonArgs(directories),
			"--session",
			persistedSession,
			"-p",
			"again",
		]);
		expect(resumed.code).toBe(0);

		const allTracePaths = tracePaths(directories.agentDir);
		expect(allTracePaths).toHaveLength(2);
		const resumedRecords = await readTrace(allTracePaths[1]);
		expect(attachments(resumedRecords)[0]).toMatchObject({ reason: "resume", path: persistedSession });
		expect(footer(resumedRecords)?.terminationStatus).toBe("completed");
	});

	it("records immutable skill availability, listing, and read observations", async () => {
		const directories = setup();
		const skillDirectory = join(directories.projectDir, "traced-skill");
		const skillPath = join(skillDirectory, "SKILL.md");
		mkdirSync(skillDirectory);
		writeFileSync(
			skillPath,
			"---\nname: traced-skill\ndescription: Trace skill observations\n---\n\n# Traced skill\n",
		);

		const result = await runCli(
			directories,
			[...commonArgs(directories), "--skill", skillPath, "-p", "inspect the skill"],
			{ DIFFEX_TRACE_SKILL_PATH: skillPath },
		);

		expect(result).toMatchObject({ code: 0, signal: null, stdout: "replacement response\n", stderr: "" });
		const records = await readTrace(onlyTracePath(directories.agentDir));
		const operationStart = records.find(
			(record) =>
				record.type === "span_start" &&
				record.name === "diffex.coding_agent.operation" &&
				record.attributes["diffex.operation.kind"] === "prompt",
		);
		expect(operationStart).toMatchObject({
			type: "span_start",
			attributes: { "diffex.task.lineage.id": expect.any(String) },
		});
		if (operationStart?.type !== "span_start") throw new Error("Prompt operation span was not recorded");
		const operationSkillEvents = records.filter(
			(record): record is TraceSpanEventRecord =>
				record.type === "span_event" && record.spanId === operationStart.spanId,
		);
		const readEvent = operationSkillEvents.find((event) => event.name === "diffex.skill.read");
		const readSkillId = readEvent?.attributes["diffex.skill.id"];
		expect(readSkillId).toEqual(expect.stringMatching(/^skill:[a-f0-9]{64}$/));
		const skillEvents = operationSkillEvents.filter((event) => event.attributes["diffex.skill.id"] === readSkillId);
		expect(skillEvents.map((event) => event.name)).toEqual([
			"diffex.skill.available",
			"diffex.skill.listed",
			"diffex.skill.read",
		]);
		for (const event of skillEvents) {
			expect(event.attributes).toMatchObject({
				"diffex.skill.id": expect.stringMatching(/^skill:[a-f0-9]{64}$/),
				"diffex.skill.version": expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
				"diffex.skill.content_digest": expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
				"diffex.skill.source_kind": "installed",
				"diffex.workspace.repository_id": expect.any(String),
			});
		}
		expect(JSON.stringify(records)).not.toContain("diffex.skill.used");
	});

	it("does not store invocation traces when persisted self-evolution is off", async () => {
		const directories = setup();
		writeFileSync(join(directories.agentDir, "settings.json"), JSON.stringify({ evolution: { enabled: false } }));

		const result = await runCli(directories, [...commonArgs(directories), "-p", "hello"]);

		expect(result).toMatchObject({ code: 0, signal: null, stdout: "first response\n", stderr: "" });
		expect(tracePaths(directories.agentDir)).toEqual([]);
	});

	it("attaches a new binding when the active session is replaced", async () => {
		const directories = setup();
		const result = await runCli(directories, [...commonArgs(directories), "-p", "/replace-trace-session"]);
		expect(result.code).toBe(0);

		const records = await readTrace(onlyTracePath(directories.agentDir));
		expect(attachments(records).map((attachment) => attachment.reason)).toEqual(["startup", "new"]);
		expect(new Set(attachments(records).map((attachment) => attachment.bindingId)).size).toBe(2);
		expect(footer(records)?.terminationStatus).toBe("completed");
	});

	it("does not trace explicitly ephemeral commands", async () => {
		const directories = setup();
		expect((await runCli(directories, ["--help"])).code).toBe(0);
		expect((await runCli(directories, [...commonArgs(directories), "--list-models"])).code).toBe(0);
		expect((await runCli(directories, [...commonArgs(directories), "--no-session", "-p", "hello"])).code).toBe(0);
		expect(tracePaths(directories.agentDir)).toEqual([]);
	});

	it("does not create a trace for persisted startup and routine shutdown", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });

		await trace.attachSession(manager, "startup");
		await trace.harnessActivated("version-1");
		await trace.close();

		expect(trace.destinationPath).toBeUndefined();
		expect(tracePaths(directories.agentDir)).toEqual([]);
	});

	it("starts tracing in the same session after self-evolution is enabled", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({
			agentDir: directories.agentDir,
			sessionManager: manager,
			enabled: false,
		});
		await trace.attachSession(manager, "startup");

		const disabledEntryOrdinal = manager.getEntryCount();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "disabled operation" }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("disabled response"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "disabled-operation" },
			},
			() => {},
		);
		await trace.operationSettled({
			operationId: "disabled-operation",
			sessionManager: manager,
			firstEntryOrdinal: disabledEntryOrdinal,
		});
		expect(tracePaths(directories.agentDir)).toEqual([]);

		await trace.setEnabled(true);
		const enabledEntryOrdinal = manager.getEntryCount();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "enabled operation" }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("enabled response"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "enabled-operation" },
			},
			() => {},
		);
		await trace.operationSettled({
			operationId: "enabled-operation",
			sessionManager: manager,
			firstEntryOrdinal: enabledEntryOrdinal,
		});

		const records = await readTrace(onlyTracePath(directories.agentDir));
		expect(records.find((record) => record.type === "session_segment")).toMatchObject({
			operationId: "enabled-operation",
			cursor: { start: { entryOrdinal: enabledEntryOrdinal } },
		});
		expect(JSON.stringify(records)).not.toContain("disabled-operation");
		await trace.close();
	});

	it("discards an open trace and stops collecting after self-evolution is disabled", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		await trace.attachSession(manager, "startup");
		await trace.recordDiagnostics([{ type: "warning", message: "open trace" }]);
		expect(tracePaths(directories.agentDir)).toHaveLength(1);

		await trace.setEnabled(false);
		expect(tracePaths(directories.agentDir)).toEqual([]);

		await trace.startSpan({ name: "test.operation" }, () => {});
		await trace.recordDiagnostics([{ type: "warning", message: "disabled trace" }]);
		expect(tracePaths(directories.agentDir)).toEqual([]);
		await trace.close();
	});

	it("keeps exit-only startup, resume, and switch flows out of evolution", async () => {
		const directories = setup();
		const initial = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const replacementDirectory = join(directories.projectDir, "replacement");
		mkdirSync(replacementDirectory);
		const replacement = SessionManager.create(replacementDirectory, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({
			agentDir: directories.agentDir,
			sessionManager: initial,
		});
		await trace.attachSession(initial, "startup");
		await trace.harnessActivated("version-1");
		await trace.attachSession(replacement, "switch");
		await trace.close();
		const resumed = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: initial });
		await resumed.trace.attachSession(initial, "resume");
		await resumed.trace.close();

		const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
		const catalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });
		expect(tracePaths(directories.agentDir)).toEqual([]);
		expect(await catalog.highWaterCursor(scope)).toBe(0);
		expect(await catalog.listSuccessful(scope, 0, 0)).toEqual([]);
	});

	it.each([
		{ terminationStatus: "completed" as const, expectedRawTraceCount: 0 },
		{ terminationStatus: "aborted" as const, expectedRawTraceCount: 1 },
	])(
		"keeps lifecycle extension hooks out of evolution after $terminationStatus shutdown",
		async ({ terminationStatus, expectedRawTraceCount }) => {
			const directories = setup();
			const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
			const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
			await trace.attachSession(manager, "startup");
			await trace.harnessActivated("version-1");
			await trace.startSpan(
				{
					name: "diffex.coding_agent.extension_hook",
					attributes: {
						"diffex.extension.hook": "session_start",
						"diffex.extension.path": "/extensions/widget.ts",
					},
				},
				() => {},
			);
			await trace.close(terminationStatus);

			const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
			const catalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });
			expect(tracePaths(directories.agentDir)).toHaveLength(expectedRawTraceCount);
			expect(await catalog.listSuccessful(scope, 0, await catalog.highWaterCursor(scope))).toEqual([]);
			expect(await catalog.excludedThroughCursor(scope, 0, await catalog.highWaterCursor(scope))).toBe(
				expectedRawTraceCount,
			);
		},
	);

	it("removes a completed prompt trace when no substantive payload was recorded", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		await trace.attachSession(manager, "startup");
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "empty-prompt", "diffex.operation.kind": "prompt" },
			},
			() => {},
		);
		await trace.operationSettled({ operationId: "empty-prompt", sessionManager: manager, firstEntryOrdinal: 0 });

		expect(trace.destinationPath).toBeUndefined();
		expect(tracePaths(directories.agentDir)).toEqual([]);
		await trace.close();
	});

	it("keeps a substantive prompt eligible while excluding its trailing shutdown", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		await trace.attachSession(manager, "startup");
		const firstEntryOrdinal = manager.getEntryCount();
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Make a focused change" }],
			timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("Focused change verified"));
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: {
					"diffex.operation.id": "prompt-operation",
					"diffex.operation.kind": "prompt",
					"diffex.task.lineage.id": "prompt-operation",
				},
			},
			() => {},
		);
		await trace.operationSettled({
			operationId: "prompt-operation",
			taskLineageId: "prompt-operation",
			sessionManager: manager,
			firstEntryOrdinal,
		});
		await trace.startSpan(
			{
				name: "diffex.coding_agent.operation",
				attributes: { "diffex.operation.id": "exit-operation", "diffex.operation.kind": "abort" },
			},
			() => {},
		);
		await trace.operationSettled({
			operationId: "exit-operation",
			sessionManager: manager,
			firstEntryOrdinal: manager.getEntryCount(),
		});

		const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
		const catalog = new TraceEvidenceCatalog({ agentDir: directories.agentDir, scope });
		const materializations = await catalog.listSuccessful(scope, 0, await catalog.highWaterCursor(scope));
		expect(materializations).toHaveLength(1);
		expect(
			materializations[0]?.invocation.evidence.some((entry) => JSON.stringify(entry).includes("exit-operation")),
		).toBe(false);
		expect(
			materializations[0]?.invocation.evidence.some((entry) =>
				entry.order.causalIdentifiers.some(
					(identifier) => identifier.name === "diffex.task.lineage.id" && identifier.value === "prompt-operation",
				),
			),
		).toBe(true);
		await trace.close();
	});

	it("continues after trace creation fails and reports one warning", async () => {
		const directories = setup();
		const workspace = await resolveHarnessWorkspace(directories.projectDir);
		const storageDirectory = resolveEvolutionWorkspaceStateDirectory(directories.agentDir, workspace.workspace);
		mkdirSync(storageDirectory, { recursive: true });
		writeFileSync(join(storageDirectory, "traces"), "not a directory");

		const result = await runCli(directories, [...commonArgs(directories), "-p", "hello"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("first response\n");
		expect(result.stderr.match(/Invocation tracing is unavailable/g)).toHaveLength(1);
		expect(tracePaths(directories.agentDir)).toEqual([]);
	});

	it("marks a failed invocation as failed", async () => {
		const directories = setup();
		const result = await runCli(directories, [...commonArgs(directories), "-p", "fail"], {
			DIFFEX_TRACE_FAUX_FAILURE: "1",
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("intentional tracing test failure");
		const tracePath = onlyTracePath(directories.agentDir);
		const records = await readTrace(tracePath);
		expect(footer(records)?.terminationStatus).toBe("failed");
		const scope: EvolutionScope = { repositoryId: "global", scopeId: "global" };
		const catalog = new TraceEvidenceCatalog({ agentDir: traceStorageDirectory(tracePath), scope });
		expect(await catalog.listSuccessful(scope, 0, await catalog.highWaterCursor(scope))).toHaveLength(1);
	});

	it.each([
		{ signal: "SIGTERM" as const, exitCode: 143 },
		...(process.platform === "win32" ? [] : [{ signal: "SIGHUP" as const, exitCode: 129 }]),
	])("marks $signal-driven RPC shutdown as aborted", async ({ signal, exitCode }) => {
		const directories = setup();
		const child = startCli(directories, [...commonArgs(directories), "--mode", "rpc"]);
		const resultPromise = collectCli(child);
		const ready = waitForStdout(child, '"id":"trace-ready"');
		child.stdin.write(`${JSON.stringify({ id: "trace-ready", type: "get_state" })}\n`);
		await ready;

		child.kill(signal);
		const result = await resultPromise;
		expect(result.code).toBe(exitCode);
		expect(result.signal).toBeNull();

		const records = await readTrace(onlyTracePath(directories.agentDir));
		expect(footer(records)?.terminationStatus).toBe("aborted");
	});

	it("keeps runtime behavior passive after a trace writer failure", async () => {
		const directories = setup();
		const manager = SessionManager.create(directories.projectDir, join(directories.agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: directories.agentDir, sessionManager: manager });
		let finishOperation: (() => void) | undefined;
		const operation = trace.startSpan(
			{ name: "test.operation" },
			() =>
				new Promise<void>((resolveOperation) => {
					finishOperation = resolveOperation;
				}),
		);
		await vi.waitFor(() => expect(trace.destinationPath).toBeDefined());
		const probePath = join(directories.root, "probe", "writer.jsonl");
		await mkdir(dirname(probePath), { recursive: true });
		const probe = await open(probePath, "wx");
		const fileHandlePrototype = Object.getPrototypeOf(probe) as { writeFile: typeof probe.writeFile };
		await probe.close();
		const writeFailure = vi
			.spyOn(fileHandlePrototype, "writeFile")
			.mockRejectedValue(new Error("simulated trace write failure"));

		await expect(trace.attachSession(manager, "startup")).resolves.toBeUndefined();
		manager.appendSessionInfo("writer survived");
		finishOperation?.();
		await operation;
		await expect(
			trace.operationSettled({ operationId: "operation", sessionManager: manager, firstEntryOrdinal: 0 }),
		).resolves.toBeUndefined();
		writeFailure.mockRestore();
		await trace.close("completed");

		const result = await readJsonlTraceFile(trace.destinationPath!);
		expect(result.records.map((record) => record.type)).toEqual(["trace_header", "span_start"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing_footer");
	});
});
