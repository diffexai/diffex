import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarnessStateStore, type HarnessWorkspaceIdentity } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEvolutionPersistence, PersistentSkillCandidateRegistry, SkillWriter } from "../src/index.ts";

const workspace: HarnessWorkspaceIdentity = { repositoryId: "repo", directoryId: "checkout" };
const scope = { repositoryId: "repo", scopeId: "checkout" };
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(points: readonly number[], foreign = false) {
	const root = await mkdtemp(join(tmpdir(), "skill-grooming-"));
	roots.push(root);
	const state = new HarnessStateStore(root);
	const initial = await state.initialize();
	const skills = [...points, ...(foreign ? [0] : [])].map((_, index) => {
		const name = `skill-${String(index).padStart(2, "0")}`;
		return {
			path: `skills/${name}/SKILL.md`,
			content: `---\nname: ${name}\ndescription: Verify ${name}.\n---\nCheck the result.`,
			workspace: index === points.length ? { ...workspace, directoryId: "other" } : workspace,
			files: [{ path: "references/check.md", content: "Verify it." }],
		};
	});
	const base = await state.saveVersion({ memory: "Keep memory unchanged.", skills }, initial.manifest.version);
	await state.selectVersion(base.manifest.version);
	const persistence = new FileEvolutionPersistence(join(root, "evolution"));
	const revision = { scope, workspace, harnessRevision: base.manifest.version };
	const rows = await persistence.loadSkillScores(state, revision);
	for (const [index, row] of rows.entries()) {
		expect(
			await persistence.saveSkillScore(
				state,
				{ ...row, points: points[index]!, lastOutputIdempotencyKey: "fixture" },
				row,
			),
		).toBe("committed");
	}
	const lease = await persistence.acquire("writer", "global", "grooming", new Date().toISOString(), 60_000);
	if (!lease) throw new Error("Expected writer lease");
	const writer = new SkillWriter({
		version: "test",
		workspace,
		harnessState: state,
		artifacts: persistence,
		leases: persistence,
		registry: new PersistentSkillCandidateRegistry({ version: "test", artifacts: persistence, store: persistence }),
		clock: { now: () => new Date().toISOString() },
		statePath: join(root, "writer"),
	});
	const context = { lease, idempotencyKey: "grooming-1" };
	return { root, state, base, persistence, revision, writer, context };
}

describe("points-driven skill grooming", () => {
	it.each([
		{ points: [-9, -8, -7.5, 1], remaining: 2, removed: 2 },
		{ points: [-1, ...Array<number>(10).fill(0)], remaining: 10, removed: 1 },
		{ points: [-8, -9, -2, ...Array<number>(10).fill(0)], remaining: 10, removed: 3 },
		{ points: [-8, -9, -10, ...Array<number>(8).fill(0)], remaining: 8, removed: 3 },
	])("retires exactly $removed packages and leaves $remaining", async ({ points, remaining, removed }) => {
		const data = await fixture(points, true);
		const before = await data.persistence.loadSkillScores(data.state, data.revision);
		const write = vi.spyOn(data.writer, "write");
		const activate = vi.spyOn(data.writer, "activate");
		const result = await data.writer.groom(scope, data.persistence, data.context);
		expect(write).toHaveBeenCalledOnce();
		expect(activate).toHaveBeenCalledOnce();
		expect(write.mock.calls[0]![0].mutations[0]!.existingSkills).toHaveLength(removed);
		expect(result.state.skills).toHaveLength(remaining + 1);
		expect(result.manifest.base).toBe(data.base.manifest.version);
		expect(result.state.memory).toBe(data.base.state.memory);
		expect(await data.state.loadCurrent()).toEqual(result);
		expect(
			result.state.skills
				.filter((skill) => skill.workspace.directoryId === "other")
				.map((skill) => skill.packageVersion),
		).toEqual(data.base.state.skills.slice(-1).map((skill) => skill.packageVersion));
		const retained = await data.persistence.loadSkillScores(data.state, {
			...data.revision,
			harnessRevision: result.manifest.version,
		});
		expect(retained.every((row) => row.points > -8)).toBe(true);
		expect(await data.persistence.loadSkillScores(data.state, data.revision)).toEqual(before);
		const packages = await readdir(dirname(result.state.skills[0]!.baseDir));
		expect(packages).toEqual(result.state.skills.map((skill) => skill.name));
		const receipts = await data.writer.listActivationReceipts(scope);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]!.result.resultingHarnessVersion).toBe(result.manifest.version);
		expect(await data.writer.groom(scope, data.persistence, { ...data.context, idempotencyKey: "again" })).toEqual(
			result,
		);
		expect(write).toHaveBeenCalledOnce();
	});

	it("breaks equal-point ties by skill ID, independent of ledger order", async () => {
		const data = await fixture(Array<number>(12).fill(0));
		const rows = await data.persistence.loadSkillScores(data.state, data.revision);
		const expectedRemoved = rows
			.map((row) => row.skillId)
			.sort()
			.slice(0, 2);
		const result = await data.writer.groom(scope, { loadSkillScores: async () => [...rows].reverse() }, data.context);
		const retained = await data.persistence.loadSkillScores(data.state, {
			...data.revision,
			harnessRevision: result.manifest.version,
		});
		expect(retained).toHaveLength(10);
		expect(retained.some((row) => expectedRemoved.includes(row.skillId))).toBe(false);
	});

	it.each([{ points: [] }, { points: [-7.5] }, { points: Array<number>(10).fill(0) }])(
		"does not stage or advance a no-op inventory $points",
		async ({ points }) => {
			const data = await fixture(points);
			const write = vi.spyOn(data.writer, "write");
			expect(await data.writer.groom(scope, data.persistence, data.context)).toEqual(data.base);
			expect(write).not.toHaveBeenCalled();
			expect(await data.state.loadCurrent()).toEqual(data.base);
			expect(await data.writer.listActivationReceipts(scope)).toEqual([]);
		},
	);

	it("rejects incomplete, foreign, stale-package and stale-digest score inventories", async () => {
		const data = await fixture([-8]);
		const rows = await data.persistence.loadSkillScores(data.state, data.revision);
		for (const scores of [
			[],
			[...rows, ...rows],
			[{ ...rows[0]!, skillId: "installed" }],
			[{ ...rows[0]!, contentDigest: "wrong" }],
			[{ ...rows[0]!, packageVersion: "wrong" }],
		]) {
			await expect(data.writer.groom(scope, { loadSkillScores: async () => scores }, data.context)).rejects.toThrow(
				/inventory|digest/,
			);
			expect(await data.state.loadCurrent()).toEqual(data.base);
		}
	});

	it("recomputes maintenance after a selection race and preserves an updated package's reset score", async () => {
		const data = await fixture([-8, 0]);
		const changed = await data.state.saveVersion(
			{
				memory: "New memory.",
				skills: data.base.state.skills.map((skill, index) => ({
					path: skill.path,
					workspace: skill.workspace,
					files: skill.files.map(({ path, content }) => ({ path, content })),
					content: index === 0 ? `${skill.content}\nUpdated.` : skill.content,
				})),
			},
			data.base.manifest.version,
		);
		const select = data.state.selectVersionIfCurrent.bind(data.state);
		vi.spyOn(data.state, "selectVersionIfCurrent").mockImplementationOnce(async (version, expected) => {
			await data.state.selectVersion(changed.manifest.version);
			return select(version, expected);
		});
		expect(await data.writer.groom(scope, data.persistence, data.context)).toEqual(changed);
		expect(await data.state.loadCurrent()).toEqual(changed);
		expect(
			(
				await data.persistence.loadSkillScores(data.state, {
					...data.revision,
					harnessRevision: changed.manifest.version,
				})
			).map((row) => row.points),
		).toEqual([0, 0]);
	});
});
