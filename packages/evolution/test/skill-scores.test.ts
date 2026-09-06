import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

	it.each([
		{ scope, workspace: { ...workspace, directoryId: "checkout-b" } },
		{ scope, workspace: { repositoryId: workspace.repositoryId } },
		{ scope: { ...scope, repositoryId: "other-repo" }, workspace: { ...workspace, repositoryId: "other-repo" } },
		{ scope: { ...scope, scopeId: "other-scope" }, workspace },
	])("isolates scores in a shared store for $scope / $workspace", async (other) => {
		const { harness, bundle, store, storePath, revision } = await fixture();
		const original = first(await store.loadSkillScores(harness, revision));
		const scored = { ...original, points: -8, lastOutputIdempotencyKey: "session-a:1" };
		await store.saveSkillScore(harness, scored, original);
		const otherBundle = await harness.saveVersion(
			{ memory: "", skills: [skill("verify", other.workspace)] },
			bundle.manifest.version,
		);
		const otherRevision = { ...other, harnessRevision: otherBundle.manifest.version };
		const otherStore = new FileEvolutionPersistence(storePath);
		const otherOriginal = first(await otherStore.loadSkillScores(harness, otherRevision));
		expect(otherOriginal.points).toBe(0);
		const otherScored = { ...otherOriginal, points: 1, lastOutputIdempotencyKey: "session-a:1" };
		expect(await otherStore.saveSkillScore(harness, otherScored, otherOriginal)).toBe("committed");
		expect(await store.loadSkillScores(harness, revision)).toEqual([scored]);
		expect(await otherStore.loadSkillScores(harness, otherRevision)).toEqual([otherScored]);
	});

	it("rejects scope/workspace mismatches and skills or digests absent from the bound revision", async () => {
		const { harness, store, revision } = await fixture();
		await expect(
			store.loadSkillScores(harness, { ...revision, scope: { ...scope, repositoryId: "other" } }),
		).rejects.toThrow("scope or workspace");
		const original = first(await store.loadSkillScores(harness, revision));
		for (const patch of [
			{ skillId: computeHarnessSkillId(workspace, "skills/installed/SKILL.md") },
			{ packageVersion: `sha256:${"a".repeat(64)}` },
			{ contentDigest: `sha256:${"a".repeat(64)}` },
			{ workspace: { ...workspace, directoryId: "other" } },
		]) {
			const forged = { ...original, ...patch };
			await expect(
				store.saveSkillScore(harness, { ...forged, points: 1, lastOutputIdempotencyKey: "session:1" }, forged),
			).rejects.toThrow("not active");
		}
		expect(await store.loadSkillScores(harness, revision)).toEqual([original]);
	});

	it("rejects a corrupt harness bundle before initializing scores", async () => {
		const { harness, bundle, store, storePath, revision } = await fixture();
		await writeFile(bundle.state.skills[0]!.filePath, "tampered");
		await expect(store.loadSkillScores(harness, revision)).rejects.toThrow();
		await expect(readdir(join(storePath, "skill-scores"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("serializes initialization and rejects stale concurrent writes across store instances", async () => {
		const { harness, store, storePath, revision } = await fixture();
		const other = new FileEvolutionPersistence(storePath);
		const [left, right] = await Promise.all([
			store.loadSkillScores(harness, revision),
			other.loadSkillScores(harness, revision),
		]);
		expect(left).toEqual(right);
		const original = first(left);
		const updates = [
			{ ...original, points: 1, lastOutputIdempotencyKey: "session-a:1" },
			{ ...original, points: -1.5, lastOutputIdempotencyKey: "session-b:1" },
		];
		const results = await Promise.all([
			store.saveSkillScore(harness, updates[0]!, original),
			other.saveSkillScore(harness, updates[1]!, original),
		]);
		expect([...results].sort()).toEqual(["committed", "conflict"]);
		const winner = updates[results.indexOf("committed")]!;
		expect(await store.loadSkillScores(harness, revision)).toEqual([winner]);
		expect(await other.saveSkillScore(harness, winner, original)).toBe("conflict");
		await expect(other.saveSkillScore(harness, { ...winner, points: 5 }, winner)).rejects.toThrow(
			"new output idempotency key",
		);
	});

	it("rejects symbolic-link score rows", async () => {
		const { root, harness, store, storePath, revision } = await fixture();
		const original = first(await store.loadSkillScores(harness, revision));
		const [name] = await readdir(join(storePath, "skill-scores"));
		const path = join(storePath, "skill-scores", name!);
		const target = join(root, "score.json");
		await writeFile(target, JSON.stringify(original));
		await rm(path);
		await symlink(target, path);
		await expect(store.loadSkillScores(harness, revision)).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
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
			JSON.stringify({ ...original, points: null }),
			JSON.stringify({ ...original, points: 1 }),
			JSON.stringify(original).replace('"points":0', '"points":1e400'),
			JSON.stringify({ ...original, schemaVersion: undefined }),
			JSON.stringify({ ...original, lastOutputIdempotencyKey: undefined }),
			JSON.stringify({ ...original, lastOutputIdempotencyKey: " " }),
			JSON.stringify({ ...original, harnessRevision: "not-a-revision" }),
			JSON.stringify({ ...original, skillId: "installed:skill" }),
			JSON.stringify({ ...original, packageVersion: "v1" }),
			JSON.stringify({ ...original, contentDigest: "invalid" }),
			JSON.stringify({ ...original, workspace: { ...workspace, repositoryId: "other" } }),
			// Valid schema, wrong filename-bound identity: these must not leak into this subject.
			JSON.stringify({ ...original, scope: { ...scope, scopeId: "other" } }),
			JSON.stringify({ ...original, workspace: { ...workspace, directoryId: "other" } }),
			JSON.stringify({ ...original, packageVersion: `sha256:${"a".repeat(64)}` }),
		]) {
			await writeFile(path, contents);
			await expect(store.loadSkillScores(harness, revision)).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		}
	});
});
