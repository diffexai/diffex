import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
	computeHarnessVersion,
	type HarnessArtifactManifest,
	HarnessArtifactManifestSchema,
	type HarnessState,
	HarnessStateSchema,
	HarnessStateStore,
	type HarnessVersion,
	type HarnessVersionBundle,
	HarnessVersionBundleSchema,
	type HarnessVersionManifest,
	HarnessVersionManifestSchema,
	HarnessVersionPointerSchema,
	harnessVersionDirectoryName,
	loadHarnessState,
	saveHarnessState,
	serializeHarnessVersion,
} from "../src/index.ts";

const temporaryRoots: string[] = [];
const EXTERNAL_VERSION = `sha256:${"0".repeat(64)}`;

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
): HarnessVersionManifest {
	return {
		schemaVersion: 1,
		version: computeHarnessVersion({ schemaVersion: 1, base, artifacts }),
		base,
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
		await writeFile(join(bundlePath, path), content);
	}
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
	artifact: HarnessArtifactManifest,
	manifest: HarnessVersionManifest,
	bundle: HarnessVersionBundle,
): void {
	// @ts-expect-error HarnessState fields are readonly.
	state.memory = "changed";
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
		const input = { schemaVersion: 1 as const, base: EXTERNAL_VERSION, artifacts: [first, second] };
		const canonical = serializeHarnessVersion(input);

		expect(canonical).toBe(JSON.stringify({ schemaVersion: 1, base: EXTERNAL_VERSION, artifacts: [second, first] }));
		expect(computeHarnessVersion(input)).toBe(hash(canonical));
		expect(computeHarnessVersion({ ...input, artifacts: [second, first] })).toBe(computeHarnessVersion(input));
	});

	test("changes independently for base, bytes, and artifact metadata", () => {
		const original = createArtifact("memory");
		const version = computeHarnessVersion({ schemaVersion: 1, base: null, artifacts: [original] });

		expect(computeHarnessVersion({ schemaVersion: 1, base: EXTERNAL_VERSION, artifacts: [original] })).not.toBe(
			version,
		);
		expect(computeHarnessVersion({ schemaVersion: 1, base: null, artifacts: [createArtifact("changed")] })).not.toBe(
			version,
		);
		expect(
			computeHarnessVersion({
				schemaVersion: 1,
				base: null,
				artifacts: [{ ...original, kind: "future-kind" }],
			}),
		).not.toBe(version);
		expect(
			computeHarnessVersion({
				schemaVersion: 1,
				base: null,
				artifacts: [{ ...original, path: "nested/EVOLVE.md" }],
			}),
		).not.toBe(version);
	});

	test("exports strict schemas", () => {
		const artifact = createArtifact("");
		const manifest = createManifest([artifact]);
		const bundle = { state: { memory: "" }, manifest };

		expect(Check(HarnessStateSchema, { memory: "" })).toBe(true);
		expect(Check(HarnessStateSchema, { memory: " \t\n" })).toBe(false);
		expect(Check(HarnessStateSchema, { memory: "\uFEFFmemory" })).toBe(false);
		expect(Check(HarnessStateSchema, { memory: "memory", extra: true })).toBe(false);
		expect(Check(HarnessArtifactManifestSchema, artifact)).toBe(true);
		expect(Check(HarnessArtifactManifestSchema, { ...artifact, extra: true })).toBe(false);
		expect(Check(HarnessVersionManifestSchema, manifest)).toBe(true);
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
		const saved = await saveHarnessState({ memory }, destination, EXTERNAL_VERSION);

		expect(await readFile(join(destination, "EVOLVE.md"), "utf8")).toBe(memory);
		expect(saved.manifest.base).toBe(EXTERNAL_VERSION);
		expect(saved.manifest.artifacts).toEqual([createArtifact(memory)]);
		expect(saved.manifest.version).toBe(computeHarnessVersion(saved.manifest));
		expect(await loadHarnessState(destination)).toEqual(saved);
	});

	test("is idempotent only for the same immutable revision", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const first = await saveHarnessState({ memory: "same" }, destination, null);
		const second = await saveHarnessState({ memory: "same" }, destination, null);
		expect(second).toEqual(first);

		await expect(saveHarnessState({ memory: "different" }, destination, null)).rejects.toThrow(/different content/i);
		expect((await loadHarnessState(destination)).state.memory).toBe("same");
	});

	test("cleans its staged directory after a destination race", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		const temporaryPrefix = `.${basename(destination)}.tmp-`;
		const saving = saveHarnessState({ memory: "x".repeat(16 * 1024 * 1024) }, destination, null).then(
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
		await expect(saveHarnessState({ memory }, destination, null)).rejects.toThrow(/invalid harness state/i);
		expect(await pathExists(destination)).toBe(false);
	});

	test("rejects an undeclared file and exact-casing mismatch", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await saveHarnessState({ memory: "memory" }, destination, null);
		await writeFile(join(destination, "extra.txt"), "extra");
		await expect(loadHarnessState(destination)).rejects.toThrow(/inventory mismatch.*undeclared/i);
		await rm(join(destination, "extra.txt"));
		await rename(join(destination, "EVOLVE.md"), join(destination, "evolve.md"));
		await expect(loadHarnessState(destination)).rejects.toThrow(/inventory mismatch/i);
	});

	test("rejects an undeclared empty directory", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "bundle");
		await saveHarnessState({ memory: "memory" }, destination, null);
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
		await saveHarnessState({ memory: "memory" }, destination, null);
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
		await saveHarnessState({ memory: "memory" }, destination, null);
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
			state: { memory: "preview memory" },
		});
		expect(diagnostic?.message).toMatch(/unsupported harness artifact kind/i);
	});
});
