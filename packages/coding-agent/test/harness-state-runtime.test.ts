import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeHarnessVersion,
	HARNESS_VERSION_SCHEMA_VERSION,
	HarnessStateStore,
	type HarnessWorkspaceIdentity,
	harnessVersionDirectoryName,
	harnessWorkspaceSelectionFileName,
} from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadWorkspaceHarnessState,
	resolveEvolutionWorkspaceStateDirectory,
	resolveHarnessWorkspace,
} from "../src/core/harness-state-runtime.ts";

const WORKSPACE: HarnessWorkspaceIdentity = { repositoryId: "global", directoryId: "workspace-a" };

function createStore(agentDir: string): HarnessStateStore {
	return new HarnessStateStore(agentDir, { workspace: WORKSPACE });
}

function pointerPath(agentDir: string): string {
	return join(agentDir, "harness-state", "selections", harnessWorkspaceSelectionFileName(WORKSPACE));
}

function loadHarnessState(agentDir: string) {
	return loadWorkspaceHarnessState(agentDir, WORKSPACE);
}

describe("workspace harness state startup", () => {
	const agentDirs: string[] = [];

	afterEach(() => {
		while (agentDirs.length > 0) {
			const agentDir = agentDirs.pop();
			if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		}
	});

	function createAgentDir(): string {
		const agentDir = join(tmpdir(), `diffex-harness-startup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		agentDirs.push(agentDir);
		return agentDir;
	}

	function contentHash(content: string): string {
		return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
	}

	it("derives shared evolution state for the same workspace and isolates different workspaces", async () => {
		const agentDir = createAgentDir();
		const workspaceAPath = join(agentDir, "workspace-a");
		const workspaceBPath = join(agentDir, "workspace-b");
		mkdirSync(workspaceAPath);
		mkdirSync(workspaceBPath);
		const firstWorkspaceA = await resolveHarnessWorkspace(workspaceAPath);
		const secondWorkspaceA = await resolveHarnessWorkspace(workspaceAPath);
		const workspaceB = await resolveHarnessWorkspace(workspaceBPath);

		expect(resolveEvolutionWorkspaceStateDirectory(agentDir, firstWorkspaceA.workspace)).toBe(
			resolveEvolutionWorkspaceStateDirectory(agentDir, secondWorkspaceA.workspace),
		);
		expect(resolveEvolutionWorkspaceStateDirectory(agentDir, firstWorkspaceA.workspace)).not.toBe(
			resolveEvolutionWorkspaceStateDirectory(agentDir, workspaceB.workspace),
		);
	});

	it("initializes and activates the empty root when its workspace selection is missing", async () => {
		const loaded = await loadHarnessState(createAgentDir());

		expect(loaded.warning).toBeUndefined();
		expect(loaded.bundle?.state.memory).toBe("");
		expect(loaded.bundle?.manifest.base).toBeNull();
	});

	it("loads the workspace-selected non-empty revision", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const root = await store.initialize();
		const advance = await store.advance({ memory: "Remember this revision." }, root.manifest.version);
		if (advance.status !== "advanced") throw new Error("Expected harness advance to succeed");

		const loaded = await loadHarnessState(agentDir);

		expect(loaded.warning).toBeUndefined();
		expect(loaded.bundle).toEqual(advance.bundle);
	});

	it("warns and falls back without rewriting a corrupt workspace selection", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		await store.initialize();
		const selectedPointerPath = pointerPath(agentDir);
		writeFileSync(selectedPointerPath, '{"version":"invalid"}\n');
		const corruptPointer = readFileSync(selectedPointerPath, "utf8");

		const loaded = await loadHarnessState(agentDir);

		expect(loaded.bundle).toBeUndefined();
		expect(loaded.warning).toContain("Continuing with the built-in harness.");
		expect(readFileSync(selectedPointerPath, "utf8")).toBe(corruptPointer);
	});

	it("warns and falls back when the selected revision is missing", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		await store.initialize();
		const selectedPointerPath = pointerPath(agentDir);
		const missingVersion = `sha256:${"f".repeat(64)}`;
		writeFileSync(selectedPointerPath, `${JSON.stringify({ version: missingVersion }, null, 2)}\n`);
		const missingPointer = readFileSync(selectedPointerPath, "utf8");

		const loaded = await loadHarnessState(agentDir);

		expect(loaded.bundle).toBeUndefined();
		expect(loaded.warning).toContain("Continuing with the built-in harness.");
		expect(readFileSync(selectedPointerPath, "utf8")).toBe(missingPointer);
	});

	it("warns and falls back when the selected bundle is corrupt", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const root = await store.initialize();
		const selectedPointerPath = pointerPath(agentDir);
		const memoryPath = join(
			agentDir,
			"harness-state",
			"versions",
			harnessVersionDirectoryName(root.manifest.version),
			"EVOLVE.md",
		);
		writeFileSync(memoryPath, "corrupt bytes");
		const selectedPointer = readFileSync(selectedPointerPath, "utf8");

		const loaded = await loadHarnessState(agentDir);

		expect(loaded.bundle).toBeUndefined();
		expect(loaded.warning).toContain("content hash mismatch");
		expect(readFileSync(selectedPointerPath, "utf8")).toBe(selectedPointer);
	});

	it("loads a selected revision with evolved skill artifacts", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const root = await store.initialize();
		const skill = "---\nname: future\ndescription: Use the future workflow.\n---\n\n# Future workflow\n";
		const selected = await store.saveVersion(
			{
				memory: "Skill-compatible memory.\n",
				skills: [
					{
						path: "skills/future/SKILL.md",
						content: skill,
						workspace: { repositoryId: "global", directoryId: "directory-1" },
					},
				],
			},
			root.manifest.version,
		);
		await store.selectVersion(selected.manifest.version);

		const loaded = await loadHarnessState(agentDir);

		expect(loaded.warning).toBeUndefined();
		expect(loaded.bundle).toEqual(selected);
		expect(loaded.bundle?.state.skills[0]?.content).toBe(skill);
	});

	it("warns and preserves the pointer for an unsupported future artifact", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const root = await store.initialize();
		const memory = "Future-compatible memory.\n";
		const future = "Future artifact.\n";
		const artifacts = [
			{ kind: "evolution-memory", path: "EVOLVE.md", contentHash: contentHash(memory) },
			{ kind: "future-skill-asset", path: "future.txt", contentHash: contentHash(future) },
		];
		const version = computeHarnessVersion({
			schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
			base: root.manifest.version,
			metadata: root.manifest.metadata,
			artifacts,
		});
		const bundlePath = join(agentDir, "harness-state", "versions", harnessVersionDirectoryName(version));
		mkdirSync(bundlePath, { recursive: true });
		writeFileSync(
			join(bundlePath, "manifest.json"),
			`${JSON.stringify(
				{
					schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
					version,
					base: root.manifest.version,
					metadata: root.manifest.metadata,
					artifacts,
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(join(bundlePath, "EVOLVE.md"), memory);
		writeFileSync(join(bundlePath, "future.txt"), future);
		const selectedPointerPath = pointerPath(agentDir);
		writeFileSync(selectedPointerPath, `${JSON.stringify({ version }, null, 2)}\n`);
		const incompatiblePointer = readFileSync(selectedPointerPath, "utf8");

		const loaded = await loadHarnessState(agentDir);

		expect(loaded.bundle).toBeUndefined();
		expect(loaded.warning).toContain('Unsupported harness artifact kind "future-skill-asset"');
		expect(readFileSync(selectedPointerPath, "utf8")).toBe(incompatiblePointer);
	});
});
