import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeHarnessSkillId,
	type HarnessSkillInput,
	HarnessStateStore,
	type HarnessWorkspaceIdentity,
} from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EvolutionScope,
	EvolutionStorageCorruptionError,
	FileEvolutionPersistence,
	SKILL_SCORE_SCHEMA_VERSION,
	type SkillScore,
	type SkillScoreRevision,
} from "../src/index.ts";

const scope: EvolutionScope = { repositoryId: "repo", scopeId: "repository" };
const workspace: HarnessWorkspaceIdentity = { repositoryId: "repo", directoryId: "checkout-a" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function skill(name: string, identity = workspace): HarnessSkillInput {
	return {
		path: `skills/${name}/SKILL.md`,
		content: `---\nname: ${name}\ndescription: Verify ${name}.\n---\n\nCheck the result.\n`,
		workspace: identity,
	};
}

async function fixture(skills: readonly HarnessSkillInput[] = [skill("verify")]) {
	const root = await mkdtemp(join(tmpdir(), "diffex-skill-scores-"));
	temporaryDirectories.push(root);
	const harness = new HarnessStateStore(root);
	const initial = await harness.initialize();
	const bundle = await harness.saveVersion({ memory: "", skills }, initial.manifest.version);
	await harness.selectVersion(bundle.manifest.version);
	const storePath = join(root, "evolution");
	const store = new FileEvolutionPersistence(storePath);
	const revision: SkillScoreRevision = { scope, workspace, harnessRevision: bundle.manifest.version };
	return { root, harness, bundle, storePath, store, revision };
}

function first(scores: readonly SkillScore[]): SkillScore {
	expect(scores).toHaveLength(1);
	return scores[0]!;
}

describe("durable skill scores", () => {
	it("initializes exactly the workspace's evolved skills and survives reopening without changing the harness", async () => {
		const foreign = { ...workspace, directoryId: "checkout-b" };
		const { root, harness, bundle, store, storePath, revision } = await fixture([
			skill("verify"),
			skill("inspect"),
			skill("foreign", foreign),
		]);
		// An installed file is not part of the immutable harness inventory.
		await writeFile(join(root, "installed-skill.md"), skill("installed").content);
		const scores = await store.loadSkillScores(harness, revision);
		expect(scores.map((score) => score.skillId).sort()).toEqual(
			["verify", "inspect"].map((name) => computeHarnessSkillId(workspace, `skills/${name}/SKILL.md`)).sort(),
		);
		for (const score of scores) {
			expect(score).toMatchObject({
				schemaVersion: SKILL_SCORE_SCHEMA_VERSION,
				scope,
				workspace,
				harnessRevision: bundle.manifest.version,
				points: 0,
				lastOutputIdempotencyKey: null,
			});
		}
		const original = scores[0]!;
		const scored = { ...original, points: -1.5, lastOutputIdempotencyKey: "session-a:1" };
		expect(await store.saveSkillScore(harness, scored, original)).toBe("committed");
		const reopened = new FileEvolutionPersistence(storePath);
		expect(await reopened.loadSkillScores(harness, revision)).toEqual([scored, ...scores.slice(1)]);
		expect(await reopened.loadSkillScores(harness, revision)).toEqual(await store.loadSkillScores(harness, revision));
		expect(await harness.loadCurrent()).toEqual(bundle);
		expect(await harness.loadVersion(bundle.manifest.version)).toEqual(bundle);
	});

	it.each(["entrypoint", "supporting-file"])(
		"starts a modified %s at zero and retains the superseded row",
		async (change) => {
			const originalSkill = { ...skill("verify"), files: [{ path: "references/check.md", content: "Before.\n" }] };
			const { harness, bundle, store, revision, storePath } = await fixture([originalSkill]);
			const original = first(await store.loadSkillScores(harness, revision));
			const scored = { ...original, points: -7, lastOutputIdempotencyKey: "session-a:1" };
			await store.saveSkillScore(harness, scored, original);
			const modified = await harness.saveVersion(
				{
					memory: "",
					skills: [
						{
							...originalSkill,
							...(change === "entrypoint"
								? { content: `${originalSkill.content}\nInspect the digest.\n` }
								: { files: [{ path: "references/check.md", content: "After.\n" }] }),
						},
					],
				},
				bundle.manifest.version,
			);
			await harness.selectVersion(modified.manifest.version);
			const nextRevision = { ...revision, harnessRevision: modified.manifest.version };
			const fresh = first(await store.loadSkillScores(harness, nextRevision));
			expect(fresh).toMatchObject({ skillId: original.skillId, points: 0, lastOutputIdempotencyKey: null });
			expect(fresh.packageVersion).not.toBe(original.packageVersion);
			expect(fresh.contentDigest === original.contentDigest).toBe(change === "supporting-file");
			expect(await store.loadSkillScores(harness, nextRevision)).toEqual([fresh]);
			expect(await store.loadSkillScores(harness, revision)).toEqual([scored]);
			expect(await readdir(join(storePath, "skill-scores"))).toHaveLength(2);
		},
	);

	it("retains unchanged package scores across revisions and excludes retired skills", async () => {
		const { harness, bundle, store, revision } = await fixture();
		const original = first(await store.loadSkillScores(harness, revision));
		const scored = { ...original, points: 3, lastOutputIdempotencyKey: "session-a:1" };
		await store.saveSkillScore(harness, scored, original);
		const successor = await harness.saveVersion({ memory: "Lesson 1: Verify changes.\n" }, bundle.manifest.version);
		const successorRevision = { ...revision, harnessRevision: successor.manifest.version };
		expect(await store.loadSkillScores(harness, successorRevision)).toEqual([scored]);
		const rescored = {
			...scored,
			harnessRevision: successor.manifest.version,
			points: 4,
			lastOutputIdempotencyKey: "session-a:2",
		};
		expect(await store.saveSkillScore(harness, rescored, scored)).toBe("committed");
		expect(await store.loadSkillScores(harness, successorRevision)).toEqual([rescored]);
		const retired = await harness.saveVersion({ memory: "", skills: [] }, successor.manifest.version);
		await harness.selectVersion(retired.manifest.version);
		expect(await store.loadSkillScores(harness, { ...revision, harnessRevision: retired.manifest.version })).toEqual(
			[],
		);
		expect(await store.loadSkillScores(harness, revision)).toEqual([rescored]);
		await expect(
			store.saveSkillScore(
				harness,
				{
					...rescored,
					harnessRevision: retired.manifest.version,
					lastOutputIdempotencyKey: "session-a:3",
				},
				rescored,
			),
		).rejects.toThrow("not active");
	});

	it("rejects incompatible or corrupt stored rows instead of resetting their points", async () => {
		const { harness, store, storePath, revision } = await fixture();
		await store.loadSkillScores(harness, revision);
		const [name] = await readdir(join(storePath, "skill-scores"));
		const path = join(storePath, "skill-scores", name!);
		const original = JSON.parse(await readFile(path, "utf8")) as SkillScore;
		for (const contents of [
			"{",
			JSON.stringify({ ...original, schemaVersion: 999 }),
			JSON.stringify({ ...original, points: "0" }),
		]) {
			await writeFile(path, contents);
			await expect(store.loadSkillScores(harness, revision)).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		}
	});
});
