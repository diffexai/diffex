import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/diffex-ai";
import { HarnessStateStore } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_FEEDBACK_TOOL, type SkillFeedbackReport, SkillFeedbackTurn } from "../src/core/skill-feedback.ts";
import { createEvolvedSkillCatalog, createSkillReferenceSnapshot } from "../src/core/skills.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "skill-feedback-"));
	directories.push(directory);
	const store = new HarnessStateStore(directory);
	const root = await store.initialize();
	const workspace = { repositoryId: "repo", directoryId: "directory" };
	const bundle = await store.saveVersion(
		{
			memory: "Lesson 1: Test private reports.",
			skills: ["one", "two"].map((name) => ({
				path: `skills/${name}/SKILL.md`,
				content: `---\nname: ${name}\ndescription: Test ${name}.\n---\nUse ${name}.`,
				workspace,
				files: [{ path: `skills/${name}/reference.md`, content: "Supporting content" }],
			})),
		},
		root.manifest.version,
	);
	const references = createEvolvedSkillCatalog(bundle, workspace).skills.map(createSkillReferenceSnapshot);
	const turn = new SkillFeedbackTurn(bundle, workspace);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const reports: SkillFeedbackReport[] = [];
	const context = { systemPrompt: "Original system context", messages: [fauxAssistantMessage("Original output")] };
	const request = {
		models,
		model: faux.getModel(),
		context,
		sessionId: "session",
		outputId: "output",
		consume: (report: SkillFeedbackReport) => {
			reports.push(report);
		},
	};
	return { bundle, workspace, references, turn, faux, reports, request };
}

function response(ratings: unknown[]) {
	return fauxAssistantMessage(fauxToolCall(SKILL_FEEDBACK_TOOL, { ratings }), { stopReason: "toolUse" });
}

describe("private skill feedback", () => {
	it("binds helpful/harmful to exact references and supporting-file reads without changing context", async () => {
		const { bundle, references, turn, faux, reports, request } = await setup();
		turn.reference([references[0]]);
		const file = bundle.state.skills[1].files[0];
		turn.read(file.filePath, file.contentHash);
		const ratings = [
			{ skillId: references[0].skillId, signal: "helpful" },
			{ skillId: references[1].skillId, signal: "harmful" },
		];
		const before = structuredClone(request.context);
		faux.setResponses([
			(context, options) => {
				expect(context.systemPrompt).toBe(request.context.systemPrompt);
				expect(context.messages.slice(0, -1)).toEqual(request.context.messages);
				expect(options).toMatchObject({ transport: "sse", cacheRetention: "none", maxRetries: 0 });
				expect(options?.onPayload).toBeUndefined();
				expect(options?.onResponse).toBeUndefined();
				expect(options?.sessionId).toBeUndefined();
				return response(ratings);
			},
		]);
		await turn.report(request);
		expect(reports).toEqual([
			expect.objectContaining({
				harnessRevision: bundle.manifest.version,
				invokedSkillIds: references.map((reference) => reference.skillId),
				ratings,
			}),
		]);
		expect(request.context).toEqual(before);
		expect(faux.state.callCount).toBe(1);
	});

	it.each(["neutral", "uninvoked", "duplicate", "conflicting", "malformed", "failure", "length"])(
		"discards %s reports without calling the consumer or retrying",
		async (kind) => {
			const { references, turn, faux, reports, request } = await setup();
			turn.reference(references);
			const good = { skillId: references[0].skillId, signal: "helpful" };
			const ratings =
				kind === "neutral"
					? [{ ...good, signal: "neutral" }]
					: kind === "uninvoked"
						? [{ ...good, skillId: "invented" }]
						: kind === "duplicate"
							? [good, good]
							: kind === "conflicting"
								? [good, { ...good, signal: "harmful" }]
								: kind === "malformed"
									? [{ skillId: good.skillId }]
									: [good];
			faux.setResponses([
				kind === "failure"
					? fauxAssistantMessage("secret failure", { stopReason: "error" })
					: kind === "length"
						? { ...response(ratings), stopReason: "length" }
						: response(ratings),
			]);
			await turn.report(request);
			expect(reports).toEqual([]);
			expect(faux.state.callCount).toBe(1);
		},
	);

	it("does not treat installed, wrong-version, wrong-digest or foreign-workspace skills as invoked", async () => {
		const { bundle, references, turn, faux, reports, request } = await setup();
		turn.reference([
			{ ...references[0], sourceKind: "installed" },
			{ ...references[0], version: "sha256:wrong" },
			{ ...references[0], harnessRevision: "sha256:wrong" },
		]);
		turn.read(bundle.state.skills[0].filePath, "sha256:wrong");
		turn.read(join(bundle.state.skills[0].baseDir, "not-in-package.md"), bundle.state.skills[0].contentHash);
		faux.setResponses([response([])]);
		await turn.report(request);
		expect(reports[0].invokedSkillIds).toEqual([]);
		expect(reports[0].ratings).toEqual([]);
		await new SkillFeedbackTurn(bundle, { repositoryId: "other" }).report(request);
		expect(faux.state.callCount).toBe(1);
	});

	it("bounds cancellation even when a provider ignores the signal", async () => {
		const { turn, faux, reports, request } = await setup();
		const controller = new AbortController();
		faux.setResponses([
			async () => {
				controller.abort();
				return new Promise(() => {});
			},
		]);
		await turn.report({ ...request, signal: controller.signal });
		expect(reports).toEqual([]);
	});
});
