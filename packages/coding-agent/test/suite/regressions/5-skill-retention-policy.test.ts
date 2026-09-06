import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import { FileEvolutionPersistence } from "#evolution";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../../../src/core/harness-state-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SKILL_FEEDBACK_TOOL } from "../../../src/core/skill-feedback.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

function report(ratings: { skillId: string; signal: "helpful" | "harmful" }[] = []) {
	return fauxAssistantMessage(fauxToolCall(SKILL_FEEDBACK_TOOL, { ratings }), { stopReason: "toolUse" });
}

async function setup() {
	const harness = await createHarness({ settings: { compaction: { enabled: false } } });
	harnesses.push(harness);
	return harness;
}

async function createWorkspace(harness: Harness, name: string, names: string[], inactive = false) {
	const cwd = join(harness.tempDir, name);
	mkdirSync(cwd);
	const agentDir = join(harness.tempDir, "agent");
	const { workspace } = await resolveHarnessWorkspace(cwd);
	const store = new HarnessStateStore(agentDir, { workspace });
	const root = await store.initialize();
	const bundle = await store.saveVersion(
		{
			memory: "Lesson 1: Verify the result.",
			skills: names.map((skillName) => ({
				path: `skills/${skillName}/SKILL.md`,
				content: `---\nname: ${skillName}\ndescription: Verify ${skillName}.\n---\nCheck actual evidence.`,
				workspace,
			})),
		},
		root.manifest.version,
	);
	await store.selectVersion(bundle.manifest.version);
	// Use the production SDK consumer and workspace lookup; never inject score application.
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: harness.session.modelRuntime,
		model: harness.getModel(),
		resourceLoader: createTestResourceLoader(),
		settingsManager: harness.settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		subagents: false,
		// A preloaded store without an activated bundle models the built-in-only lane.
		...(inactive ? { harnessStateStore: store, pinHarnessVersion: true } : {}),
	});
	sessions.push(session);
	const directory = join(resolveEvolutionWorkspaceStateDirectory(agentDir, workspace), "evolution");
	const persistence = new FileEvolutionPersistence(directory);
	const revision = {
		scope: { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId! },
		workspace,
		harnessRevision: bundle.manifest.version,
	};
	return { session, store, bundle, directory, persistence, revision };
}

describe("skill retention policy runtime boundaries", () => {
	it("applies mixed helpful/harmful ratings once per output, distinguishes omitted invocation from neutral, and preserves exact sums", async () => {
		const harness = await setup();
		const { session, store, bundle, persistence, revision } = await createWorkspace(harness, "workspace", [
			"helpful",
			"harmful",
			"unrated",
			"unused",
		]);
		const references = session.createSkillReferences();
		const helpful = references.find((skill) => skill.name === "helpful")!;
		const harmful = references.find((skill) => skill.name === "harmful")!;
		const unrated = references.find((skill) => skill.name === "unrated")!;
		const outputs = [
			{
				prompt: `${helpful.reference} ${harmful.reference} ${unrated.reference} Review this.`,
				ratings: [
					{ skillId: helpful.skillId, signal: "helpful" as const },
					{ skillId: harmful.skillId, signal: "harmful" as const },
				],
				points: { helpful: 1, harmful: -1.5, unrated: 0, unused: -1 },
			},
			{
				prompt: "Answer without invoking skills.",
				ratings: [],
				points: { helpful: 0, harmful: -2.5, unrated: -1, unused: -2 },
			},
			{
				prompt: `${helpful.reference} ${harmful.reference} Review again.`,
				ratings: [
					{ skillId: helpful.skillId, signal: "harmful" as const },
					{ skillId: harmful.skillId, signal: "helpful" as const },
				],
				points: { helpful: -1.5, harmful: -1.5, unrated: -2, unused: -3 },
			},
		];
		for (const [index, output] of outputs.entries()) {
			harness.setResponses([fauxAssistantMessage("Public answer."), report(output.ratings)]);
			await session.prompt(output.prompt);
			const rows = await persistence.loadSkillScores(store, revision);
			expect(
				Object.fromEntries(
					references.map((skill) => [skill.name, rows.find((row) => row.skillId === skill.skillId)!.points]),
				),
			).toEqual(output.points);
			expect(rows.every((row) => row.appliedOutputKeys.length === index + 1)).toBe(true);
			expect(harness.faux.state.callCount).toBe((index + 1) * 2);
		}
		expect(await store.loadCurrent()).toEqual(bundle);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps identically named skill scores isolated between workspaces sharing one agent directory", async () => {
		const harness = await setup();
		const first = await createWorkspace(harness, "first", ["review"]);
		const second = await createWorkspace(harness, "second", ["review"]);
		const firstReference = first.session.createSkillReferences()[0]!;
		const secondReference = second.session.createSkillReferences()[0]!;
		expect(firstReference.skillId).not.toBe(secondReference.skillId);
		expect(first.bundle.state.skills[0]!.contentHash).toBe(second.bundle.state.skills[0]!.contentHash);
		expect(first.directory).not.toBe(second.directory);
		const secondBefore = await second.persistence.loadSkillScores(second.store, second.revision);
		expect(secondBefore.map((row) => row.points)).toEqual([0]);
		harness.setResponses([
			fauxAssistantMessage("First workspace answer."),
			report([{ skillId: firstReference.skillId, signal: "helpful" }]),
		]);
		await first.session.prompt(`${firstReference.reference} Review this.`);
		const firstAfter = await first.persistence.loadSkillScores(first.store, first.revision);
		expect(firstAfter.map((row) => row.points)).toEqual([1]);
		expect(firstAfter[0]!.workspace).toEqual(first.revision.workspace);
		expect(await second.persistence.loadSkillScores(second.store, second.revision)).toEqual(secondBefore);
		harness.setResponses([
			fauxAssistantMessage("Second workspace answer."),
			report([{ skillId: secondReference.skillId, signal: "harmful" }]),
		]);
		await second.session.prompt(`${secondReference.reference} Review this.`);
		const secondAfter = await second.persistence.loadSkillScores(second.store, second.revision);
		expect(secondAfter.map((row) => row.points)).toEqual([-1.5]);
		expect(secondAfter[0]!.workspace).toEqual(second.revision.workspace);
		expect(await first.persistence.loadSkillScores(first.store, first.revision)).toEqual(firstAfter);
		expect(await first.store.loadCurrent()).toEqual(first.bundle);
		expect(await second.store.loadCurrent()).toEqual(second.bundle);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["inactive", "empty"] as const)(
		"requests no private reports and creates no score state with an %s harness",
		async (kind) => {
			const harness = await setup();
			const { session, store, bundle, directory } = await createWorkspace(
				harness,
				"workspace",
				kind === "inactive" ? ["unactivated"] : [],
				kind === "inactive",
			);
			expect(session.activeHarnessVersion).toBe(kind === "inactive" ? undefined : bundle.manifest.version);
			expect(session.createSkillReferences()).toEqual([]);
			expect(existsSync(directory)).toBe(false);
			for (let index = 0; index < 2; index += 1) {
				harness.setResponses([
					(context) => {
						expect(context.tools?.some((tool) => tool.name === SKILL_FEEDBACK_TOOL)).toBe(false);
						expect(context.systemPrompt).not.toContain("<name>unactivated</name>");
						return fauxAssistantMessage("Public answer only.");
					},
				]);
				await session.prompt("Answer normally.");
				expect(harness.faux.state.callCount).toBe(index + 1);
				expect(existsSync(directory)).toBe(false);
			}
			expect(session.activeHarnessVersion).toBe(kind === "inactive" ? undefined : bundle.manifest.version);
			expect(await store.loadCurrent()).toEqual(bundle);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);
});
