import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeHarnessSkillId,
	type HarnessSkill,
	HarnessStateStore,
	harnessVersionDirectoryName,
} from "../../harness-state/src/index.ts";
import { FileEvolutionPersistence, PersistentSkillCandidateRegistry, SkillWriter } from "../src/index.ts";

const scope = { repositoryId: "test", scopeId: "workspace" };
const workspace = { repositoryId: "test", directoryId: "workspace" };
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(points: readonly number[]) {
	const root = await mkdtemp(join(tmpdir(), "skill-grooming-"));
	roots.push(root);
	const state = new HarnessStateStore(join(root, "agent"), { workspace });
	const empty = await state.initialize();
	const foreign = { repositoryId: "test", directoryId: "other" };
	const bundle = await state.saveVersion(
		{
			memory: "Lesson 1: Preserve memory.\n",
			skills: [
				...points.map((_, index) => ({ name: `skill-${index}`, workspace })),
				{ name: "foreign", workspace: foreign },
			].map(({ name, workspace }) => ({
				path: `skills/${name}/SKILL.md`,
				content: `---\nname: ${name}\ndescription: Use ${name} for verification.\n---\nRead [guide](guide.md).\n`,
				files: [{ path: "guide.md", content: "Verify the result.\n" }],
				workspace,
			})),
		},
		empty.manifest.version,
	);
	await state.selectVersion(bundle.manifest.version);
	const scores = new FileEvolutionPersistence(join(root, "evolution"));
	await scores.registerSkillScoreRevision(scope, workspace, bundle);
	const snapshot = await scores.loadSkillScores(scope, workspace, bundle.manifest.version);
	const ids = points.map((_, index) => computeHarnessSkillId(workspace, `skills/skill-${index}/SKILL.md`));
	await scores.saveSkillScores(
		scope,
		workspace,
		snapshot.revision,
		snapshot.scores.map((item) => ({
			...item,
			harnessRevision: bundle.manifest.version,
			points: points[ids.indexOf(item.skillId)]!,
			lastAppliedOutputIdempotencyKey: "fixture",
		})),
	);
	const clock = { now: () => new Date().toISOString() };
	const registry = new PersistentSkillCandidateRegistry({ version: "test", artifacts: scores, store: scores });
	const writer = new SkillWriter({
		version: "test",
		workspace,
		harnessState: state,
		artifacts: scores,
		registry,
		leases: scores,
		clock,
		statePath: join(root, "writer"),
	});
	const lease = await scores.acquire("writer", "global", "test", clock.now(), 60_000);
	if (!lease) throw new Error("Missing lease");
	const context = { idempotencyKey: "groom", lease };
	return { root, state, bundle, scores, writer, context, ids, registry };
}

function packageContent({ filePath: _filePath, baseDir: _baseDir, files, ...skill }: HarnessSkill) {
	return { ...skill, files: files.map(({ filePath: _filePath, ...file }) => file) };
}

describe("skill grooming", () => {
	it.each([
		{ points: [-10.5, -11, -12, 0], removed: [1, 2] },
		{ points: [...Array<number>(10).fill(0), -1], removed: [10] },
		{ points: [-11, -12, -2, ...Array<number>(10).fill(0)], removed: [0, 1, 2] },
		{ points: [-11, -12, -13, ...Array<number>(9).fill(0)], removed: [0, 1, 2] },
		{ points: [-11], removed: [0] },
	])("removes exactly the threshold and capacity victims: $points", async ({ points, removed }) => {
		const env = await setup(points);
		const registry = vi.spyOn(env.registry, "list");
		const before = await env.scores.loadSkillScores(scope, workspace, env.bundle.manifest.version);
		const groomed = await env.writer.groom(env.scores, scope, env.context);
		expect(await env.state.loadCurrent()).toEqual(groomed);
		expect(groomed.manifest.base).toBe(env.bundle.manifest.version);
		expect(groomed.state.memory).toBe(env.bundle.state.memory);
		expect(groomed.state.skills.map(packageContent)).toEqual(
			env.bundle.state.skills
				.filter((skill) => !removed.some((index) => skill.name === `skill-${index}`))
				.map(packageContent),
		);
		const directory = join(
			env.root,
			"agent",
			"harness-state",
			"versions",
			harnessVersionDirectoryName(groomed.manifest.version),
		);
		for (const index of removed) {
			await expect(readFile(join(directory, `skills/skill-${index}/SKILL.md`))).rejects.toMatchObject({
				code: "ENOENT",
			});
			await expect(readFile(join(directory, `skills/skill-${index}/guide.md`))).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
		expect((await env.scores.loadSkillScores(scope, workspace, env.bundle.manifest.version)).scores).toEqual(
			before.scores,
		);
		expect((await env.scores.loadSkillScores(scope, workspace, groomed.manifest.version)).scores).toHaveLength(
			points.length - removed.length,
		);
		expect(await env.writer.groom(env.scores, scope, env.context)).toEqual(groomed);
		expect(await env.writer.listActivationReceipts(scope)).toHaveLength(1);
		expect(registry).not.toHaveBeenCalled();
	});

	it("breaks equal-point ties by skill ID, independently of score row order", async () => {
		const env = await setup(Array<number>(11).fill(0));
		const snapshot = await env.scores.loadSkillScores(scope, workspace, env.bundle.manifest.version);
		vi.spyOn(env.scores, "loadSkillScores").mockResolvedValue({
			...snapshot,
			scores: [...snapshot.scores].reverse(),
		});
		const groomed = await env.writer.groom(env.scores, scope, env.context);
		const removed = [...env.ids].sort()[0];
		expect(groomed.state.skills.some((skill) => computeHarnessSkillId(skill.workspace, skill.path) === removed)).toBe(
			false,
		);
		expect(groomed.state.skills).toHaveLength(11); // Ten local skills plus the foreign skill.
	});

	it.each([[], [-10.5, -10, -8, 0], Array<number>(10).fill(0)].map((points) => ({ points })))(
		"does not advance above the removal threshold and within capacity: $points",
		async ({ points }) => {
			const env = await setup(points);
			const installed = join(env.root, "installed.md");
			await writeFile(installed, "Installed skill, not in the harness.");
			expect(await env.writer.groom(env.scores, scope, env.context)).toEqual(env.bundle);
			expect(await env.state.loadCurrent()).toEqual(env.bundle);
			expect(await env.writer.listActivationReceipts(scope)).toEqual([]);
			expect(await readFile(installed, "utf8")).toBe("Installed skill, not in the harness.");
		},
	);

	it.each(["contentDigest", "packageVersion", "workspace"] as const)(
		"rejects mismatched %s without advancing",
		async (field) => {
			const env = await setup([-11]);
			const snapshot = await env.scores.loadSkillScores(scope, workspace, env.bundle.manifest.version);
			vi.spyOn(env.scores, "loadSkillScores").mockResolvedValue({
				...snapshot,
				scores: snapshot.scores.map((item) => ({
					...item,
					[field]: field === "workspace" ? { ...workspace, directoryId: "other" } : `sha256:${"a".repeat(64)}`,
				})),
			});
			await expect(env.writer.groom(env.scores, scope, env.context)).rejects.toThrow(/grooming subject/);
			expect(await env.state.loadCurrent()).toEqual(env.bundle);
		},
	);

	it("does not rebase a scored removal onto a concurrently selected revision", async () => {
		const env = await setup([-11]);
		const next = await env.state.saveVersion({ memory: "Changed selection.\n" }, env.bundle.manifest.version);
		const select = env.state.selectVersionIfCurrent.bind(env.state);
		vi.spyOn(env.state, "selectVersionIfCurrent").mockImplementationOnce(async (...args) => {
			await env.state.selectVersion(next.manifest.version);
			return select(...args);
		});
		await expect(env.writer.groom(env.scores, scope, env.context)).rejects.toMatchObject({
			reasonCode: "harness-base-conflict",
		});
		expect(await env.state.loadCurrent()).toEqual(next);
		expect(await env.writer.listActivationReceipts(scope)).toEqual([]);
	});
});
