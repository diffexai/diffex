import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { computeHarnessSkillId, HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeterministicSkillLifecycleObserver, FileEvolutionPersistence, StructuredSkillCurator } from "#evolution";
import { createCodingAgentEvolutionRuntime, EvolutionRuntimeCoordinator } from "../../../src/core/evolution-runtime.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace } from "../../../src/core/invocation-trace.ts";
import { LESSON_REPORT_TOOL } from "../../../src/core/lesson-reports.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SKILL_REPORT_TOOL } from "../../../src/core/skill-reports.ts";
import { createHarness } from "../harness.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function report(skills: readonly { skillName: string; signal: "helpful" | "harmful" }[] = []) {
	return fauxAssistantMessage(fauxToolCall(SKILL_REPORT_TOOL.name, { skills }), { stopReason: "toolUse" });
}

async function setup(count = 2, memory = "") {
	const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	cleanups.push(harness.cleanup);
	const agentDir = join(harness.tempDir, "agent");
	const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
	if (!workspace.directoryId) throw new Error("Missing workspace identity");
	const scope = { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId };
	const stateDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace);
	const store = new HarnessStateStore(agentDir, { workspace });
	const empty = await store.initialize();
	const bundle = await store.saveVersion(
		{
			memory,
			skills: Array.from({ length: count }, (_, index) => ({
				path: `skills/skill-${index}/SKILL.md`,
				content: `---\nname: skill-${index}\ndescription: Use skill-${index} for verification.\n---\nRead [guide](guide.md).\n`,
				files: [{ path: "guide.md", content: "Verify the result.\n" }],
				workspace,
			})),
		},
		empty.manifest.version,
		{ evolutionMemory: { nextLessonNumber: memory ? 2 : 1 } },
	);
	await store.selectVersion(bundle.manifest.version);
	const scores = new FileEvolutionPersistence(join(stateDir, "evolution"));
	await scores.registerSkillScoreRevision(scope, workspace, bundle);
	const manager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
	const { trace } = await createInvocationTrace({ agentDir: stateDir, sessionManager: manager });
	cleanups.push(() => trace.close());
	await trace.attachSession(manager, "startup");
	const coordinator = new EvolutionRuntimeCoordinator(trace);
	const options = {
		cwd: harness.tempDir,
		agentDir,
		model: harness.getModel(),
		modelRuntime: harness.session.modelRuntime,
		resourceLoader: harness.session.resourceLoader,
		settingsManager: harness.settingsManager,
		harnessStateStore: store,
		subagents: false as const,
	};
	const { session } = await createAgentSession({
		...options,
		sessionManager: manager,
		harnessVersionBundle: bundle,
		telemetryContext: trace,
		lifecycleObserver: coordinator,
	});
	cleanups.push(() => session.dispose());
	const runtime = await createCodingAgentEvolutionRuntime({
		agentDir: stateDir,
		cwd: harness.tempDir,
		session,
		harnessState: store,
		modelRuntime: session.modelRuntime,
		resourceLoader: session.resourceLoader,
	});
	cleanups.push(() => runtime.stop());
	async function nextSession() {
		const opened = await createAgentSession({
			...options,
			harnessVersionBundle: await store.loadCurrent(),
			sessionManager: SessionManager.inMemory(),
		});
		cleanups.push(() => opened.session.dispose());
		return opened.session;
	}
	async function inputFor(jobId: string) {
		const job = await scores.load(jobId);
		if (!job) throw new Error("Missing job");
		const input = await scores.get(job.inputSnapshot);
		if (!("expectedHarnessBaseVersion" in input)) throw new Error("Missing input snapshot");
		return input;
	}
	return { harness, store, scores, workspace, scope, session, runtime, coordinator, bundle, nextSession, inputFor };
}

describe("Item 4: skill grooming before evolution", () => {
	it.each(["manual", "automatic"] as const)(
		"grooms eleven omissions before the %s snapshot, curation, and next prompt",
		async (trigger) => {
			const env = await setup();
			const curate = vi.spyOn(StructuredSkillCurator.prototype, "curate");
			// Existing non-secret evidence survives retirement; private reports must never add observations.
			const retired = env.bundle.state.skills.find((skill) => skill.name === "skill-0")!;
			const observation = await new DeterministicSkillLifecycleObserver({
				version: "test-1",
				policyVersion: "test-1",
				observations: env.scores,
			}).record({
				scope: env.scope,
				skill: {
					skillId: computeHarnessSkillId(env.workspace, retired.path),
					version: retired.packageVersion,
					contentDigest: retired.contentHash,
					sourceKind: "evolved",
					harnessRevision: env.bundle.manifest.version,
					workspace: env.workspace,
				},
				invocationEvents: ["read"],
				topLevelTaskLineageId: "prior-task",
				traceIds: ["prior-trace"],
				evidenceIds: ["prior-evidence"],
				signal: "helpful",
				signalSource: "direct-user",
				attributionMethod: "direct",
				issueKind: null,
				status: "final",
				timestamp: "2026-08-29T12:00:00.000Z",
				idempotencyKey: "prior-observation",
			});
			// An invalid report contributes no neutral decay.
			env.harness.setResponses([fauxAssistantMessage("Verified."), fauxAssistantMessage("Missing report.")]);
			await env.session.prompt("Verify before the valid reports.");
			expect(
				(await env.scores.loadSkillScores(env.scope, env.workspace, env.bundle.manifest.version)).scores.every(
					(item) => item.points === 0,
				),
			).toBe(true);
			if (trigger === "automatic") {
				// Preserve real settlement/trace/eligibility wiring while crossing 400k tokens without huge prompts.
				const stream = env.session.agent.streamFunction;
				env.session.agent.streamFunction = (model, context, options) => {
					const output = createAssistantMessageEventStream();
					void (async () => {
						for await (const event of await stream(model, context, options)) {
							if (event.type === "done")
								event.message.usage = { ...event.message.usage, input: 37_000, output: 0, totalTokens: 37_000 };
							output.push(event);
						}
						output.end();
					})();
					return output;
				};
				await env.coordinator.replace(env.runtime);
				cleanups.push(() => env.coordinator.stop());
			}
			for (let index = 0; index < 11; index += 1) {
				env.harness.setResponses([
					fauxAssistantMessage("Verified the requested result."),
					report([{ skillName: "skill-1", signal: "helpful" }]),
				]);
				if (index === 10) {
					env.harness.appendResponses(
						Array.from({ length: 30 }, () => (context) => {
							const parameters = context.tools?.find(
								(tool) => tool.name === "submit_evolution_response",
							)?.parameters;
							const schema = JSON.stringify(parameters);
							const fields = (
								parameters as {
									properties: {
										lessons?: { items: { properties: Record<string, { items?: { enum?: string[] } }> } };
									};
								}
							).properties.lessons?.items.properties;
							const source = fields?.sourceLessonRefs?.items?.enum?.[0];
							const evidence = fields?.supportingEvidenceRefs?.items?.enum?.[0];
							return fauxAssistantMessage(
								fauxToolCall(
									"submit_evolution_response",
									schema?.includes('"outlines"')
										? { outlines: [] }
										: schema?.includes('"decisions"')
											? { decisions: [] }
											: {
													complete: true,
													lessons: [
														{
															kind: "successful-strategy",
															summary: "Keep focused verification",
															preconditions: [],
															observedOutcome: "Verification passed",
															...(source
																? { sourceLessonRefs: [source], counterLessonRefs: [] }
																: { supportingEvidenceRefs: [evidence], counterevidenceRefs: [] }),
															applicabilityBoundaries: [],
															uncertainty: null,
															actionableTakeaway: "Verify focused changes",
														},
													],
												},
								),
								{ stopReason: "toolUse" },
							);
						}),
					);
				}
				await env.session.prompt(`Verify result ${index + 1}.`);
				expect(await env.scores.listSkillLifecycleObservations(env.scope)).toEqual([observation]);
			}
			const scores = await env.scores.loadSkillScores(env.scope, env.workspace, env.bundle.manifest.version);
			expect(
				scores.scores.find(
					(item) => item.skillId === computeHarnessSkillId(env.workspace, "skills/skill-0/SKILL.md"),
				)?.points,
			).toBe(-11);
			expect(
				scores.scores.find(
					(item) => item.skillId === computeHarnessSkillId(env.workspace, "skills/skill-1/SKILL.md"),
				)?.points,
			).toBe(11);
			if (trigger === "manual") {
				expect((await env.store.loadCurrent()).manifest.version).toBe(env.bundle.manifest.version);
				await env.runtime.start();
				expect((await env.runtime.control.startManual()).status).toBe("created");
			}
			await vi.waitFor(async () => expect(await env.runtime.control.listJobs()).toHaveLength(1));
			const summary = (await env.runtime.control.listJobs())[0]!;
			await vi.waitFor(
				async () => {
					const job = await env.scores.load(summary.jobId);
					expect(
						job?.outcome,
						JSON.stringify({ stage: job?.stage, reason: job?.reasonCode, message: job?.failureMessage }),
					).toBe("completed");
				},
				{ timeout: 5_000 },
			);
			const input = await env.inputFor(summary.jobId);
			const selected = await env.store.loadCurrent();
			expect(input.trigger).toBe(trigger);
			expect(input.expectedHarnessBaseVersion).toBe(selected.manifest.version);
			expect(input.harness.harnessVersion).toBe(selected.manifest.version);
			expect(
				input.skillCatalog.map((skill) => ({
					name: skill.name,
					version: skill.version,
					contentDigest: skill.contentDigest,
					harnessRevision: skill.harnessRevision,
				})),
			).toEqual(
				selected.state.skills.map((skill) => ({
					name: skill.name,
					version: skill.packageVersion,
					contentDigest: skill.contentHash,
					harnessRevision: selected.manifest.version,
				})),
			);
			expect(selected.state.skills.map((skill) => skill.name)).toEqual(["skill-1"]);
			expect(await env.scores.listSkillLifecycleObservations(env.scope)).toEqual([observation]);
			expect(curate).toHaveBeenCalledTimes(1);
			expect(curate.mock.calls[0]![0].input).toEqual(input);
			expect(env.session.activeHarnessVersion).toBe(env.bundle.manifest.version);
			const next = await env.nextSession();
			env.harness.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain("<name>skill-1</name>");
					expect(context.systemPrompt).not.toContain("<name>skill-0</name>");
					return fauxAssistantMessage("Verified again.");
				},
				report(),
			]);
			await next.prompt("Verify again.");
			expect(next.messages.at(-1), JSON.stringify(next.messages.at(-1))).toMatchObject({
				role: "assistant",
				stopReason: "stop",
			});
			expect(env.harness.getPendingResponseCount()).toBe(0);
			expect(await env.scores.listSkillLifecycleObservations(env.scope)).toEqual([observation]);
		},
	);

	it("freezes one consistent revision after both lesson and skill grooming", async () => {
		const env = await setup(2, "Lesson 1: Old lesson.\n");
		for (let index = 0; index < 11; index += 1) {
			env.harness.setResponses([
				fauxAssistantMessage("Verified."),
				fauxAssistantMessage(fauxToolCall(LESSON_REPORT_TOOL.name, { lessons: [] }), { stopReason: "toolUse" }),
				report([{ skillName: "skill-1", signal: "helpful" }]),
			]);
			await env.session.prompt(`Verify ${index + 1}.`);
		}
		const started = await env.runtime.control.startManual();
		if (started.status !== "created") throw new Error("Expected a job");
		const input = await env.inputFor(started.job.jobId);
		const selected = await env.store.loadCurrent();
		expect(input.harness.memory.trim()).toBe("");
		expect(input.harness.activeMemoryItems).toEqual([]);
		expect(input.expectedHarnessBaseVersion).toBe(selected.manifest.version);
		expect(input.harness.harnessVersion).toBe(selected.manifest.version);
		expect(input.skillCatalog.map((skill) => [skill.name, skill.harnessRevision])).toEqual([
			["skill-1", selected.manifest.version],
		]);
		expect(selected.state.skills.map((skill) => skill.name)).toEqual(["skill-1"]);
		expect(env.harness.getPendingResponseCount()).toBe(0);
		await env.runtime.control.cancelJob(started.job.jobId);
	});

	it.each([0, 10, 11])("grooms a %i-skill catalog only for eligible work", async (count) => {
		const env = await setup(count);
		expect(await env.runtime.control.triggerAutomatic()).toMatchObject({ status: "not-created" });
		expect(await env.store.loadCurrent()).toEqual(env.bundle);
		env.harness.setResponses([
			fauxAssistantMessage("Verified."),
			...(count ? [report([{ skillName: "skill-0", signal: "harmful" }])] : []),
		]);
		await env.session.prompt("Verify result.");
		const started = await env.runtime.control.startManual();
		if (started.status !== "created") throw new Error("Expected a job");
		const input = await env.inputFor(started.job.jobId);
		const selected = await env.store.loadCurrent();
		expect(input.expectedHarnessBaseVersion).toBe(selected.manifest.version);
		expect(input.skillCatalog).toHaveLength(Math.min(count, 10));
		if (count <= 10) expect(selected).toEqual(env.bundle);
		else {
			expect(selected.manifest.base).toBe(env.bundle.manifest.version);
			expect(selected.state.skills.some((skill) => skill.name === "skill-0")).toBe(false);
		}
		await env.runtime.control.cancelJob(started.job.jobId);
		expect(env.harness.getPendingResponseCount()).toBe(0);
	});
});
