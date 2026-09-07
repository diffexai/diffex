import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeHarnessSkillId,
	HarnessStateStore,
	type HarnessVersionBundle,
	type HarnessWorkspaceIdentity,
} from "../../harness-state/src/index.ts";
import {
	computeEvolutionContentDigest,
	EvolutionStorageCorruptionError,
	FileEvolutionPersistence,
	SKILL_SCORE_SCHEMA_VERSION,
	type SkillScoreLedger,
	type SkillScoreRow,
} from "../src/index.ts";

const scope = { repositoryId: "repository", scopeId: "workspace" };
const workspace = { repositoryId: "repository", directoryId: "directory" };
const otherRevision = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function skill(name: string, identity: HarnessWorkspaceIdentity = workspace) {
	return {
		path: `skills/${name}/SKILL.md`,
		content: `---\nname: ${name}\ndescription: Use for ${name} tasks.\n---\nFollow the procedure.\n`,
		workspace: identity,
		files: [{ path: "guide.md", content: "Original guide.\n" }],
	};
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "diffex-skill-scores-"));
	roots.push(root);
	const harness = new HarnessStateStore(join(root, "agent"), { workspace });
	const empty = await harness.initialize();
	const next = await harness.advance(
		{ memory: "", skills: [skill("first"), skill("second")] },
		empty.manifest.version,
	);
	if (next.status !== "advanced") throw new Error("Expected harness advance");
	const bundle = next.bundle;
	const storePath = join(root, "evolution");
	const store = new FileEvolutionPersistence(storePath);
	const ledgerPath = join(
		storePath,
		"skill-scores",
		`${computeEvolutionContentDigest({ scope, workspace }).replace(":", "-")}.json`,
	);
	await store.registerSkillScoreRevision(scope, workspace, empty);
	await store.registerSkillScoreRevision(scope, workspace, bundle);
	return { root, harness, empty, bundle, store, storePath, ledgerPath };
}

function row(bundle: HarnessVersionBundle, index = 0): SkillScoreRow {
	const item = bundle.state.skills[index];
	if (item === undefined) throw new Error("Missing fixture skill");
	return {
		skillId: computeHarnessSkillId(item.workspace, item.path),
		packageVersion: item.packageVersion,
		contentDigest: item.contentHash,
		workspace: item.workspace,
		harnessRevision: bundle.manifest.version,
		points: -1.5,
		lastAppliedOutputIdempotencyKey: "session-1/output-1",
	};
}

describe("skill score store", () => {
	it("scores sparse and empty reports atomically without drift on concurrent or older replays", async () => {
		const { bundle, store, storePath, ledgerPath, harness } = await fixture();
		const revision = bundle.manifest.version;
		const first = row(bundle);
		const second = row(bundle, 1);
		const sparse = {
			outputId: JSON.stringify(["session-1", 1]),
			harnessRevision: revision,
			judgments: [
				{ item: first, signal: "helpful" as const },
				{ item: second, signal: "harmful" as const },
			],
		};
		const restarted = new FileEvolutionPersistence(storePath);
		expect(
			(
				await Promise.all(
					[store, restarted].map((instance) => instance.applySkillScoreReport(scope, workspace, sparse, revision)),
				)
			).sort(),
		).toEqual(["already-applied", "committed"]);
		const initial = await store.loadSkillScores(scope, workspace, revision);
		expect(initial.scores.find((item) => item.skillId === first.skillId)?.points).toBe(1);
		expect(initial.scores.find((item) => item.skillId === second.skillId)?.points).toBe(-1.5);
		await Promise.all(
			[store, restarted].map((instance, index) =>
				instance.applySkillScoreReport(
					scope,
					workspace,
					{
						outputId: JSON.stringify([`session-${index + 1}`, 2]),
						harnessRevision: revision,
						judgments: [],
					},
					revision,
				),
			),
		);
		const saved = await readFile(ledgerPath, "utf8");
		expect(await restarted.applySkillScoreReport(scope, workspace, sparse, revision)).toBe("already-applied");
		expect(await readFile(ledgerPath, "utf8")).toBe(saved);
		const scores = await restarted.loadSkillScores(scope, workspace, revision);
		expect(scores.scores.find((item) => item.skillId === first.skillId)?.points).toBe(-1);
		expect(scores.scores.find((item) => item.skillId === second.skillId)?.points).toBe(-3.5);
		expect((JSON.parse(saved) as SkillScoreLedger).appliedOutputIds).toHaveLength(3);
		expect(await harness.loadCurrent()).toEqual(bundle);
		expect(await store.listSkillLifecycleObservations(scope)).toEqual([]);
	});

	it("rejects a whole report before committing any explicit, neutral or replay state", async () => {
		const { bundle, store, ledgerPath } = await fixture();
		const revision = bundle.manifest.version;
		const valid = { item: row(bundle), signal: "helpful" as const };
		const before = await readFile(ledgerPath, "utf8");
		for (const invalid of [
			valid,
			{ ...valid, signal: "harmful" as const },
			{ ...valid, item: { ...valid.item, skillId: "installed:skill" } },
			{ ...valid, item: { ...valid.item, packageVersion: otherRevision } },
			{ ...valid, item: { ...valid.item, contentDigest: otherRevision } },
			{ ...valid, item: { ...valid.item, workspace: { ...workspace, directoryId: "other" } } },
		]) {
			await expect(
				store.applySkillScoreReport(
					scope,
					workspace,
					{
						outputId: "invalid-output",
						harnessRevision: revision,
						judgments: [valid, invalid],
					},
					revision,
				),
			).rejects.toThrow("Invalid skill score judgment");
			expect(await readFile(ledgerPath, "utf8")).toBe(before);
		}
		await expect(
			store.applySkillScoreReport(
				scope,
				workspace,
				{
					outputId: "",
					harnessRevision: revision,
					judgments: [],
				},
				revision,
			),
		).rejects.toThrow("Invalid skill score report");
		expect(await readFile(ledgerPath, "utf8")).toBe(before);
	});

	it.each(["content", "supporting-file"])(
		"excludes superseded %s and retired versions from late reports",
		async (change) => {
			const { bundle, store, harness, empty, ledgerPath } = await fixture();
			const revision = bundle.manifest.version;
			await store.applySkillScoreReport(
				scope,
				workspace,
				{
					outputId: "initial",
					harnessRevision: revision,
					judgments: [],
				},
				revision,
			);
			const changed = skill("first");
			if (change === "content") changed.content += "Changed procedure.\n";
			else changed.files[0]!.content = "Changed guide.\n";
			const next = await harness.saveVersion({ memory: "", skills: [changed] }, revision);
			await store.registerSkillScoreRevision(scope, workspace, next);
			await store.applySkillScoreReport(
				scope,
				workspace,
				{
					outputId: "late",
					harnessRevision: revision,
					judgments: [{ item: row(bundle), signal: "helpful" }],
				},
				next.manifest.version,
			);
			expect((await store.loadSkillScores(scope, workspace, revision)).scores.map((item) => item.points)).toEqual([
				-1, -1,
			]);
			expect((await store.loadSkillScores(scope, workspace, next.manifest.version)).scores[0]?.points).toBe(0);
			await store.applySkillScoreReport(
				scope,
				workspace,
				{
					outputId: "retired",
					harnessRevision: revision,
					judgments: [],
				},
				empty.manifest.version,
			);
			const saved = await readFile(ledgerPath, "utf8");
			expect(
				await store.applySkillScoreReport(
					scope,
					workspace,
					{
						outputId: "retired",
						harnessRevision: revision,
						judgments: [],
					},
					revision,
				),
			).toBe("already-applied");
			expect(await readFile(ledgerPath, "utf8")).toBe(saved);
		},
	);

	it("registers exact active identities at zero, persists totals, and reads without harness files", async () => {
		const { root, harness, empty, bundle, store, storePath, ledgerPath } = await fixture();
		expect((await store.loadSkillScores(scope, workspace, empty.manifest.version)).scores).toEqual([]);
		const initial = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
		expect(initial.scores).toEqual(
			bundle.state.skills
				.map((_, index) => {
					const { harnessRevision: _revision, ...item } = row(bundle, index);
					return { ...item, points: 0, lastAppliedOutputIdempotencyKey: null };
				})
				.sort((left, right) => left.skillId.localeCompare(right.skillId)),
		);
		expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toMatchObject({
			schemaVersion: SKILL_SCORE_SCHEMA_VERSION,
			scope,
			workspace,
			rows: [],
		});
		await store.registerSkillScoreRevision(scope, workspace, bundle);
		expect(await store.loadSkillScores(scope, workspace, bundle.manifest.version)).toEqual(initial);
		expect(await store.saveSkillScores(scope, workspace, initial.revision, [row(bundle)])).toBe("committed");
		const saved = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
		expect(saved.scores.find((item) => item.skillId === row(bundle).skillId)?.points).toBe(-1.5);
		expect(await harness.loadCurrent()).toEqual(bundle);
		await rm(join(root, "agent"), { recursive: true });
		expect(
			await new FileEvolutionPersistence(storePath).loadSkillScores(scope, workspace, bundle.manifest.version),
		).toEqual(saved);
	});

	it("isolates scope, repository, directory, and repository-only workspaces; excludes installed skills", async () => {
		const { root, harness, bundle, store } = await fixture();
		const otherWorkspaces = [
			{ ...workspace, directoryId: "other" },
			{ ...workspace, repositoryId: "other" },
			{ repositoryId: workspace.repositoryId },
		];
		const next = await harness.advance(
			{
				memory: "",
				skills: [skill("first"), ...otherWorkspaces.map((identity, index) => skill(`foreign-${index}`, identity))],
			},
			bundle.manifest.version,
		);
		if (next.status !== "advanced") throw new Error("Expected harness advance");
		const installed = join(root, "agent", "skills", "installed");
		await mkdir(installed, { recursive: true });
		await writeFile(join(installed, "SKILL.md"), skill("installed").content);
		await store.registerSkillScoreRevision(scope, workspace, next.bundle);
		const initial = await store.loadSkillScores(scope, workspace, next.bundle.manifest.version);
		expect(initial.scores.map((item) => item.skillId)).toEqual([row(next.bundle).skillId]);
		await store.saveSkillScores(scope, workspace, initial.revision, [row(next.bundle)]);
		for (const identity of otherWorkspaces) {
			const otherScope = { ...scope, repositoryId: identity.repositoryId };
			await expect(store.loadSkillScores(otherScope, identity, next.bundle.manifest.version)).rejects.toThrow(
				"Unregistered",
			);
			await store.registerSkillScoreRevision(otherScope, identity, next.bundle);
			const scores = await store.loadSkillScores(otherScope, identity, next.bundle.manifest.version);
			expect(scores.scores).toHaveLength(1);
			expect(scores.scores[0]).toMatchObject({ workspace: identity, points: 0 });
		}
		const otherScope = { ...scope, scopeId: "other" };
		await store.registerSkillScoreRevision(otherScope, workspace, next.bundle);
		expect((await store.loadSkillScores(otherScope, workspace, next.bundle.manifest.version)).scores[0]?.points).toBe(
			0,
		);
		await expect(store.registerSkillScoreRevision(scope, otherWorkspaces[1]!, next.bundle)).rejects.toThrow(
			"scope or workspace",
		);
	});

	it.each(["content", "supporting-file"])(
		"resets changed %s but retains unchanged packages across revisions",
		async (change) => {
			const { harness, bundle, store, ledgerPath } = await fixture();
			const initial = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
			await store.saveSkillScores(scope, workspace, initial.revision, [row(bundle), row(bundle, 1)]);
			const memoryOnly = await harness.advance({ memory: "Unrelated memory change.\n" }, bundle.manifest.version);
			if (memoryOnly.status !== "advanced") throw new Error("Expected harness advance");
			await store.registerSkillScoreRevision(scope, workspace, memoryOnly.bundle);
			expect(
				(await store.loadSkillScores(scope, workspace, memoryOnly.bundle.manifest.version)).scores.map(
					(item) => item.points,
				),
			).toEqual([-1.5, -1.5]);
			const changed = skill("first");
			if (change === "content") changed.content += "Updated procedure.\n";
			else changed.files[0]!.content = "Updated guide.\n";
			const next = await harness.advance(
				{ memory: "", skills: [changed, skill("second")] },
				memoryOnly.bundle.manifest.version,
			);
			if (next.status !== "advanced") throw new Error("Expected harness advance");
			await store.registerSkillScoreRevision(scope, workspace, next.bundle);
			const scores = await store.loadSkillScores(scope, workspace, next.bundle.manifest.version);
			const replacement = scores.scores.find((item) => item.skillId === row(bundle).skillId);
			expect(replacement).toMatchObject({ points: 0, lastAppliedOutputIdempotencyKey: null });
			expect(replacement?.packageVersion).not.toBe(row(bundle).packageVersion);
			expect(replacement?.contentDigest === row(bundle).contentDigest).toBe(change === "supporting-file");
			expect(scores.scores.find((item) => item.skillId === row(bundle, 1).skillId)?.points).toBe(-1.5);
			await expect(
				store.saveSkillScores(scope, workspace, scores.revision, [
					{ ...row(bundle), harnessRevision: next.bundle.manifest.version },
				]),
			).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
			await store.saveSkillScores(scope, workspace, scores.revision, [{ ...row(next.bundle), points: 2 }]);
			expect(JSON.parse(await readFile(ledgerPath, "utf8")).rows).toHaveLength(3);
			expect(
				(await store.loadSkillScores(scope, workspace, bundle.manifest.version)).scores.map((item) => item.points),
			).toEqual([-1.5, -1.5]);
		},
	);

	it("uses compare-and-swap across instances with no partial writes", async () => {
		const { bundle, store, storePath } = await fixture();
		const initial = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
		const rows = [row(bundle), row(bundle, 1)];
		const results = await Promise.all([
			store.saveSkillScores(scope, workspace, initial.revision, rows),
			new FileEvolutionPersistence(storePath).saveSkillScores(scope, workspace, initial.revision, rows),
		]);
		expect(results.sort()).toEqual(["committed", "conflict"]);
		const saved = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
		expect(saved.revision).toBe(initial.revision + 1);
		expect(saved.scores.map((item) => item.points)).toEqual([-1.5, -1.5]);
		await expect(store.saveSkillScores(scope, workspace, saved.revision, [row(bundle), row(bundle)])).rejects.toThrow(
			"Duplicate",
		);
		await expect(
			store.saveSkillScores(scope, workspace, saved.revision, [
				{ ...row(bundle), points: 4 },
				{ ...row(bundle, 1), packageVersion: otherRevision },
			]),
		).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
		expect(await store.loadSkillScores(scope, workspace, bundle.manifest.version)).toEqual(saved);
	});

	it.each([
		{ points: Number.NaN },
		{ points: Number.POSITIVE_INFINITY },
		{ harnessRevision: otherRevision },
		{ contentDigest: otherRevision },
		{ packageVersion: otherRevision },
		{ skillId: "installed:workspace:external-skill" },
		{ skillId: `skill:${"a".repeat(64)}` },
		{ workspace: { ...workspace, directoryId: "other" } },
		{ lastAppliedOutputIdempotencyKey: "" },
	])("rejects invalid writes: %j", async (override) => {
		const { bundle, store } = await fixture();
		const before = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
		await expect(
			store.saveSkillScores(scope, workspace, before.revision, [{ ...row(bundle), ...override }]),
		).rejects.toThrow();
		expect(await store.loadSkillScores(scope, workspace, bundle.manifest.version)).toEqual(before);
	});

	it("rejects changed and duplicate revision catalogs", async () => {
		const { bundle, store } = await fixture();
		await expect(
			store.registerSkillScoreRevision(scope, workspace, { ...bundle, state: { ...bundle.state, skills: [] } }),
		).rejects.toThrow("different active skills");
		await expect(
			store.registerSkillScoreRevision(scope, workspace, {
				manifest: { ...bundle.manifest, version: otherRevision },
				state: { ...bundle.state, skills: [...bundle.state.skills, ...bundle.state.skills] },
			}),
		).rejects.toBeInstanceOf(EvolutionStorageCorruptionError);
	});

	const corruptions: readonly [string, (ledger: SkillScoreLedger) => unknown][] = [
		["schema", (ledger) => ({ ...ledger, schemaVersion: 99 })],
		["missing replay state", (ledger) => ({ ...ledger, appliedOutputIds: undefined })],
		["duplicate outputs", (ledger) => ({ ...ledger, appliedOutputIds: ["output", "output"] })],
		["empty output", (ledger) => ({ ...ledger, appliedOutputIds: [""] })],
		["scope", (ledger) => ({ ...ledger, scope: { ...scope, scopeId: "other" } })],
		["workspace", (ledger) => ({ ...ledger, workspace: { ...workspace, directoryId: "other" } })],
		["revision", (ledger) => ({ ...ledger, revision: -1 })],
		["duplicate catalogs", (ledger) => ({ ...ledger, catalogs: [...ledger.catalogs, ...ledger.catalogs] })],
		["duplicate rows", (ledger) => ({ ...ledger, rows: [...ledger.rows, ...ledger.rows] })],
		["unbound rows", (ledger) => ({ ...ledger, catalogs: [] })],
		[
			"duplicate items",
			(ledger) => ({
				...ledger,
				catalogs: ledger.catalogs.map((catalog) => ({ ...catalog, items: [...catalog.items, ...catalog.items] })),
			}),
		],
		[
			"foreign items",
			(ledger) => ({
				...ledger,
				catalogs: ledger.catalogs.map((catalog) => ({
					...catalog,
					items: catalog.items.map((item) => ({ ...item, workspace: { ...workspace, directoryId: "other" } })),
				})),
			}),
		],
		[
			"foreign rows",
			(ledger) => ({
				...ledger,
				rows: ledger.rows.map((item) => ({ ...item, workspace: { ...workspace, repositoryId: "other" } })),
			}),
		],
		["points", (ledger) => ({ ...ledger, rows: ledger.rows.map((item) => ({ ...item, points: "0" })) })],
		[
			"package",
			(ledger) => ({ ...ledger, rows: ledger.rows.map((item) => ({ ...item, packageVersion: otherRevision })) }),
		],
		["digest", (ledger) => ({ ...ledger, rows: ledger.rows.map((item) => ({ ...item, contentDigest: "bad" })) })],
		[
			"idempotency key",
			(ledger) => ({
				...ledger,
				rows: ledger.rows.map((item) => ({ ...item, lastAppliedOutputIdempotencyKey: null })),
			}),
		],
	];
	it.each(corruptions)("rejects corrupt durable data on read: %s", async (_name, corrupt) => {
		const { bundle, store, ledgerPath } = await fixture();
		const before = await store.loadSkillScores(scope, workspace, bundle.manifest.version);
		await store.saveSkillScores(scope, workspace, before.revision, [row(bundle)]);
		const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as SkillScoreLedger;
		await writeFile(ledgerPath, JSON.stringify(corrupt(ledger)));
		await expect(store.loadSkillScores(scope, workspace, bundle.manifest.version)).rejects.toBeInstanceOf(
			EvolutionStorageCorruptionError,
		);
	});

	it("rejects malformed JSON rather than returning zero points", async () => {
		const { bundle, store, ledgerPath } = await fixture();
		await writeFile(ledgerPath, "{");
		await expect(store.loadSkillScores(scope, workspace, bundle.manifest.version)).rejects.toBeInstanceOf(
			EvolutionStorageCorruptionError,
		);
	});
});
