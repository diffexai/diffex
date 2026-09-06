import { access } from "node:fs/promises";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEvolutionPersistence } from "#evolution";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type CodingAgentEvolutionRuntime,
	createCodingAgentEvolutionRuntime,
} from "../../../src/core/evolution-runtime.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createInvocationTrace, type InvocationTrace } from "../../../src/core/invocation-trace.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SKILL_FEEDBACK_TOOL } from "../../../src/core/skill-feedback.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
const runtimes: CodingAgentEvolutionRuntime[] = [];
const traces: InvocationTrace[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.stop();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const trace of traces.splice(0)) await trace.close();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function response(output: Record<string, unknown>) {
	return fauxAssistantMessage(fauxToolCall("submit_evolution_response", output), { stopReason: "toolUse" });
}

describe("grooming before evolution snapshots", () => {
	it.each([
		{ count: 2, outputs: 8, removed: true },
		{ count: 11, outputs: 1, removed: true },
		{ count: 2, outputs: 1, removed: false },
	])("freezes a groomed $count-skill catalog after $outputs neutral outputs", async ({ count, outputs, removed }) => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
		const state = new HarnessStateStore(agentDir, { workspace });
		const root = await state.initialize();
		const skills = Array.from({ length: count }, (_, index) => {
			const name = index === 0 ? "unused" : `keep-${index}`;
			return {
				path: `skills/${name}/SKILL.md`,
				content: `---\nname: ${name}\ndescription: Verify ${name}.\n---\nCheck the result.`,
				workspace,
				files: [{ path: "check.md", content: "Verify the result." }],
			};
		});
		const original = await state.saveVersion({ memory: "", skills }, root.manifest.version);
		await state.selectVersion(original.manifest.version);
		const sessionManager = SessionManager.create(harness.tempDir, join(agentDir, "sessions"));
		const workspaceDir = resolveEvolutionWorkspaceStateDirectory(agentDir, workspace);
		const { trace } = await createInvocationTrace({ agentDir: workspaceDir, sessionManager });
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
		};
		const { session } = await createAgentSession({ ...options, telemetryContext: trace, lifecycleObserver: trace });
		sessions.push(session);
		const invoked = session.createSkillReferences().filter((skill) => skill.name !== "unused");
		for (let output = 0; output < outputs; output += 1) {
			harness.setResponses([
				fauxAssistantMessage("Verified the result."),
				fauxAssistantMessage(
					fauxToolCall(SKILL_FEEDBACK_TOOL, {
						ratings: invoked.map((skill) => ({ skillId: skill.skillId, signal: "helpful" })),
					}),
					{ stopReason: "toolUse" },
				),
			]);
			await session.prompt(`${invoked.map((skill) => skill.reference).join(" ")} Verify this change.`);
		}
		await trace.close();
		const persistence = new FileEvolutionPersistence(join(workspaceDir, "evolution"));
		const scope = { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId! };
		const revision = { scope, workspace, harnessRevision: original.manifest.version };
		const scores = await persistence.loadSkillScores(state, revision);
		expect(scores.find((score) => !invoked.some((skill) => skill.skillId === score.skillId))!.points).toBe(-outputs);
		// Another activation has advanced the pointer without refreshing this session.
		const selected = await state.saveVersion(
			{ memory: "Lesson 1: Verify the selected revision.\n" },
			original.manifest.version,
		);
		await state.selectVersion(selected.manifest.version);
		expect(session.activeHarnessVersion).toBe(original.manifest.version);
		const runtime = await createCodingAgentEvolutionRuntime({
			agentDir: workspaceDir,
			cwd: harness.tempDir,
			session,
			harnessState: state,
			modelRuntime: session.modelRuntime,
			resourceLoader: session.resourceLoader,
		});
		runtimes.push(runtime);
		let curated = false;
		const evolve: FauxResponseFactory = async (context) => {
			const input = JSON.parse(String(context.messages[0]!.content)) as {
				control: { objective: string };
				evidence?: { evidenceRef: string }[];
				childLessons?: { lessonRef: string }[];
				frozenEvolutionMemory: { harnessVersion: string };
				skillCatalog: { name: string }[];
			};
			if (
				input.control.objective === "classify-operational-patterns-and-return-only-compact-skill-candidate-outlines"
			) {
				expect(input.frozenEvolutionMemory.harnessVersion).toBe((await state.loadCurrent()).manifest.version);
				expect(input.skillCatalog.some((skill) => skill.name === "unused")).toBe(!removed);
				curated = true;
				return response({ outlines: [] });
			}
			harness.appendResponses([evolve]);
			if (input.evidence || input.childLessons) {
				return response({
					complete: true,
					lessons: [
						{
							kind: "successful-strategy",
							summary: "Verify changes",
							preconditions: [],
							observedOutcome: "Verification passed",
							...(input.evidence
								? { supportingEvidenceRefs: [input.evidence[0]!.evidenceRef], counterevidenceRefs: [] }
								: { sourceLessonRefs: [input.childLessons![0]!.lessonRef], counterLessonRefs: [] }),
							applicabilityBoundaries: [],
							uncertainty: null,
							actionableTakeaway: "Verify the selected revision.",
						},
					],
				});
			}
			return response({ decisions: [] });
		};
		harness.setResponses([evolve]);
		await runtime.start();
		const started = await runtime.control.startManual();
		if (started.status !== "created") throw new Error(`Expected evolution job: ${JSON.stringify(started)}`);
		const groomed = await state.loadCurrent();
		expect(groomed.state.skills).toHaveLength(count - Number(removed));
		expect(groomed.manifest.version === selected.manifest.version).toBe(!removed);
		expect(groomed.state.memory).toBe(selected.state.memory);
		expect(session.activeHarnessVersion).toBe(original.manifest.version);
		if (removed) {
			const versionDirectory = join(
				agentDir,
				"harness-state",
				"versions",
				groomed.manifest.version.replace(":", "-"),
			);
			await expect(access(join(versionDirectory, "skills/unused/SKILL.md"))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(access(join(versionDirectory, "skills/unused/check.md"))).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
		const job = await persistence.load(started.job.jobId);
		if (!job) throw new Error("Expected persisted job");
		const snapshot = await persistence.get(job.inputSnapshot);
		if (!("skillCatalog" in snapshot)) throw new Error("Expected input snapshot");
		expect(snapshot.expectedHarnessBaseVersion).toBe(groomed.manifest.version);
		expect(snapshot.harness.harnessVersion).toBe(groomed.manifest.version);
		expect(snapshot.skillCatalog.map((skill) => skill.name).sort()).toEqual(
			groomed.state.skills.map((skill) => skill.name).sort(),
		);
		for (const entry of snapshot.skillCatalog) {
			const skill = groomed.state.skills.find((skill) => skill.name === entry.name)!;
			expect(entry.harnessRevision).toBe(groomed.manifest.version);
			expect(entry.version).toBe(skill.packageVersion);
			expect(entry.contentDigest).toBe(skill.contentHash);
		}
		await vi.waitFor(
			async () => {
				const detail = await runtime.control.getJob(job.jobId);
				expect(detail.outcome, JSON.stringify(detail)).toBe("completed");
			},
			{ timeout: 8_000, interval: 20 },
		);
		expect(curated).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		await runtime.stop();
		// A new session and its next model prompt both observe the post-groom catalog.
		const { session: next } = await createAgentSession({
			...options,
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		sessions.push(next);
		expect(next.createSkillReferences().some((skill) => skill.name === "unused")).toBe(!removed);
		harness.setResponses([
			(context) => {
				expect(context.systemPrompt?.includes("<name>unused</name>")).toBe(!removed);
				expect(context.systemPrompt).toContain("<name>keep-1</name>");
				return fauxAssistantMessage("Verified.");
			},
			fauxAssistantMessage(fauxToolCall(SKILL_FEEDBACK_TOOL, { ratings: [] }), { stopReason: "toolUse" }),
		]);
		await next.prompt("Verify again.");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
