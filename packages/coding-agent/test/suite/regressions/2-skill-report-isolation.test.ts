import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/diffex-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { FileEvolutionPersistence } from "#evolution";
import { materializeJsonlInvocation } from "#harness-trace";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createCodingAgentEvolutionRuntime } from "../../../src/core/evolution-runtime.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../../../src/core/invocation-trace.ts";
import { LESSON_REPORT_PROMPT, LESSON_REPORT_TOOL } from "../../../src/core/lesson-reports.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	createSkillReportContinuation,
	resolveSkillReport,
	SKILL_REPORT_PROMPT,
	SKILL_REPORT_TOOL,
	type ValidatedSkillReport,
} from "../../../src/core/skill-reports.ts";
import { createSkill } from "../../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { createHarness, getMessageText } from "../harness.ts";

const MARKER = "PRIVATE_SKILL_REPORT_RESPONSE";
const INSTRUCTIONS = "Read the target and verify its result before concluding.";

function report(skills: unknown) {
	return fauxAssistantMessage(fauxToolCall(SKILL_REPORT_TOOL.name, { skills }, { id: MARKER }), {
		stopReason: "toolUse",
	});
}

async function readTree(directory: string): Promise<string> {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map((entry) =>
				entry.isDirectory() ? readTree(join(directory, entry.name)) : readFile(join(directory, entry.name), "utf8"),
			),
		)
	).join("\n");
}

function expectPrivate(value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	for (const marker of [
		SKILL_REPORT_PROMPT,
		SKILL_REPORT_TOOL.name,
		MARKER,
		LESSON_REPORT_PROMPT,
		LESSON_REPORT_TOOL.name,
	]) {
		expect(text).not.toContain(marker);
	}
}

describe("Item 2: private per-output skill reports", () => {
	const cleanups: (() => Promise<void>)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function setup({ memory = "", names = ["review", "verify"] } = {}) {
		const observedExtensions: unknown[] = [];
		const harness = await createHarness({
			settings: {
				compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(diffex) => {
					const observe = (event: unknown) => {
						observedExtensions.push(structuredClone(event));
					};
					diffex.on("agent_start", observe);
					diffex.on("agent_end", observe);
					diffex.on("context", observe);
					diffex.on("before_provider_request", observe);
					diffex.on("after_provider_response", observe);
				},
			],
		});
		cleanups.push(harness.cleanup);
		const agentDir = join(harness.tempDir, "agent");
		const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
		const store = new HarnessStateStore(agentDir, { workspace });
		const initial = await store.initialize();
		const bundle = await store.saveVersion(
			{
				memory,
				skills: names.map((name) => ({
					path: `skills/${name}/SKILL.md`,
					content: `---\nname: ${name}\ndescription: Use ${name} to check results.\n---\n\n${INSTRUCTIONS}\n`,
					workspace,
				})),
			},
			initial.manifest.version,
		);
		await store.selectVersion(bundle.manifest.version);
		const installed = [
			createSkill({
				name: "review",
				description: "Installed review, not an evolved skill.",
				filePath: join(agentDir, "installed", "SKILL.md"),
				baseDir: join(agentDir, "installed"),
				sourceInfo: createSyntheticSourceInfo(agentDir, { source: "test-installed" }),
				content: "Installed review instructions.",
			}),
		];
		const loader = new DefaultResourceLoader({
			cwd: harness.tempDir,
			agentDir,
			settingsManager: harness.settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionsOverride: () => harness.session.resourceLoader.getExtensions(),
			skillsOverride: () => ({ skills: installed, diagnostics: [] }),
		});
		await loader.reload();
		const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace);
		const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
		const { trace } = await createInvocationTrace({ agentDir: stateDir, sessionManager: manager });
		cleanups.push(() => trace.close());
		await trace.attachSession(manager, "startup");
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: loader,
			settingsManager: harness.settingsManager,
			sessionManager: manager,
			harnessStateStore: store,
			harnessVersionBundle: bundle,
			telemetryContext: trace,
			lifecycleObserver: trace,
			subagents: false,
			tools: ["read"],
		});
		cleanups.push(() => session.dispose());
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(structuredClone(event)));
		return {
			harness,
			session,
			manager,
			store,
			bundle,
			workspace,
			stateDir,
			agentDir,
			loader,
			installed,
			events,
			observedExtensions,
		};
	}

	it("uses SDK wiring for every output without recursive assessments or leaks into context, exports, compaction, traces or snapshots", async () => {
		const env = await setup({ memory: "Lesson 1: Verify results.\n" });
		const calls: { context: Context; options: SimpleStreamOptions | undefined }[] = [];
		const lessonReport = fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }), {
			stopReason: "toolUse",
		});
		env.harness.setResponses(
			[
				fauxAssistantMessage(fauxToolCall("read", { path: env.bundle.state.skills[0]!.filePath }), {
					stopReason: "toolUse",
				}),
				lessonReport,
				report([
					{ skillName: "review-Evolved", signal: "helpful" },
					{ skillName: "verify", signal: "harmful" },
				]),
				fauxAssistantMessage("Checked the requested input and verified its contents."),
				lessonReport,
				report([]),
				fauxAssistantMessage("The follow-up is complete."),
				lessonReport,
				report([{ skillName: "review-Evolved", signal: "helpful" }]),
			].map((response) => (context, options) => {
				calls.push({ context: { ...context, messages: structuredClone(context.messages) }, options });
				return response;
			}),
		);
		await env.session.prompt("Read the evolved review skill and verify the result.");
		await env.session.prompt("Confirm the result using the skill already loaded.");
		expect(calls).toHaveLength(9);
		for (const index of [2, 5, 8]) {
			const main = calls[index - 2]!;
			const assessment = calls[index]!;
			expect(assessment.context.systemPrompt).toBe(main.context.systemPrompt);
			expect(assessment.context.systemPrompt?.split("<name>review-Evolved</name>")).toHaveLength(2);
			expect(assessment.context.messages.slice(0, main.context.messages.length)).toEqual(main.context.messages);
			expect(getMessageText(assessment.context.messages.at(-1))).toBe(SKILL_REPORT_PROMPT);
			expect(
				assessment.context.messages.slice(main.context.messages.length, -1).map((message) => message.role),
			).toEqual(index === 2 ? ["assistant", "toolResult"] : ["assistant"]);
			expect(JSON.stringify(assessment.context.messages)).toContain(INSTRUCTIONS);
			expect(assessment.context.tools).toEqual([SKILL_REPORT_TOOL]);
			expect(assessment.options?.telemetryContext).toBe(NOOP_TELEMETRY_CONTEXT);
			expect(assessment.options?.sessionId).toBeUndefined();
			expect(assessment.options?.onPayload).toBeUndefined();
			expect(assessment.options?.onResponse).toBeUndefined();
			expect(assessment.options?.transport).toBe("sse");
			expectPrivate(main.context);
		}
		const scores = new FileEvolutionPersistence(join(env.stateDir, "evolution"));
		if (!env.workspace.directoryId) throw new Error("Missing workspace directory ID");
		const scope = { repositoryId: env.workspace.repositoryId, scopeId: env.workspace.directoryId };
		const snapshot = await scores.loadSkillScores(scope, env.workspace, env.bundle.manifest.version);
		expect(snapshot.scores).toHaveLength(2);
		for (const [name, points] of [
			["review-Evolved", 1],
			["verify", -3.5],
		] as const) {
			const skill = env.loader.getSkills().skills.find((skill) => skill.name === name)!;
			expect(snapshot.scores.find((item) => item.skillId === skill.skillId)?.points).toBe(points);
		}
		expect(await scores.listSkillLifecycleObservations(scope)).toEqual([]);
		expect(env.session.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
		expect(env.observedExtensions.some((event) => JSON.stringify(event).includes("agent_end"))).toBe(true);
		expectPrivate(env.events);
		expectPrivate(env.observedExtensions);
		expectPrivate(env.manager.getEntries());
		expectPrivate(await readFile(env.session.exportToJsonl(join(env.agentDir, "export.jsonl")), "utf8"));
		expectPrivate(await readFile(await env.session.exportToHtml(join(env.agentDir, "export.html")), "utf8"));
		const traces = (await readdir(join(env.stateDir, "traces"))).filter((path) => path.endsWith(".jsonl"));
		expect(traces.length).toBeGreaterThanOrEqual(2);
		for (const file of traces) {
			const path = join(env.stateDir, "traces", file);
			expectPrivate(await readFile(path, "utf8"));
			const invocation = await materializeJsonlInvocation(path);
			expect(invocation.integrity).toBe("complete");
			expect(invocation.evidence.length).toBeGreaterThan(0);
			expectPrivate(invocation);
		}
		const evolution = await createCodingAgentEvolutionRuntime({
			agentDir: env.stateDir,
			cwd: env.harness.tempDir,
			session: env.session,
			harnessState: env.store,
			modelRuntime: env.session.modelRuntime,
			resourceLoader: env.loader,
		});
		cleanups.push(() => evolution.stop());
		expect((await evolution.control.startManual()).status).toBe("created");
		expectPrivate(await readTree(env.stateDir));
		const compactContexts: Context[] = [];
		env.harness.setResponses(
			[0, 1].map(() => (context) => {
				compactContexts.push({ ...context, messages: structuredClone(context.messages) });
				return fauxAssistantMessage("Summary: verified the input.");
			}),
		);
		await env.session.compact();
		expect(compactContexts).toHaveLength(2);
		expectPrivate(compactContexts);
		expectPrivate(env.manager.getEntries());
	});

	it("binds names, workspace and package versions before output despite a pending revision switch, update and name collision", async () => {
		const env = await setup();
		let selected = env.bundle;
		const reports: ValidatedSkillReport[] = [];
		env.session.agent.preparePrivateContinuation = createSkillReportContinuation({
			getBundle: () => selected,
			getCatalog: () => env.loader.getSkills(),
			getOutputId: () => "test-output",
			workspace: env.workspace,
			stream: (model, context, options) => env.session.modelRuntime.streamSimple(model, context, options),
			consume: async (value) => {
				reports.push(value);
			},
		});
		env.harness.setResponses([
			async () => {
				selected = await env.store.saveVersion(
					{
						memory: "",
						skills: [
							{
								path: "skills/review/SKILL.md",
								content: "---\nname: review\ndescription: A new procedure.\n---\n\nChanged instructions.\n",
								workspace: env.workspace,
							},
						],
					},
					selected.manifest.version,
				);
				await env.store.selectVersion(selected.manifest.version);
				return fauxAssistantMessage("Main output finished after the skill update.");
			},
			async () => {
				// This new installed alias hides the evolved skill in the live catalog, but not this output's binding.
				env.installed.push({ ...env.installed[0]!, name: "review-Evolved", skillId: "new-installed-alias" });
				await env.loader.reload();
				return report([{ skillName: "review-Evolved", signal: "helpful" }]);
			},
		]);
		await env.session.prompt("Use the original review procedure.");
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			outputId: "test-output",
			workspace: env.workspace,
			harnessRevision: env.bundle.manifest.version,
			judgments: [
				{
					item: {
						packageVersion: env.bundle.state.skills[0]!.packageVersion,
						contentDigest: env.bundle.state.skills[0]!.contentHash,
					},
					signal: "helpful",
				},
			],
		});
		expect(reports[0]?.harnessRevision).not.toBe(selected.manifest.version);
		expect(reports[0]?.judgments[0]?.item.packageVersion).not.toBe(selected.state.skills[0]!.packageVersion);
		expectPrivate(env.events);
	});

	it("consumes only fully valid sparse or empty reports, rejecting installed, unknown, ambiguous, duplicate and malformed references", async () => {
		const env = await setup();
		const consumed: ValidatedSkillReport[] = [];
		env.session.agent.preparePrivateContinuation = createSkillReportContinuation({
			getBundle: () => env.session.harnessVersionBundle,
			getCatalog: () => env.loader.getSkills(),
			getOutputId: () => "test-output",
			workspace: env.workspace,
			stream: (model, context, options) => env.session.modelRuntime.streamSimple(model, context, options),
			consume: async (value) => {
				consumed.push(value);
			},
		});
		const bad = [
			null,
			{},
			[{ skillName: 1, signal: "helpful" }],
			[{ skillName: "verify", signal: "neutral" }],
			[{ skillName: "verify", signal: "helpful", extra: true }],
			[{ skillName: "review", signal: "helpful" }],
			[
				{ skillName: "verify", signal: "helpful" },
				{ skillName: "missing", signal: "harmful" },
			],
			...["helpful", "harmful"].map((signal) => [
				{ skillName: "verify", signal: "helpful" },
				{ skillName: "verify", signal },
			]),
		];
		for (const response of [
			...bad.map(report),
			...(["stop", "length", "error", "aborted"] as const).map((stopReason) => ({ ...report([]), stopReason })),
			fauxAssistantMessage(MARKER, { stopReason: "error", errorMessage: MARKER }),
			fauxAssistantMessage("not a report"),
			fauxAssistantMessage(
				[
					fauxToolCall(SKILL_REPORT_TOOL.name, { skills: [] }),
					fauxToolCall(SKILL_REPORT_TOOL.name, { skills: [] }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("wrong_tool", { skills: [] }), { stopReason: "toolUse" }),
			report([]),
			report([{ skillName: "verify", signal: "harmful" }]),
		]) {
			env.harness.setResponses([fauxAssistantMessage("normal answer"), response]);
			await env.session.prompt("Continue checking.");
		}
		expect(consumed).toHaveLength(2);
		expect(consumed[0]?.judgments).toEqual([]);
		expect(consumed[1]?.judgments).toMatchObject([{ signal: "harmful" }]);
		const binding = consumed[0]!;
		const catalog = env.loader.getSkills();
		const evolved = catalog.skills.find((skill) => skill.name === "verify")!;
		const ambiguous = { skills: [...catalog.skills, { ...evolved, skillId: "another-id" }], diagnostics: [] };
		expect(
			resolveSkillReport(report([{ skillName: "verify", signal: "helpful" }]), binding, ambiguous),
		).toBeUndefined();
		const aliases = { skills: [...catalog.skills, { ...evolved, name: "alias" }], diagnostics: [] };
		expect(
			resolveSkillReport(
				report([
					{ skillName: "verify", signal: "helpful" },
					{ skillName: "alias", signal: "harmful" },
				]),
				binding,
				aliases,
			),
		).toBeUndefined();
		for (const changed of [{ version: "changed" }, { contentDigest: "changed" }, { harnessRevision: "changed" }]) {
			expect(
				resolveSkillReport(report([{ skillName: "verify", signal: "helpful" }]), binding, {
					skills: [{ ...evolved, ...changed }],
					diagnostics: [],
				}),
			).toBeUndefined();
		}
		expectPrivate(env.events);
		expectPrivate(env.manager.getEntries());
		expectPrivate(await readTree(env.stateDir));
	});

	it("keeps lesson and skill failures independent without changing the conversation", async () => {
		const env = await setup({ memory: "Lesson 1: Verify results.\n" });
		const calls: string[] = [];
		env.harness.setResponses(
			[
				fauxAssistantMessage("First answer."),
				fauxAssistantMessage(MARKER, { stopReason: "error", errorMessage: MARKER }),
				report([]),
				fauxAssistantMessage("Second answer."),
				fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }), { stopReason: "toolUse" }),
				fauxAssistantMessage(MARKER, { stopReason: "error", errorMessage: MARKER }),
			].map((response) => (context) => {
				calls.push(context.tools?.[0]?.name ?? "");
				return response;
			}),
		);
		await env.session.prompt("First check.");
		await env.session.prompt("Second check.");
		expect(calls).toEqual([
			"read",
			LESSON_REPORT_TOOL.name,
			SKILL_REPORT_TOOL.name,
			"read",
			LESSON_REPORT_TOOL.name,
			SKILL_REPORT_TOOL.name,
		]);
		expectPrivate(env.events);
		expectPrivate(env.observedExtensions);
		expectPrivate(await readTree(env.stateDir));
	});

	it("does not assess installed-only catalogs, inactive harnesses, other workspaces or failed main outputs", async () => {
		const empty = await setup({ names: [] });
		empty.harness.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("<name>review</name>");
				return fauxAssistantMessage("ordinary answer");
			},
		]);
		await empty.session.prompt("Hello");
		expect(getMessageText(empty.session.messages.at(-1))).toBe("ordinary answer");
		expect(empty.harness.faux.state.callCount).toBe(1);
		const active = await setup();
		active.harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "main failure" })]);
		await active.session.prompt("Hello");
		expect(active.harness.faux.state.callCount).toBe(1);
		for (const binding of [
			{ bundle: undefined, workspace: empty.workspace },
			{ bundle: active.bundle, workspace: empty.workspace },
		]) {
			const consumed: ValidatedSkillReport[] = [];
			empty.session.agent.preparePrivateContinuation = createSkillReportContinuation({
				getBundle: () => binding.bundle,
				getCatalog: () => empty.loader.getSkills(),
				getOutputId: () => "unused",
				workspace: binding.workspace,
				stream: (model, context, options) => empty.session.modelRuntime.streamSimple(model, context, options),
				consume: async (value) => {
					consumed.push(value);
				},
			});
			const callsBefore = empty.harness.faux.state.callCount;
			empty.harness.setResponses([fauxAssistantMessage("ordinary answer"), report([])]);
			await empty.session.prompt("Use the installed review skill.");
			expect(getMessageText(empty.session.messages.at(-1))).toBe("ordinary answer");
			expect(empty.harness.faux.state.callCount).toBe(callsBefore + 1);
			expect(empty.harness.getPendingResponseCount()).toBe(1);
			expect(consumed).toEqual([]);
			expect(empty.loader.getSkills().skills).toEqual(empty.installed);
		}
		expect(await empty.store.loadCurrent()).toEqual(empty.bundle);
		expectPrivate(empty.events);
	});
});
