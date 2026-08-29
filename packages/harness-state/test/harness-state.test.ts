import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
	computeHarnessSkillId,
	computeHarnessVersion,
	HARNESS_VERSION_SCHEMA_VERSION,
	type HarnessArtifactManifest,
	HarnessArtifactManifestSchema,
	type HarnessSkill,
	HarnessSkillFileInputSchema,
	HarnessSkillFileSchema,
	HarnessSkillInputSchema,
	HarnessSkillSchema,
	type HarnessState,
	HarnessStateInputSchema,
	HarnessStateSchema,
	HarnessStateStore,
	type HarnessVersion,
	type HarnessVersionBundle,
	HarnessVersionBundleSchema,
	type HarnessVersionManifest,
	HarnessVersionManifestSchema,
	type HarnessVersionMetadata,
	HarnessVersionMetadataSchema,
	HarnessVersionPointerSchema,
	type HarnessWorkspaceIdentity,
	HarnessWorkspaceIdentitySchema,
	harnessVersionDirectoryName,
	INITIAL_HARNESS_VERSION_METADATA,
	loadHarnessState,
	saveHarnessState,
	serializeHarnessVersion,
	validateHarnessSkillContent,
} from "../src/index.ts";

const temporaryRoots: string[] = [];
const EXTERNAL_VERSION = `sha256:${"0".repeat(64)}`;
const LESSON_METADATA: HarnessVersionMetadata = { evolutionMemory: { nextLessonNumber: 7 } };

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTemporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "diffex-harness-state-test-"));
	temporaryRoots.push(root);
	return root;
}

function hash(bytes: string | Uint8Array): HarnessVersion {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function createArtifact(
	bytes: string | Uint8Array,
	kind = "evolution-memory",
	path = "EVOLVE.md",
): HarnessArtifactManifest {
	return { kind, path, contentHash: hash(bytes) };
}

function createManifest(
	artifacts: readonly HarnessArtifactManifest[],
	base: HarnessVersion | null = null,
	metadata: HarnessVersionMetadata = INITIAL_HARNESS_VERSION_METADATA,
): HarnessVersionManifest {
	return {
		schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
		version: computeHarnessVersion({ schemaVersion: HARNESS_VERSION_SCHEMA_VERSION, base, metadata, artifacts }),
		base,
		metadata,
		artifacts: [...artifacts],
	};
}

async function writeRawBundle(
	bundlePath: string,
	manifest: HarnessVersionManifest,
	files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
	await mkdir(bundlePath, { recursive: true });
	await writeFile(join(bundlePath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	for (const [path, content] of Object.entries(files)) {
		const filePath = join(bundlePath, path);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, content);
	}
}

const WORKSPACE: HarnessWorkspaceIdentity = {
	repositoryId: "global",
	directoryId: `sha256:${"1".repeat(64)}`,
};

function skillContent(name: string, description = `Use ${name} for focused work.`): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function assertReadonlyTypes(
	state: HarnessState,
	skill: HarnessSkill,
	artifact: HarnessArtifactManifest,
	manifest: HarnessVersionManifest,
	bundle: HarnessVersionBundle,
): void {
	// @ts-expect-error HarnessState fields are readonly.
	state.memory = "changed";
	// @ts-expect-error HarnessSkill fields are readonly.
	skill.name = "changed";
	// @ts-expect-error HarnessArtifactManifest fields are readonly.
	artifact.path = "changed";
	// @ts-expect-error HarnessVersionManifest fields are readonly.
	manifest.version = EXTERNAL_VERSION;
	// @ts-expect-error HarnessVersionBundle fields are readonly.
	bundle.state = state;
}
void assertReadonlyTypes;

describe("canonical harness versions", () => {
	test("hashes the exact canonical schema, base, and sorted artifact descriptors", () => {
		const first = createArtifact("first", "future-kind", "nested/z.txt");
		const second = createArtifact("second", "evolution-memory", "EVOLVE.md");
		const input = {
			schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
			base: EXTERNAL_VERSION,
			metadata: INITIAL_HARNESS_VERSION_METADATA,
			artifacts: [first, second],
		};
		const canonical = serializeHarnessVersion(input);

		expect(canonical).toBe(
			JSON.stringify({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: EXTERNAL_VERSION,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [second, first],
			}),
		);
		expect(computeHarnessVersion(input)).toBe(hash(canonical));
		expect(computeHarnessVersion({ ...input, artifacts: [second, first] })).toBe(computeHarnessVersion(input));
	});

	test("changes independently for base, bytes, and artifact metadata", () => {
		const original = createArtifact("memory");
		const version = computeHarnessVersion({
			schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
			base: null,
			metadata: INITIAL_HARNESS_VERSION_METADATA,
			artifacts: [original],
		});

		expect(
			computeHarnessVersion({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: EXTERNAL_VERSION,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [original],
			}),
		).not.toBe(version);
		expect(
			computeHarnessVersion({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: null,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [createArtifact("changed")],
			}),
		).not.toBe(version);
		expect(
			computeHarnessVersion({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: null,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [{ ...original, kind: "future-kind" }],
			}),
		).not.toBe(version);
		expect(
			computeHarnessVersion({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: null,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [{ ...original, path: "nested/EVOLVE.md" }],
			}),
		).not.toBe(version);
		expect(
			computeHarnessVersion({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: null,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [{ ...original, workspace: WORKSPACE }],
			}),
		).not.toBe(version);
		expect(
			computeHarnessVersion({
				schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
				base: null,
				metadata: LESSON_METADATA,
				artifacts: [original],
			}),
		).not.toBe(version);
	});

	test("derives stable evolved skill identities from workspace and canonical path", () => {
		const skillId = computeHarnessSkillId(WORKSPACE, "skills/focused-review/SKILL.md");

		expect(skillId).toMatch(/^skill:[0-9a-f]{64}$/);
		expect(computeHarnessSkillId(WORKSPACE, "skills/focused-review/SKILL.md")).toBe(skillId);
		expect(computeHarnessSkillId({ ...WORKSPACE, directoryId: "other" }, "skills/focused-review/SKILL.md")).not.toBe(
			skillId,
		);
		expect(() => computeHarnessSkillId(WORKSPACE, "../SKILL.md")).toThrow(/artifact path/i);
	});

	test("validates an in-memory skill with the same canonical rules as a bundle", () => {
		const content = skillContent("focused-review");

		expect(validateHarnessSkillContent("skills/focused-review/SKILL.md", content)).toEqual({
			name: "focused-review",
			description: "Use focused-review for focused work.",
			disableModelInvocation: false,
		});
		expect(() => validateHarnessSkillContent("skills/other/SKILL.md", content)).toThrow(/canonical path/i);
		expect(() => validateHarnessSkillContent("skills/focused-review/SKILL.md", `\uFEFF${content}`)).toThrow(
			/invalid content/i,
		);
	});

	test("exports strict schemas", () => {
		const artifact = createArtifact("");
		const manifest = createManifest([artifact]);
		const bundle = { state: { memory: "", skills: [] }, manifest };

		expect(Check(HarnessStateInputSchema, { memory: "" })).toBe(true);
		expect(Check(HarnessStateSchema, { memory: "", skills: [] })).toBe(true);
		expect(Check(HarnessStateSchema, { memory: " \t\n", skills: [] })).toBe(false);
		expect(Check(HarnessStateSchema, { memory: "\uFEFFmemory", skills: [] })).toBe(false);
		expect(Check(HarnessStateSchema, { memory: "\uD800", skills: [] })).toBe(false);
		expect(Check(HarnessStateSchema, { memory: "\uDC00", skills: [] })).toBe(false);
		expect(Check(HarnessStateSchema, { memory: "\uD800\uDC00", skills: [] })).toBe(true);
		expect(Check(HarnessStateSchema, { memory: "memory", skills: [], extra: true })).toBe(false);
		expect(Check(HarnessWorkspaceIdentitySchema, WORKSPACE)).toBe(true);
		expect(Check(HarnessSkillFileInputSchema, { path: "scripts/run.sh", content: "#!/bin/sh\n" })).toBe(true);
		expect(Check(HarnessSkillFileSchema, { path: "scripts/run.sh" })).toBe(false);
		expect(
			Check(HarnessSkillInputSchema, {
				path: "skills/example/SKILL.md",
				content: skillContent("example"),
				workspace: WORKSPACE,
				files: [{ path: "scripts/run.sh", content: "#!/bin/sh\n" }],
			}),
		).toBe(true);
		expect(Check(HarnessSkillSchema, { path: "skills/example/SKILL.md" })).toBe(false);
		expect(Check(HarnessArtifactManifestSchema, artifact)).toBe(true);
		expect(Check(HarnessArtifactManifestSchema, { ...artifact, extra: true })).toBe(false);
		expect(Check(HarnessVersionMetadataSchema, LESSON_METADATA)).toBe(true);
		expect(Check(HarnessVersionMetadataSchema, { evolutionMemory: { nextLessonNumber: 0 } })).toBe(false);
		expect(Check(HarnessVersionManifestSchema, manifest)).toBe(true);
		expect(Check(HarnessVersionManifestSchema, { ...manifest, schemaVersion: 1 })).toBe(false);
		const { metadata: _metadata, ...manifestWithoutMetadata } = manifest;
		expect(Check(HarnessVersionManifestSchema, manifestWithoutMetadata)).toBe(false);
		expect(Check(HarnessVersionManifestSchema, { ...manifest, extra: true })).toBe(false);
		expect(Check(HarnessVersionPointerSchema, { version: manifest.version })).toBe(true);
		expect(Check(HarnessVersionPointerSchema, { version: manifest.version, extra: true })).toBe(false);
		expect(Check(HarnessVersionBundleSchema, bundle)).toBe(true);
	});
});

describe("bundle persistence and validation", () => {
	test.each([
		["empty", ""],
		["Unicode", "Inspect café, 水, and 𐅑."],
		["CRLF", "First\r\nSecond\r\n"],
		["trailing whitespace", "Keep exactly.  \n\t "],
	] as const)("preserves %s EVOLVE bytes", async (_label, memory) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const saved = await saveHarnessState({ memory }, destination, EXTERNAL_VERSION, INITIAL_HARNESS_VERSION_METADATA);

		expect(await readFile(join(destination, "EVOLVE.md"), "utf8")).toBe(memory);
		expect(saved.manifest.base).toBe(EXTERNAL_VERSION);
		expect(saved.manifest.artifacts).toEqual([createArtifact(memory)]);
		expect(saved.manifest.version).toBe(computeHarnessVersion(saved.manifest));
		expect(await loadHarnessState(destination)).toEqual(saved);
	});

	test("persists validated workspace-scoped skill packages in the atomic revision", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const content = skillContent("review-workflow");
		const script = "#!/bin/sh\nexec npm run test:focused\n";
		const reference = "# Review workflow reference\n";
		const saved = await saveHarnessState(
			{
				memory: "Use the selected harness.\n",
				skills: [
					{
						path: "skills/review-workflow/SKILL.md",
						content,
						workspace: WORKSPACE,
						files: [
							{ path: "references/review.md", content: reference },
							{ path: "scripts/run.sh", content: script },
						],
					},
				],
			},
			destination,
			EXTERNAL_VERSION,
			INITIAL_HARNESS_VERSION_METADATA,
		);

		expect(saved.state.skills).toEqual([
			expect.objectContaining({
				path: "skills/review-workflow/SKILL.md",
				name: "review-workflow",
				description: "Use review-workflow for focused work.",
				content,
				contentHash: hash(content),
				packageVersion: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				workspace: WORKSPACE,
				files: [
					expect.objectContaining({
						path: "references/review.md",
						content: reference,
						contentHash: hash(reference),
					}),
					expect.objectContaining({ path: "scripts/run.sh", content: script, contentHash: hash(script) }),
				],
				disableModelInvocation: false,
			}),
		]);
		expect(saved.state.skills[0]?.filePath).toBe(join(destination, "skills", "review-workflow", "SKILL.md"));
		expect(saved.manifest.artifacts).toEqual([
			createArtifact("Use the selected harness.\n"),
			{
				kind: "skill",
				path: "skills/review-workflow/SKILL.md",
				contentHash: hash(content),
				workspace: WORKSPACE,
			},
			{
				kind: "skill-file",
				path: "skills/review-workflow/references/review.md",
				contentHash: hash(reference),
				workspace: WORKSPACE,
			},
			{
				kind: "skill-file",
				path: "skills/review-workflow/scripts/run.sh",
				contentHash: hash(script),
				workspace: WORKSPACE,
			},
		]);
		expect(await readFile(join(destination, "skills", "review-workflow", "SKILL.md"), "utf8")).toBe(content);
		expect(await readFile(join(destination, "skills", "review-workflow", "scripts", "run.sh"), "utf8")).toBe(script);
		expect(await loadHarnessState(destination)).toEqual(saved);
	});

	test("changes the package and harness version when only a supporting file changes", async () => {
		const root = await createTemporaryRoot();
		const content = skillContent("versioned-package");
		const save = (destination: string, fileContent: string) =>
			saveHarnessState(
				{
					memory: "",
					skills: [
						{
							path: "skills/versioned-package/SKILL.md",
							content,
							workspace: WORKSPACE,
							files: [{ path: "references/details.md", content: fileContent }],
						},
					],
				},
				destination,
				null,
				INITIAL_HARNESS_VERSION_METADATA,
			);
		const first = await save(join(root, "first"), "First reference.\n");
		const second = await save(join(root, "second"), "Second reference.\n");

		expect(second.state.skills[0]?.contentHash).toBe(first.state.skills[0]?.contentHash);
		expect(second.state.skills[0]?.packageVersion).not.toBe(first.state.skills[0]?.packageVersion);
		expect(second.manifest.version).not.toBe(first.manifest.version);
	});

	test("is idempotent only for the same immutable revision", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const first = await saveHarnessState({ memory: "same" }, destination, null, INITIAL_HARNESS_VERSION_METADATA);
		const second = await saveHarnessState({ memory: "same" }, destination, null, INITIAL_HARNESS_VERSION_METADATA);
		expect(second).toEqual(first);

		await expect(
			saveHarnessState({ memory: "different" }, destination, null, INITIAL_HARNESS_VERSION_METADATA),
		).rejects.toThrow(/different content/i);
		expect((await loadHarnessState(destination)).state.memory).toBe("same");
	});

	test("stores lesson numbering metadata in the content-addressed manifest", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const saved = await saveHarnessState(
			{ memory: "Lesson 6: Existing lesson.\n" },
			destination,
			null,
			LESSON_METADATA,
		);

		expect(saved.manifest.metadata).toEqual(LESSON_METADATA);
		expect(saved.manifest.version).toBe(computeHarnessVersion(saved.manifest));
		expect(await loadHarnessState(destination)).toEqual(saved);
	});

	test("cleans its staged directory after a destination race", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const temporaryPrefix = `.${basename(destination)}.tmp-`;
		const saving = saveHarnessState(
			{ memory: "x".repeat(16 * 1024 * 1024) },
			destination,
			null,
			INITIAL_HARNESS_VERSION_METADATA,
		).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		let stagedPath: string | undefined;
		for (let attempt = 0; attempt < 1_000; attempt++) {
			const stagedName = (await readdir(root)).find((entry) => entry.startsWith(temporaryPrefix));
			if (stagedName !== undefined) {
				stagedPath = join(root, stagedName);
				break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
		}
		expect(stagedPath).toBeDefined();

		await mkdir(destination);
		await writeFile(join(destination, "unrelated"), "preserved");
		const result = await saving;
		expect(result.ok).toBe(false);
		expect(await readFile(join(destination, "unrelated"), "utf8")).toBe("preserved");
		expect((await readdir(root)).filter((entry) => entry.startsWith(temporaryPrefix))).toEqual([]);
	});

	test.each([" \t\r\n", "\uFEFFmemory"])("rejects invalid memory %j before writing", async (memory) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await expect(saveHarnessState({ memory }, destination, null, INITIAL_HARNESS_VERSION_METADATA)).rejects.toThrow(
			/invalid harness state/i,
		);
		expect(await pathExists(destination)).toBe(false);
	});

	test.each([
		["high", "\uD800"],
		["low", "\uDC00"],
	] as const)("rejects a lone %s surrogate across repeated saves", async (_label, memory) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				saveHarnessState({ memory }, destination, null, INITIAL_HARNESS_VERSION_METADATA),
			).rejects.toThrow(/invalid harness state/i);
			expect(await pathExists(destination)).toBe(false);
		}
	});

	test("rejects an undeclared file and exact-casing mismatch", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await saveHarnessState({ memory: "memory" }, destination, null, INITIAL_HARNESS_VERSION_METADATA);
		await writeFile(join(destination, "extra.txt"), "extra");
		await expect(loadHarnessState(destination)).rejects.toThrow(/inventory mismatch.*undeclared/i);
		await rm(join(destination, "extra.txt"));
		await rename(join(destination, "EVOLVE.md"), join(destination, "evolve.md"));
		await expect(loadHarnessState(destination)).rejects.toThrow(/inventory mismatch/i);
	});

	test("rejects an undeclared empty directory", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await saveHarnessState({ memory: "memory" }, destination, null, INITIAL_HARNESS_VERSION_METADATA);
		await mkdir(join(destination, "undeclared"));
		await expect(loadHarnessState(destination)).rejects.toThrow(/undeclared directories/i);
	});

	test.each([
		"../outside",
		"/absolute",
		"nested\\file",
		"C:/drive",
		"nested//file",
		"CON",
		"nested/a:b",
		"trailing.",
		"trailing ",
		"wild*card",
	])("rejects traversal or non-portable artifact path %j", async (artifactPath) => {
		const root = await createTemporaryRoot();
		const artifact = createArtifact("memory", "evolution-memory", artifactPath);
		const manifest = createManifest([artifact]);
		const destination = join(root, "bundle");
		await mkdir(destination);
		await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest));
		await expect(loadHarnessState(destination)).rejects.toThrow(/harness artifact path/i);
	});

	test("rejects artifact paths that collide on case-insensitive filesystems", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const manifest = createManifest([
			createArtifact("first", "evolution-memory", "EVOLVE.md"),
			createArtifact("second", "future-skill", "evolve.md"),
		]);
		await mkdir(destination);
		await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest));

		await expect(loadHarnessState(destination)).rejects.toThrow(/case-insensitive filesystem/i);
	});

	test.each([
		["noncanonical path", "skills/example/README.md", skillContent("example"), /canonical path/i],
		["path and name mismatch", "skills/example/SKILL.md", skillContent("different"), /name.*canonical path/i],
		["missing frontmatter", "skills/example/SKILL.md", "# Example\n", /YAML frontmatter/i],
		["missing description", "skills/example/SKILL.md", "---\nname: example\n---\n", /description/i],
	] as const)("rejects a skill with %s", async (_label, path, content, expected) => {
		const root = await createTemporaryRoot();
		await expect(
			saveHarnessState(
				{ memory: "", skills: [{ path, content, workspace: WORKSPACE }] },
				join(root, "bundle"),
				null,
				INITIAL_HARNESS_VERSION_METADATA,
			),
		).rejects.toThrow(expected);
	});

	test("rejects escaping, colliding, and orphaned skill package files", async () => {
		const root = await createTemporaryRoot();
		const content = skillContent("example");
		await expect(
			saveHarnessState(
				{
					memory: "",
					skills: [
						{
							path: "skills/example/SKILL.md",
							content,
							workspace: WORKSPACE,
							files: [{ path: "../outside.sh", content: "unsafe" }],
						},
					],
				},
				join(root, "escaping"),
				null,
				INITIAL_HARNESS_VERSION_METADATA,
			),
		).rejects.toThrow(/artifact path/i);
		await expect(
			saveHarnessState(
				{
					memory: "",
					skills: [
						{
							path: "skills/example/SKILL.md",
							content,
							workspace: WORKSPACE,
							files: [
								{ path: "scripts/run.sh", content: "first" },
								{ path: "SCRIPTS/RUN.SH", content: "second" },
							],
						},
					],
				},
				join(root, "colliding"),
				null,
				INITIAL_HARNESS_VERSION_METADATA,
			),
		).rejects.toThrow(/collides by case/i);

		const orphanPath = join(root, "orphan");
		const orphan = {
			...createArtifact("orphan", "skill-file", "skills/example/scripts/run.sh"),
			workspace: WORKSPACE,
		};
		await writeRawBundle(orphanPath, createManifest([createArtifact(""), orphan]), {
			"EVOLVE.md": "",
			"skills/example/scripts/run.sh": "orphan",
		});
		await expect(loadHarnessState(orphanPath)).rejects.toThrow(/belong to a declared skill/i);
	});

	test("rejects skill artifacts without workspace metadata", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const content = skillContent("example");
		const artifacts = [createArtifact(""), createArtifact(content, "skill", "skills/example/SKILL.md")];
		await writeRawBundle(destination, createManifest(artifacts), {
			"EVOLVE.md": "",
			"skills/example/SKILL.md": content,
		});

		await expect(loadHarnessState(destination)).rejects.toThrow(/workspace identity/i);
	});

	test.each([
		["malformed UTF-8", new Uint8Array([0xc3, 0x28]), /UTF-8/i],
		["BOM", new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), /BOM/i],
	] as const)("rejects %s skill bytes", async (_label, bytes, expected) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const skillArtifact = {
			...createArtifact(bytes, "skill", "skills/example/SKILL.md"),
			workspace: WORKSPACE,
		};
		await writeRawBundle(destination, createManifest([createArtifact(""), skillArtifact]), {
			"EVOLVE.md": "",
			"skills/example/SKILL.md": bytes,
		});

		await expect(loadHarnessState(destination)).rejects.toThrow(expected);
	});

	test("rejects duplicate paths and unsupported artifact kinds", async () => {
		const root = await createTemporaryRoot();
		const duplicatePath = join(root, "duplicate");
		const duplicateArtifact = createArtifact("memory");
		await writeRawBundle(duplicatePath, createManifest([duplicateArtifact, duplicateArtifact]), {
			"EVOLVE.md": "memory",
		});
		await expect(loadHarnessState(duplicatePath)).rejects.toThrow(/duplicate/i);

		const unsupportedPath = join(root, "unsupported");
		const unsupported = createArtifact("memory", "future-skill");
		await writeRawBundle(unsupportedPath, createManifest([unsupported]), { "EVOLVE.md": "memory" });
		await expect(loadHarnessState(unsupportedPath)).rejects.toThrow(/unsupported.*future-skill/i);
	});

	test("rejects symbolic links and non-regular artifact entries", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await saveHarnessState({ memory: "memory" }, destination, null, INITIAL_HARNESS_VERSION_METADATA);
		await rm(join(destination, "EVOLVE.md"));
		await writeFile(join(root, "outside"), "memory");
		await symlink(join(root, "outside"), join(destination, "EVOLVE.md"));
		await expect(loadHarnessState(destination)).rejects.toThrow(/symbolic link/i);

		await rm(join(destination, "EVOLVE.md"));
		await mkdir(join(destination, "EVOLVE.md"));
		await expect(loadHarnessState(destination)).rejects.toThrow(/inventory mismatch|regular file/i);
	});

	test("rejects content hash and revision hash mismatches", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await saveHarnessState({ memory: "memory" }, destination, null, INITIAL_HARNESS_VERSION_METADATA);
		await writeFile(join(destination, "EVOLVE.md"), "changed");
		await expect(loadHarnessState(destination)).rejects.toThrow(/content hash mismatch/i);

		const manifestPath = join(destination, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as HarnessVersionManifest;
		await writeFile(join(destination, "EVOLVE.md"), "memory");
		await writeFile(manifestPath, JSON.stringify({ ...manifest, version: EXTERNAL_VERSION }));
		await expect(loadHarnessState(destination)).rejects.toThrow(/version hash mismatch/i);
	});

	test.each([
		["malformed UTF-8", new Uint8Array([0xc3, 0x28]), /UTF-8/i],
		["BOM", new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), /BOM/i],
		["whitespace-only", new TextEncoder().encode(" \t\n"), /evolution memory/i],
	] as const)("rejects %s EVOLVE bytes", async (_label, bytes, expected) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const manifest = createManifest([createArtifact(bytes)]);
		await writeRawBundle(destination, manifest, { "EVOLVE.md": bytes });
		await expect(loadHarnessState(destination)).rejects.toThrow(expected);
	});

	test("rejects malformed, BOM-prefixed, and non-strict manifests", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await mkdir(destination);
		await writeFile(join(destination, "EVOLVE.md"), "memory");
		await writeFile(join(destination, "manifest.json"), "{not-json}");
		await expect(loadHarnessState(destination)).rejects.toThrow(/invalid JSON/i);
		await writeFile(join(destination, "manifest.json"), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
		await expect(loadHarnessState(destination)).rejects.toThrow(/BOM/i);
		await writeFile(
			join(destination, "manifest.json"),
			JSON.stringify({ ...createManifest([createArtifact("memory")]), extra: true }),
		);
		await expect(loadHarnessState(destination)).rejects.toThrow(/invalid harness version manifest/i);
	});

	test("rejects prior manifest schema versions", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const manifest = createManifest([createArtifact("memory")]);
		await mkdir(destination);
		await writeFile(join(destination, "manifest.json"), JSON.stringify({ ...manifest, schemaVersion: 1 }));
		await writeFile(join(destination, "EVOLVE.md"), "memory");

		await expect(loadHarnessState(destination)).rejects.toThrow(/invalid harness version manifest/i);
	});
});

describe("HarnessStateStore", () => {
	test("initializes and selects a portable empty root idempotently", async () => {
		const agentDir = await createTemporaryRoot();
		const stores = Array.from({ length: 8 }, () => new HarnessStateStore(agentDir));
		const roots = await Promise.all(stores.map((store) => store.initialize()));
		const root = roots[0]!;
		const versionDirectory = harnessVersionDirectoryName(root.manifest.version);

		expect(roots.every((candidate) => candidate.manifest.version === root.manifest.version)).toBe(true);
		expect(root.state.memory).toBe("");
		expect(root.manifest.base).toBeNull();
		expect(root.manifest.metadata).toEqual(INITIAL_HARNESS_VERSION_METADATA);
		expect(root.manifest.artifacts[0]?.contentHash).toBe(
			"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(versionDirectory).toMatch(/^sha256-[0-9a-f]{64}$/);
		expect(await readdir(join(agentDir, "harness-state", "versions"))).toEqual([versionDirectory]);
		expect(JSON.parse(await readFile(join(agentDir, "harness-state", "current.json"), "utf8"))).toEqual({
			version: root.manifest.version,
		});
		expect(await stores[0]!.loadCurrent()).toEqual(root);
	});

	test("advances lineage, including identical content, and reports stale-base conflicts", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const first = await store.advance({ memory: "learned" }, root.manifest.version);
		expect(first.status).toBe("advanced");
		if (first.status !== "advanced") throw new Error("Expected first advance to succeed");
		expect(first.bundle.manifest.base).toBe(root.manifest.version);

		const second = await store.advance({ memory: "learned" }, first.bundle.manifest.version);
		expect(second.status).toBe("advanced");
		if (second.status !== "advanced") throw new Error("Expected second advance to succeed");
		expect(second.bundle.manifest.version).not.toBe(first.bundle.manifest.version);
		expect(second.bundle.manifest.base).toBe(first.bundle.manifest.version);

		expect(await store.advance({ memory: "stale" }, root.manifest.version)).toEqual({
			status: "conflict",
			expectedBase: root.manifest.version,
			actualBase: second.bundle.manifest.version,
		});
		expect((await store.loadCurrent()).manifest.version).toBe(second.bundle.manifest.version);
	});

	test("inherits evolved skills across memory-only revisions and clears them only explicitly", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const content = skillContent("inherited-skill");
		const withSkill = await store.advance(
			{
				memory: "First memory.",
				skills: [
					{
						path: "skills/inherited-skill/SKILL.md",
						content,
						workspace: WORKSPACE,
						files: [{ path: "references/details.md", content: "Inherited reference.\n" }],
					},
				],
			},
			root.manifest.version,
		);
		if (withSkill.status !== "advanced") throw new Error("Expected skill advance to succeed");

		const inherited = await store.advance({ memory: "Second memory." }, withSkill.bundle.manifest.version);
		if (inherited.status !== "advanced") throw new Error("Expected inherited advance to succeed");
		expect(inherited.bundle.state.skills).toHaveLength(1);
		expect(inherited.bundle.state.skills[0]?.content).toBe(content);
		expect(inherited.bundle.state.skills[0]?.files).toMatchObject([
			{ path: "references/details.md", content: "Inherited reference.\n" },
		]);
		expect(inherited.bundle.manifest.artifacts.some((artifact) => artifact.kind === "skill")).toBe(true);
		expect(inherited.bundle.manifest.artifacts.some((artifact) => artifact.kind === "skill-file")).toBe(true);

		const cleared = await store.advance({ memory: "Third memory.", skills: [] }, inherited.bundle.manifest.version);
		if (cleared.status !== "advanced") throw new Error("Expected cleared advance to succeed");
		expect(cleared.bundle.state.skills).toEqual([]);
	});

	test("inherits durable harness metadata across ordinary advances", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const first = await store.advance(
			{ memory: "Lesson 6: Existing lesson.\n" },
			root.manifest.version,
			LESSON_METADATA,
		);
		if (first.status !== "advanced") throw new Error("Expected metadata advance to succeed");
		const second = await store.advance({ memory: "Updated memory." }, first.bundle.manifest.version);
		if (second.status !== "advanced") throw new Error("Expected inherited metadata advance to succeed");

		expect(first.bundle.manifest.metadata).toEqual(LESSON_METADATA);
		expect(second.bundle.manifest.metadata).toEqual(LESSON_METADATA);
	});

	test("allows lesson metadata to decrease when lessons are removed", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const first = await store.advance({ memory: "Current memory." }, root.manifest.version, LESSON_METADATA);
		if (first.status !== "advanced") throw new Error("Expected metadata advance to succeed");

		const second = await store.advance({ memory: "Compacted successor." }, first.bundle.manifest.version, {
			evolutionMemory: { nextLessonNumber: 6 },
		});
		if (second.status !== "advanced") throw new Error("Expected compacted metadata advance to succeed");

		expect(second.bundle.manifest.metadata).toEqual({
			evolutionMemory: { nextLessonNumber: 6 },
		});
		expect(await store.loadCurrent()).toEqual(second.bundle);
	});

	test("serializes concurrent advances so exactly one succeeds", async () => {
		const agentDir = await createTemporaryRoot();
		const firstStore = new HarnessStateStore(agentDir);
		const secondStore = new HarnessStateStore(agentDir);
		const root = await firstStore.initialize();
		const results = await Promise.all([
			firstStore.advance({ memory: "first" }, root.manifest.version),
			secondStore.advance({ memory: "second" }, root.manifest.version),
		]);
		expect(results.filter((result) => result.status === "advanced")).toHaveLength(1);
		expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
	});

	test("recovers a stale lock whose owner is no longer valid", async () => {
		const agentDir = await createTemporaryRoot();
		const lockPath = join(agentDir, ".harness-state.lock");
		await mkdir(lockPath);
		const staleTime = new Date(Date.now() - 60_000);
		await utimes(lockPath, staleTime, staleTime);

		await expect(new HarnessStateStore(agentDir).initialize()).resolves.toMatchObject({ state: { memory: "" } });
		expect(await pathExists(lockPath)).toBe(false);
	});

	test("saves without selecting and atomically switches a validated revision", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const branch = await store.saveVersion({ memory: "branch" }, root.manifest.version);
		expect((await store.loadCurrent()).manifest.version).toBe(root.manifest.version);
		expect(await store.loadVersion(branch.manifest.version)).toEqual(branch);

		expect(await store.selectVersion(branch.manifest.version)).toEqual(branch);
		expect((await store.loadCurrent()).manifest.version).toBe(branch.manifest.version);
		expect((await readdir(join(agentDir, "harness-state"))).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	test("selects a rollback target only from the expected current revision", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const first = await store.advance({ memory: "first" }, root.manifest.version);
		if (first.status !== "advanced") throw new Error("Expected first advance to succeed");
		const second = await store.advance({ memory: "second" }, first.bundle.manifest.version);
		if (second.status !== "advanced") throw new Error("Expected second advance to succeed");

		expect(await store.selectVersionIfCurrent(first.bundle.manifest.version, root.manifest.version)).toEqual({
			status: "conflict",
			expectedCurrent: root.manifest.version,
			actualCurrent: second.bundle.manifest.version,
		});
		expect(await store.selectVersionIfCurrent(first.bundle.manifest.version, second.bundle.manifest.version)).toEqual(
			{ status: "selected", bundle: first.bundle },
		);
		expect(await store.loadCurrent()).toEqual(first.bundle);
	});

	test("leaves invalid current state untouched", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		await store.initialize();
		const pointerPath = join(agentDir, "harness-state", "current.json");
		await writeFile(pointerPath, '{"version":"sha256:missing","extra":true}\n');
		const before = await readFile(pointerPath);

		await expect(store.loadCurrent()).rejects.toThrow(/invalid harness version pointer/i);
		await expect(store.initialize()).rejects.toThrow(/invalid harness version pointer/i);
		expect(await readFile(pointerPath)).toEqual(before);
	});

	test("allows explicit selection to repair an invalid pointer", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const pointerPath = join(agentDir, "harness-state", "current.json");
		await writeFile(pointerPath, "not JSON\n");

		expect(await store.selectVersion(root.manifest.version)).toEqual(root);
		expect(await store.loadCurrent()).toEqual(root);
	});

	test("allows explicit selection to repair a directory at current.json", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const pointerPath = join(agentDir, "harness-state", "current.json");
		await rm(pointerPath);
		await mkdir(pointerPath);
		await writeFile(join(pointerPath, "invalid-entry"), "invalid pointer directory");

		expect(await store.selectVersion(root.manifest.version)).toEqual(root);
		expect(await store.loadCurrent()).toEqual(root);
	});

	test("rejects and preserves an incompatible selected bundle", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		await store.initialize();
		const artifact = createArtifact("future", "future-skill");
		const manifest = createManifest([artifact]);
		const bundlePath = join(agentDir, "harness-state", "versions", harnessVersionDirectoryName(manifest.version));
		await writeRawBundle(bundlePath, manifest, { "EVOLVE.md": "future" });
		const pointerPath = join(agentDir, "harness-state", "current.json");
		await writeFile(pointerPath, `${JSON.stringify({ version: manifest.version })}\n`);
		const before = await readFile(pointerPath);

		await expect(store.loadCurrent()).rejects.toThrow(/unsupported harness artifact kind/i);
		expect(await readFile(pointerPath)).toEqual(before);
	});

	test("lists compatible versions and per-path diagnostics deterministically", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const branch = await store.saveVersion({ memory: "branch" }, root.manifest.version);
		const versionsPath = join(agentDir, "harness-state", "versions");
		await mkdir(join(versionsPath, "not-a-version"));
		const corruptVersion = `sha256:${"f".repeat(64)}`;
		await mkdir(join(versionsPath, harnessVersionDirectoryName(corruptVersion)));

		const listed = await store.listVersions();
		expect(listed.versions.map((bundle) => bundle.manifest.version).sort()).toEqual(
			[root.manifest.version, branch.manifest.version].sort(),
		);
		expect(listed.diagnostics).toHaveLength(2);
		expect(listed.diagnostics.map((diagnostic) => diagnostic.version)).toContain(corruptVersion);
		expect(listed.diagnostics.map((diagnostic) => diagnostic.version)).toContain(null);
	});

	test("does not expose owned staging directories and diagnoses a missing selected version", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		await store.initialize();
		const versionsPath = join(agentDir, "harness-state", "versions");
		await mkdir(join(versionsPath, `.sha256-${"a".repeat(64)}.tmp-Ab12Cd`));
		await mkdir(join(versionsPath, `.sha256-${"c".repeat(64)}.tmp-persistent-corrupt`));
		const missingVersion = `sha256:${"b".repeat(64)}`;
		await writeFile(
			join(agentDir, "harness-state", "current.json"),
			`${JSON.stringify({ version: missingVersion })}\n`,
		);

		const listed = await store.listVersions();
		expect(listed.currentVersion).toBe(missingVersion);
		expect(listed.diagnostics).toHaveLength(2);
		expect(listed.diagnostics.some((diagnostic) => diagnostic.version === missingVersion)).toBe(true);
		expect(listed.diagnostics.some((diagnostic) => diagnostic.message.match(/does not exist/i))).toBe(true);
	});

	test("retains validated lineage and EVOLVE preview data for an incompatible revision", async () => {
		const agentDir = await createTemporaryRoot();
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const artifacts = [createArtifact("preview memory"), createArtifact("future data", "future-skill", "skill.txt")];
		const manifest = createManifest(artifacts, root.manifest.version);
		const bundlePath = join(agentDir, "harness-state", "versions", harnessVersionDirectoryName(manifest.version));
		await writeRawBundle(bundlePath, manifest, { "EVOLVE.md": "preview memory", "skill.txt": "future data" });

		const diagnostic = (await store.listVersions()).diagnostics.find((entry) => entry.version === manifest.version);
		expect(diagnostic).toMatchObject({
			manifest,
			state: { memory: "preview memory", skills: [] },
		});
		expect(diagnostic?.message).toMatch(/unsupported harness artifact kind/i);
	});
});
