import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { materializeJsonlInvocation } from "@earendil-works/diffex-harness-trace";
import { afterEach, describe, expect, it } from "vitest";
import { FileEvolutionPersistence } from "#evolution";
import { createCodingAgentEvolutionRuntime } from "../../../src/core/evolution-runtime.ts";
import { resolveHarnessWorkspace } from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace, type InvocationTrace } from "../../../src/core/invocation-trace.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SKILL_FEEDBACK_TOOL, type SkillFeedbackReport } from "../../../src/core/skill-feedback.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const SECRET = "PRIVATE_SKILL_REPORT_RESPONSE_MARKER";
const harnesses: Harness[] = [];
const traces: InvocationTrace[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	for (const trace of traces.splice(0)) await trace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function report(ratings: unknown[] = []) {
	return fauxAssistantMessage(
		[{ type: "thinking", thinking: SECRET }, fauxToolCall(SKILL_FEEDBACK_TOOL, { ratings })],
		{ stopReason: "toolUse" },
	);
}

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "private-skill-suite-"));
	directories.push(directory);
	const store = new HarnessStateStore(directory);
	const root = await store.initialize();
	const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
	const { trace } = await createInvocationTrace({ agentDir: directory, sessionManager });
	traces.push(trace);
	await trace.attachSession(sessionManager, "startup");
	const reports: SkillFeedbackReport[] = [];
	const extensionEvents: unknown[] = [];
	const harness = await createHarness({
		sessionManager,
		harnessStateStore: store,
		harnessVersionBundle: root,
		telemetryContext: trace,
		lifecycleObserver: trace,
		settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 } },
		consumeSkillFeedback: (value) => {
			reports.push(value);
		},
		extensionFactories: [
			(api) => {
				const observe = (event: unknown) => {
					extensionEvents.push(structuredClone(event));
				};
				api.on("agent_start", observe);
				api.on("agent_end", observe);
				api.on("turn_start", observe);
				api.on("turn_end", observe);
				api.on("message_start", observe);
				api.on("message_update", observe);
				api.on("message_end", observe);
				api.on("context", observe);
				api.on("before_provider_request", observe);
				api.on("after_provider_response", observe);
				api.on("session_before_compact", observe);
			},
		],
	});
	harnesses.push(harness);
	const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
	const bundle = await store.saveVersion(
		{
			memory: "Lesson 1: Use exact file evidence.",
			skills: ["read-review", "other-review"].map((name) => ({
				path: `skills/${name}/SKILL.md`,
				content: `---\nname: ${name}\ndescription: Review ${name}.\n---\nCheck actual files.`,
				workspace,
			})),
		},
		root.manifest.version,
	);
	await harness.session.switchHarnessVersion(bundle.manifest.version);
	const references = harness.session.createSkillReferences();
	return { directory, store, root, bundle, harness, reports, extensionEvents, trace, references };
}

function expectPrivate(value: unknown) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	expect(text).not.toContain(SKILL_FEEDBACK_TOOL);
	expect(text).not.toContain(SECRET);
}

describe("secret per-output evolved-skill reports", () => {
	it("reports after tool and final outputs, isolated from sessions, extensions, exports, compaction, traces and snapshots", async () => {
		const { directory, store, bundle, harness, reports, references, extensionEvents, trace } = await setup();
		const skill = bundle.state.skills[0];
		const reference = references.find((entry) => entry.name === skill.name)!;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: skill.filePath }), { stopReason: "toolUse" }),
			(context, options) => {
				expect(context.messages.at(-2)?.role).toBe("toolResult");
				expect(JSON.stringify(context)).toContain(skill.content.replaceAll("\n", "\\n"));
				expect(options?.onPayload).toBeUndefined();
				expect(options?.onResponse).toBeUndefined();
				return report([{ skillId: reference.skillId, signal: "helpful" }]);
			},
			(context) => {
				expectPrivate(context);
				return fauxAssistantMessage("Public final answer");
			},
			report(),
		]);
		await harness.session.prompt("Read the review skill, then answer.");
		expect(harness.faux.state.callCount).toBe(4);
		expect(reports).toHaveLength(2);
		expect(reports[0].invokedSkillIds).toEqual([reference.skillId]);
		expect(reports[0].ratings).toEqual([{ skillId: reference.skillId, signal: "helpful" }]);
		expect(reports[1].invokedSkillIds).toEqual([]);
		expect(reports[0].outputId).not.toBe(reports[1].outputId);
		expect(getAssistantTexts(harness)).toEqual(["", "Public final answer"]);
		expectPrivate(harness.session.messages);
		expectPrivate(harness.events);
		expectPrivate(extensionEvents);
		expectPrivate(readFileSync(harness.session.sessionFile!, "utf8"));
		const tracePath = trace.destinationPath!;
		expect(tracePath).toBeDefined();
		expectPrivate(readFileSync(tracePath, "utf8"));
		const invocation = await materializeJsonlInvocation(tracePath);
		expect(invocation.integrity).toBe("complete");
		expect(invocation.evidence.length).toBeGreaterThan(0);
		expectPrivate(invocation);
		expectPrivate(readFileSync(harness.session.exportToJsonl(join(directory, "export.jsonl")), "utf8"));
		expectPrivate(readFileSync(await harness.session.exportToHtml(join(directory, "export.html")), "utf8"));

		const runtime = await createCodingAgentEvolutionRuntime({
			agentDir: directory,
			cwd: harness.tempDir,
			session: harness.session,
			harnessState: store,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
		});
		try {
			const started = await runtime.control.startManual();
			expect(started.status).toBe("created");
			if (started.status !== "created") throw new Error("Expected a frozen evolution snapshot");
			const persistence = new FileEvolutionPersistence(join(directory, "evolution"));
			const job = await persistence.load(started.job.jobId);
			if (!job) throw new Error("Expected persisted job");
			const snapshot = await persistence.get(job.inputSnapshot);
			expect(snapshot).toMatchObject({
				expectedHarnessBaseVersion: bundle.manifest.version,
				skillCatalog: expect.any(Array),
			});
			expectPrivate(snapshot);
			const files = readdirSync(join(directory, "evolution"), { recursive: true, withFileTypes: true });
			for (const file of files) {
				if (file.isFile()) expectPrivate(readFileSync(join(file.parentPath, file.name), "utf8"));
			}
			await runtime.control.cancelJob(started.job.jobId);
		} finally {
			await runtime.stop();
		}

		harness.setResponses([
			(context) => {
				expectPrivate(context);
				return fauxAssistantMessage("Public compaction summary");
			},
		]);
		await harness.session.compact();
		expectPrivate(harness.session.messages);
		expectPrivate(harness.session.sessionManager.getEntries());
		expectPrivate(extensionEvents);
		expect(harness.faux.state.callCount).toBe(5);
	});

	it("counts force-loaded and explicit references only when delivered, not when queued or merely catalogued", async () => {
		const { harness, references, reports } = await setup();
		const reference = references[0];
		harness.setResponses([
			async () => {
				await harness.session.followUp(`${reference.reference} queued task`);
				return fauxAssistantMessage("First answer");
			},
			report(),
			fauxAssistantMessage("Queued answer"),
			report([{ skillId: reference.skillId, signal: "harmful" }]),
			fauxAssistantMessage("Explicit answer"),
			report([{ skillId: reference.skillId, signal: "helpful" }]),
			fauxAssistantMessage("No invocation"),
			report(),
		]);
		await harness.session.prompt("First task");
		await harness.session.prompt(`${reference.reference.replace(' load="force"', "")} explicit task`);
		await harness.session.prompt("No skill used");
		expect(reports.map((entry) => entry.invokedSkillIds)).toEqual([[], [reference.skillId], [reference.skillId], []]);
		expect(reports.map((entry) => entry.ratings)).toEqual([
			[],
			[{ skillId: reference.skillId, signal: "harmful" }],
			[{ skillId: reference.skillId, signal: "helpful" }],
			[],
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["neutral", "uninvoked"])("discards %s claims without changing the next conversation", async (kind) => {
		const { harness, references, reports } = await setup();
		harness.setResponses([
			fauxAssistantMessage("First public answer"),
			report([
				{
					skillId: references[kind === "uninvoked" ? 1 : 0].skillId,
					signal: kind === "neutral" ? "neutral" : "helpful",
				},
			]),
			(context) => {
				expectPrivate(context);
				return fauxAssistantMessage("Second public answer");
			},
			report(),
		]);
		await harness.session.prompt(`${references[0].reference} first task`);
		expect(reports).toEqual([]);
		await harness.session.prompt("Second task");
		expect(reports).toHaveLength(1);
		expect(getAssistantTexts(harness)).toEqual(["First public answer", "Second public answer"]);
		expectPrivate(harness.events);
	});

	it.each(["error", "aborted", "length"] as const)("does not report incomplete %s outputs", async (stopReason) => {
		const { harness, reports } = await setup();
		harness.session.setAutoRetryEnabled(false);
		harness.setResponses([fauxAssistantMessage("Incomplete output", { stopReason })]);
		await harness.session.prompt("Task");
		expect(reports).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("pins a pending report to the output revision and skips reports after skills are removed", async () => {
		const { harness, store, root, bundle, reports, references } = await setup();
		harness.setResponses([
			fauxAssistantMessage("Public answer"),
			async () => {
				await store.selectVersion(root.manifest.version);
				return report([{ skillId: references[0].skillId, signal: "helpful" }]);
			},
			fauxAssistantMessage("No active skills"),
		]);
		await harness.session.prompt(`${references[0].reference} task`);
		expect(reports[0].harnessRevision).toBe(bundle.manifest.version);
		await harness.session.prompt("Next task");
		expect(reports).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(3);
	});
});
