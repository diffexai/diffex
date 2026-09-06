import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { materializeJsonlInvocation } from "@earendil-works/diffex-harness-trace";
import { afterEach, describe, expect, it } from "vitest";
import { FileEvolutionPersistence } from "#evolution";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace, type InvocationTrace } from "../../../src/core/invocation-trace.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SKILL_FEEDBACK_TOOL } from "../../../src/core/skill-feedback.ts";
import { createHarness, type Harness } from "../harness.ts";

const SECRET = "PRIVATE_SCORE_REPORT_MARKER";
const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
const traces: InvocationTrace[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const trace of traces.splice(0)) await trace.close();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function report(ratings: unknown[] = []) {
	return fauxAssistantMessage(
		[{ type: "thinking", thinking: SECRET }, fauxToolCall(SKILL_FEEDBACK_TOOL, { ratings })],
		{ stopReason: "toolUse" },
	);
}

async function setup() {
	const harness = await createHarness({ settings: { compaction: { enabled: false } } });
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "agent");
	const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
	const store = new HarnessStateStore(agentDir, { workspace });
	const root = await store.initialize();
	const skills = ["review", "unused"].map((name) => ({
		path: `skills/${name}/SKILL.md`,
		content: `---\nname: ${name}\ndescription: Review ${name}.\n---\nVerify the result.`,
		workspace,
		files: [{ path: "check.md", content: "Check before answering." }],
	}));
	const bundle = await store.saveVersion({ memory: "", skills }, root.manifest.version);
	await store.selectVersion(bundle.manifest.version);
	const sessionManager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
	const { trace } = await createInvocationTrace({ agentDir, sessionManager });
	traces.push(trace);
	await trace.attachSession(sessionManager, "startup");
	const options = {
		cwd: harness.tempDir,
		agentDir,
		modelRuntime: harness.session.modelRuntime,
		model: harness.getModel(),
		resourceLoader: harness.session.resourceLoader,
		settingsManager: harness.settingsManager,
		sessionManager,
		subagents: false as const,
		telemetryContext: trace,
		lifecycleObserver: trace,
	};
	// Exercise the production factory's default consumer, not an injected test scoring callback.
	const { session } = await createAgentSession(options);
	sessions.push(session);
	const directory = join(resolveEvolutionWorkspaceStateDirectory(agentDir, workspace), "evolution");
	const persistence = new FileEvolutionPersistence(directory);
	const revision = {
		scope: { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId! },
		workspace,
		harnessRevision: bundle.manifest.version,
	};
	return { harness, store, bundle, skills, session, options, persistence, revision, trace, directory };
}

function expectPrivate(value: unknown) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	expect(text).not.toContain(SECRET);
	expect(text).not.toContain(SKILL_FEEDBACK_TOOL);
}

describe("per-output skill point application", () => {
	it("scores successful reads and neutral outputs, rejects invalid reports, and resumes without point drift or report leaks", async () => {
		const { harness, store, bundle, session, options, persistence, revision, trace, directory } = await setup();
		const events: unknown[] = [];
		session.subscribe((event) => events.push(event));
		const reference = session.createSkillReferences().find((entry) => entry.name === "review")!;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: bundle.state.skills[0]!.filePath }), {
				stopReason: "toolUse",
			}),
			report([{ skillId: reference.skillId, signal: "helpful" }]),
			(context) => {
				expectPrivate(context);
				return fauxAssistantMessage("Public answer");
			},
			report(),
			fauxAssistantMessage("Another answer"),
			report(),
		]);
		await session.prompt("Read the review skill and answer.");
		await session.prompt("Answer without invoking skills.");
		expect((await persistence.loadSkillScores(store, revision)).map((row) => row.points)).toEqual([-1, -3]);
		const before = await persistence.loadSkillScores(store, revision);
		harness.setResponses([
			fauxAssistantMessage("Invalid feedback"),
			report([{ skillId: reference.skillId, signal: "neutral" }]),
			fauxAssistantMessage("Uninvoked feedback"),
			report([{ skillId: reference.skillId, signal: "helpful" }]),
			fauxAssistantMessage("Missing feedback"),
			fauxAssistantMessage("Not a report"),
		]);
		await session.prompt(`${reference.reference} invalid report`);
		await session.prompt("No invocation");
		await session.prompt("No report");
		expect(await persistence.loadSkillScores(store, revision)).toEqual(before);
		expect(await store.loadCurrent()).toEqual(bundle);
		expectPrivate(session.messages);
		expectPrivate(events);
		expectPrivate(readFileSync(session.sessionFile!, "utf8"));
		expectPrivate(readFileSync(session.exportToJsonl(join(harness.tempDir, "export.jsonl")), "utf8"));
		expectPrivate(readFileSync(trace.destinationPath!, "utf8"));
		const invocation = await materializeJsonlInvocation(trace.destinationPath!);
		expect(invocation.integrity).toBe("complete");
		expectPrivate(invocation);
		for (const file of readdirSync(directory, { recursive: true, withFileTypes: true })) {
			if (file.isFile()) expectPrivate(readFileSync(join(file.parentPath, file.name), "utf8"));
		}
		await session.dispose();
		const { session: resumed } = await createAgentSession({
			...options,
			sessionManager: SessionManager.open(session.sessionFile!),
		});
		sessions.push(resumed);
		harness.setResponses([
			fauxAssistantMessage("Resumed answer"),
			report([{ skillId: reference.skillId, signal: "harmful" }]),
		]);
		await resumed.prompt(`${reference.reference} review this`);
		expect(
			(await new FileEvolutionPersistence(directory).loadSkillScores(store, revision)).map((row) => row.points),
		).toEqual([-2.5, -4]);
		expectPrivate(resumed.messages);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resets UPDATE packages and stops RETIRE accrual, including a report pending during activation", async () => {
		const { harness, store, bundle, skills, session, persistence, revision } = await setup();
		harness.setResponses([fauxAssistantMessage("Before update"), report()]);
		await session.prompt("No invocation");
		const updated = await store.saveVersion(
			{ memory: "", skills: [{ ...skills[0]!, files: [{ path: "check.md", content: "Changed procedure." }] }] },
			bundle.manifest.version,
		);
		harness.setResponses([
			fauxAssistantMessage("Pending output"),
			async () => {
				await store.selectVersion(updated.manifest.version);
				return report();
			},
		]);
		await session.prompt("No invocation before activation");
		expect((await persistence.loadSkillScores(store, revision)).map((row) => row.points)).toEqual([-1, -1]);
		const nextRevision = { ...revision, harnessRevision: updated.manifest.version };
		expect((await persistence.loadSkillScores(store, nextRevision)).map((row) => row.points)).toEqual([0]);
		harness.setResponses([fauxAssistantMessage("After update"), report()]);
		await session.prompt("No invocation after activation");
		expect(session.createSkillReferences().map((entry) => entry.name)).toEqual(["review"]);
		expect((await persistence.loadSkillScores(store, nextRevision)).map((row) => row.points)).toEqual([-1]);
		expect((await persistence.loadSkillScores(store, revision)).map((row) => row.points)).toEqual([-1, -1]);
		expect(await store.loadCurrent()).toEqual(updated);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
