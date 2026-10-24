import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTelemetryContext } from "@diffexai/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import {
	computeHarnessSkillPackageVersion,
	computeHarnessVersion,
	HARNESS_VERSION_SCHEMA_VERSION,
	HarnessStateStore,
	type HarnessVersion,
	type HarnessVersionBundle,
	type HarnessVersionMetadata,
	type HarnessWorkspaceIdentity,
	harnessVersionDirectoryName,
} from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { resolveHarnessWorkspace } from "../../src/core/harness-state-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { markFixedHarnessSubagentSession } from "../../src/core/subagents/session-runtime.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession harness revisions", () => {
	const harnesses: Harness[] = [];
	const agentDirs: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		while (agentDirs.length > 0) {
			const agentDir = agentDirs.pop();
			if (agentDir) rmSync(agentDir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	async function createVersionedHarness(): Promise<{
		harness: Harness;
		store: HarnessStateStore;
		rootVersion: HarnessVersion;
		telemetry: InMemoryTelemetryContext;
		agentDir: string;
	}> {
		const agentDir = join(tmpdir(), `diffex-harness-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		agentDirs.push(agentDir);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const telemetry = new InMemoryTelemetryContext();
		const harness = await createHarness({
			harnessStateStore: store,
			harnessVersionBundle: root,
			telemetryContext: telemetry,
		});
		harnesses.push(harness);
		return { harness, store, rootVersion: root.manifest.version, telemetry, agentDir };
	}

	async function createSkillRevisionChain() {
		const context = await createVersionedHarness();
		const { harness, store, rootVersion } = context;
		const { workspace } = await resolveHarnessWorkspace(harness.tempDir);
		const memory = "Lesson 1: Preserve the complete selected skill inventory.\n";
		const skills = ["alpha-review", "beta-review", "gamma-review"].map((name) => ({
			path: `skills/${name}/SKILL.md`,
			content: `---\nname: ${name}\ndescription: Original ${name} procedure.\n---\n\n# Original ${name}\n`,
			workspace,
		}));
		const one = await store.saveVersion({ memory, skills: skills.slice(0, 1) }, rootVersion);
		const two = await store.saveVersion({ memory, skills: skills.slice(0, 2) }, one.manifest.version);
		const three = await store.saveVersion({ memory, skills }, two.manifest.version);
		const updated = await store.saveVersion(
			{
				memory,
				skills: skills.map((skill) =>
					skill.path === "skills/alpha-review/SKILL.md"
						? { ...skill, content: skill.content.replaceAll("Original", "Updated") }
						: skill,
				),
			},
			three.manifest.version,
		);
		const revisions = [one, two, three, updated];
		expect(revisions.map((bundle) => bundle.state.skills.length)).toEqual([1, 2, 3, 3]);
		expect(new Set(revisions.map((bundle) => bundle.manifest.version)).size).toBe(4);
		for (const bundle of revisions) {
			expect(bundle.state.memory).toBe(memory);
			expect(bundle.manifest.metadata).toEqual(one.manifest.metadata);
			expect(bundle.manifest.artifacts.find((artifact) => artifact.kind === "evolution-memory")?.contentHash).toBe(
				contentHash(memory),
			);
		}
		return { ...context, one, two, three, updated, revisions };
	}

	function createGate() {
		let release: (() => void) | undefined;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { promise, resolve: () => release?.() };
	}

	function expectRevisionPrompt(prompt: string, bundle: HarnessVersionBundle): void {
		expect(prompt).toContain(
			`<evolution_memory version="${bundle.manifest.version}">\n${bundle.state.memory}\n</evolution_memory>`,
		);
		const catalogs = [...prompt.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)];
		expect(catalogs).toHaveLength(1);
		const entries = [...(catalogs[0]?.[1] ?? "").matchAll(/<skill>([\s\S]*?)<\/skill>/g)];
		expect(entries.map((entry) => entry[1]?.trim())).toEqual(
			bundle.state.skills.map(
				(skill) =>
					`<name>${skill.name}</name>\n    <description>${skill.description}</description>\n    <location>${skill.filePath}</location>`,
			),
		);
		for (const skill of bundle.state.skills) {
			expect(skill.filePath).toContain(
				join("harness-state", "versions", harnessVersionDirectoryName(bundle.manifest.version)),
			);
			expect(readFileSync(skill.filePath, "utf8")).toBe(skill.content);
		}
	}

	function contentHash(content: string): HarnessVersion {
		return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
	}

	function writeHarnessRevision(options: {
		agentDir: string;
		base: HarnessVersion;
		metadata: HarnessVersionMetadata;
		memory: string;
		skill: { name: string; content: string; workspace: HarnessWorkspaceIdentity };
	}): HarnessVersion {
		const skillPath = `skills/${options.skill.name}/SKILL.md`;
		const artifacts = [
			{ kind: "evolution-memory", path: "EVOLVE.md", contentHash: contentHash(options.memory) },
			{
				kind: "skill",
				path: skillPath,
				contentHash: contentHash(options.skill.content),
				workspace: options.skill.workspace,
			},
		];
		const version = computeHarnessVersion({
			schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
			base: options.base,
			metadata: options.metadata,
			artifacts,
		});
		const revisionPath = join(options.agentDir, "harness-state", "versions", harnessVersionDirectoryName(version));
		mkdirSync(join(revisionPath, "skills", options.skill.name), { recursive: true });
		writeFileSync(
			join(revisionPath, "manifest.json"),
			`${JSON.stringify(
				{
					schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
					version,
					base: options.base,
					metadata: options.metadata,
					artifacts,
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(join(revisionPath, "EVOLVE.md"), options.memory);
		writeFileSync(join(revisionPath, ...skillPath.split("/")), options.skill.content);
		return version;
	}

	it("applies an advanced EVOLVE revision only to requests after a live switch", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const providerPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("before switch");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("after switch");
			},
		]);

		await harness.session.prompt("first request");
		const advance = await store.advance({ memory: "Always mention the activated revision." }, rootVersion);
		expect(advance.status).toBe("advanced");
		if (advance.status !== "advanced") throw new Error("Expected harness advance to succeed");

		const historyBeforeSwitch = harness.session.messages.slice();
		await harness.session.switchHarnessVersion(advance.bundle.manifest.version);
		expect(harness.session.messages).toEqual(historyBeforeSwitch);
		expect(harness.session.activeHarnessVersion).toBe(advance.bundle.manifest.version);

		await harness.session.prompt("second request");

		expect(providerPrompts).toHaveLength(2);
		expect(providerPrompts[0]).not.toContain("<evolution_memory");
		expect(providerPrompts[1]).toContain(
			`<evolution_memory version="${advance.bundle.manifest.version}">\nAlways mention the activated revision.\n</evolution_memory>`,
		);
	});

	it("explicitly adopts memory and evolved skills from one selected revision", async () => {
		const { harness, store, rootVersion, telemetry } = await createVersionedHarness();
		const workspace = await resolveHarnessWorkspace(harness.tempDir);
		const skillContent =
			"---\nname: atomic-review\ndescription: Review the active harness atomically.\n---\n\n# Atomic review\n";
		const revision = await store.saveVersion(
			{
				memory: "Use the matching evolved skill revision.",
				skills: [
					{
						path: "skills/atomic-review/SKILL.md",
						content: skillContent,
						workspace: workspace.workspace,
					},
				],
			},
			rootVersion,
		);
		await store.selectVersion(revision.manifest.version);
		let providerPrompt = "";
		harness.setResponses([
			(context) => {
				providerPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("activated");
			},
		]);

		await harness.session.switchHarnessVersion(revision.manifest.version);
		await harness.session.prompt("observe the atomic revision");

		expect(harness.session.activeHarnessVersion).toBe(revision.manifest.version);
		expect(providerPrompt).toContain(
			`<evolution_memory version="${revision.manifest.version}">\nUse the matching evolved skill revision.\n</evolution_memory>`,
		);
		expect(providerPrompt).toContain("<name>atomic-review</name>");
		expect(providerPrompt).toContain(revision.state.skills[0]?.filePath);
		expect(harness.session.createSkillReferences()).toEqual([
			expect.objectContaining({
				name: "atomic-review",
				sourceKind: "evolved",
				harnessRevision: revision.manifest.version,
				version: revision.state.skills[0]?.packageVersion,
				contentDigest: revision.state.skills[0]?.contentHash,
			}),
		]);
		const promptOperation = telemetry
			.getSpans()
			.find(
				(span) =>
					span.name === "diffex.coding_agent.operation" && span.attributes["diffex.operation.kind"] === "prompt",
			);
		const availableEvent = promptOperation?.events.find(
			(event) =>
				event.name === "diffex.skill.available" && event.attributes["diffex.skill.source_kind"] === "evolved",
		);
		expect(availableEvent?.attributes).toMatchObject({
			"diffex.skill.version": revision.state.skills[0]?.packageVersion,
			"diffex.skill.content_digest": revision.state.skills[0]?.contentHash,
			"diffex.skill.source_kind": "evolved",
			"diffex.skill.scope": "workspace",
			"diffex.skill.harness_revision": revision.manifest.version,
			"diffex.harness.version": revision.manifest.version,
			"diffex.workspace.repository_id": workspace.workspace.repositoryId,
			"diffex.workspace.directory_id": workspace.workspace.directoryId,
		});

		await harness.session.switchHarnessVersion(rootVersion);
		expect(harness.session.systemPrompt).not.toContain("Use the matching evolved skill revision.");
		expect(harness.session.systemPrompt).not.toContain("<name>atomic-review</name>");
		expect(harness.session.createSkillReferences()).toEqual([]);
	});

	it("pins a manually assembled skill revision until explicitly restoring the prior catalog", async () => {
		const { harness, store, rootVersion, telemetry, agentDir } = await createVersionedHarness();
		const root = await store.loadVersion(rootVersion);
		const workspace = await resolveHarnessWorkspace(harness.tempDir);
		const skillContent =
			"---\nname: manual-review\ndescription: Trace the manually assembled review workflow.\n---\n\n# Manual review\n";
		const skillVersion = computeHarnessSkillPackageVersion({ content: skillContent });
		const revision = writeHarnessRevision({
			agentDir,
			base: rootVersion,
			metadata: root.manifest.metadata,
			memory: "Use the manually assembled harness revision.\n",
			skill: { name: "manual-review", content: skillContent, workspace: workspace.workspace },
		});
		const selected = await store.selectVersionIfCurrent(revision, rootVersion);
		expect(selected.status).toBe("selected");
		const providerPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("manual revision");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("still pinned revision");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("restored revision");
			},
		]);

		await harness.session.switchHarnessVersion(revision);
		await harness.session.prompt("trace the selected skill");

		expect(harness.session.activeHarnessVersion).toBe(revision);
		expect(providerPrompts[0]).toContain("Use the manually assembled harness revision.");
		expect(providerPrompts[0]).toContain("<name>manual-review</name>");
		const reference = harness.session.createSkillReferences()[0];
		expect(reference).toMatchObject({
			name: "manual-review",
			sourceKind: "evolved",
			harnessRevision: revision,
			version: skillVersion,
			contentDigest: contentHash(skillContent),
		});
		const firstPromptOperation = telemetry
			.getSpans()
			.find(
				(span) =>
					span.name === "diffex.coding_agent.operation" && span.attributes["diffex.operation.kind"] === "prompt",
			);
		expect(
			firstPromptOperation?.events.find(
				(event) =>
					event.name === "diffex.skill.available" && event.attributes["diffex.skill.source_kind"] === "evolved",
			)?.attributes,
		).toMatchObject({
			"diffex.skill.version": skillVersion,
			"diffex.skill.content_digest": contentHash(skillContent),
			"diffex.skill.harness_revision": revision,
			"diffex.harness.version": revision,
			"diffex.workspace.repository_id": workspace.workspace.repositoryId,
			"diffex.workspace.directory_id": workspace.workspace.directoryId,
		});

		const rolledBack = await store.selectVersionIfCurrent(rootVersion, revision);
		expect(rolledBack.status).toBe("selected");
		expect(harness.session.activeHarnessVersion).toBe(revision);

		await harness.session.prompt("observe the pinned catalog after background rollback");

		expect(harness.session.activeHarnessVersion).toBe(revision);
		expect(providerPrompts[1]).toContain("Use the manually assembled harness revision.");
		expect(providerPrompts[1]).toContain("<name>manual-review</name>");
		expect(harness.session.createSkillReferences()).toEqual([reference]);

		await harness.session.switchHarnessVersion(rootVersion);
		await harness.session.prompt("observe the explicitly restored catalog");

		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
		expect(providerPrompts[2]).not.toContain("Use the manually assembled harness revision.");
		expect(providerPrompts[2]).not.toContain("<name>manual-review</name>");
		expect(harness.session.createSkillReferences()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("selects complete skill-only descendants and restores exact ancestor catalogs in provider prompts", async () => {
		const { harness, store, one, two, three, updated, revisions } = await createSkillRevisionChain();
		const selections = [one, two, three, updated, one, two, updated];
		const providerPrompts: string[] = [];
		harness.setResponses(
			selections.map(() => (context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("selected revision observed");
			}),
		);

		for (const [index, selected] of selections.entries()) {
			// This is the selection API used by the interactive /version selector.
			await harness.session.switchHarnessVersion(selected.manifest.version);
			expect((await store.loadCurrent()).manifest.version).toBe(selected.manifest.version);
			await harness.session.prompt(`observe selection ${index}`);

			expect(providerPrompts).toHaveLength(index + 1);
			const prompt = providerPrompts[index] ?? "";
			expectRevisionPrompt(prompt, selected);
			for (const other of revisions.filter((bundle) => bundle !== selected)) {
				expect(prompt).not.toContain(harnessVersionDirectoryName(other.manifest.version));
			}
			expect(harness.session.createSkillReferences()).toEqual(
				selected.state.skills.map((skill) =>
					expect.objectContaining({
						name: skill.name,
						description: skill.description,
						sourceKind: "evolved",
						harnessRevision: selected.manifest.version,
						version: skill.packageVersion,
						contentDigest: skill.contentHash,
					}),
				),
			);
		}
		expect(updated.state.skills[0]?.packageVersion).not.toBe(three.state.skills[0]?.packageVersion);
		expect(updated.state.skills.slice(1).map((skill) => skill.packageVersion)).toEqual(
			three.state.skills.slice(1).map((skill) => skill.packageVersion),
		);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reselects the in-memory ancestor after the shared pointer advances to three skills", async () => {
		const { harness, store, one, three } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		const activeBundle = harness.session.harnessVersionBundle;
		const setEvolvedSkills = vi.spyOn(harness.session.resourceLoader, "setEvolvedSkills");
		await store.selectVersion(three.manifest.version);
		expect(harness.session.activeHarnessVersion).toBe(one.manifest.version);
		let providerPrompt = "";
		harness.setResponses([
			(context) => {
				providerPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("ancestor remains selected");
			},
		]);

		await harness.session.switchHarnessVersion(one.manifest.version);

		expect((await store.loadCurrent()).manifest.version).toBe(one.manifest.version);
		expect(harness.session.harnessVersionBundle).toBe(activeBundle);
		expect(setEvolvedSkills).not.toHaveBeenCalled();
		await harness.session.prompt("observe the explicitly reselected ancestor");
		expectRevisionPrompt(providerPrompt, one);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not reactivate or rewrite an already active and selected revision", async () => {
		const { harness, store, one } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		const activeBundle = harness.session.harnessVersionBundle;
		const selectVersion = vi.spyOn(store, "selectVersion");
		const setEvolvedSkills = vi.spyOn(harness.session.resourceLoader, "setEvolvedSkills");

		await harness.session.switchHarnessVersion(one.manifest.version);

		expect(selectVersion).not.toHaveBeenCalled();
		expect(setEvolvedSkills).not.toHaveBeenCalled();
		expect(harness.session.harnessVersionBundle).toBe(activeBundle);
	});

	it.each([
		{ property: "isStreaming", message: "while a response is streaming" },
		{ property: "isCompacting", message: "while compaction is in progress" },
		{ property: "isBashRunning", message: "while a bash command is running" },
	] as const)("rejects stale same-version reselection while $property", async ({ property, message }) => {
		const { harness, store, one, three } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		await store.selectVersion(three.manifest.version);
		vi.spyOn(harness.session, property, "get").mockReturnValue(true);

		await expect(harness.session.switchHarnessVersion(one.manifest.version)).rejects.toThrow(message);
		expect((await store.loadCurrent()).manifest.version).toBe(three.manifest.version);
		expect(harness.session.activeHarnessVersion).toBe(one.manifest.version);
	});

	it("blocks prompt admission while checking a same-version reselection", async () => {
		const { harness, store, one, three } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		await store.selectVersion(three.manifest.version);
		const listing = await store.listVersions();
		const started = createGate();
		const release = createGate();
		vi.spyOn(store, "listVersions").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			return listing;
		});

		const switching = harness.session.switchHarnessVersion(one.manifest.version);
		try {
			await started.promise;
			await expect(harness.session.prompt("must not observe the descendant")).rejects.toThrow(
				"Cannot submit a prompt while a harness version switch is in progress.",
			);
			await expect(harness.session.switchHarnessVersion(three.manifest.version)).rejects.toThrow(
				"Cannot switch harness versions while another switch is in progress.",
			);
		} finally {
			release.resolve();
			await switching;
		}
		expect((await store.loadCurrent()).manifest.version).toBe(one.manifest.version);
	});

	it("pins tool continuations and later idle requests across a skill-only selection change", async () => {
		const { harness, store, one, updated } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		const [skill] = one.state.skills;
		if (!skill) throw new Error("Expected the ancestor skill");
		const started = createGate();
		const release = createGate();
		const providerPrompts: string[] = [];
		let readResult = "";
		harness.setResponses([
			async (context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				started.resolve();
				await release.promise;
				return fauxAssistantMessage(fauxToolCall("read", { path: skill.filePath }), { stopReason: "toolUse" });
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				readResult = getMessageText(context.messages.find((message) => message.role === "toolResult"));
				return fauxAssistantMessage("original request finished");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("fresh request finished");
			},
		]);

		const inFlight = harness.session.prompt("read the ancestor skill");
		try {
			await started.promise;
			// Another session can change the shared selection while this session is streaming.
			await store.selectVersion(updated.manifest.version);
			expect(harness.session.activeHarnessVersion).toBe(one.manifest.version);
		} finally {
			release.resolve();
			await inFlight;
		}
		await harness.session.prompt("observe the pinned selection on a later idle request");

		expect(providerPrompts).toHaveLength(3);
		expectRevisionPrompt(providerPrompts[0] ?? "", one);
		expectRevisionPrompt(providerPrompts[1] ?? "", one);
		expect(readResult).toContain("# Original alpha-review");
		expectRevisionPrompt(providerPrompts[2] ?? "", one);
		expect(harness.session.activeHarnessVersion).toBe(one.manifest.version);
		expect((await store.loadCurrent()).manifest.version).toBe(updated.manifest.version);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["steer", "followUp"] as const)(
		"pins an admitted %s request's complete catalog and explicit skill across a skill-only selection change",
		async (streamingBehavior) => {
			const { harness, store, one, updated } = await createSkillRevisionChain();
			await harness.session.switchHarnessVersion(one.manifest.version);
			const [reference] = harness.session.createSkillReferences();
			if (!reference) throw new Error("Expected the ancestor skill reference");
			const started = createGate();
			const release = createGate();
			const providerPrompts: string[] = [];
			const userMessages: string[] = [];
			harness.setResponses([
				async (context) => {
					providerPrompts.push(context.systemPrompt ?? "");
					started.resolve();
					await release.promise;
					return fauxAssistantMessage("original request finished");
				},
				(context) => {
					providerPrompts.push(context.systemPrompt ?? "");
					userMessages.push(getMessageText(context.messages.filter((message) => message.role === "user").at(-1)));
					return fauxAssistantMessage("queued request finished");
				},
				(context) => {
					providerPrompts.push(context.systemPrompt ?? "");
					userMessages.push(getMessageText(context.messages.filter((message) => message.role === "user").at(-1)));
					return fauxAssistantMessage("fresh request finished");
				},
			]);

			const inFlight = harness.session.prompt("start with the ancestor");
			try {
				await started.promise;
				await harness.session.prompt(`${reference.reference}\n\nqueued review`, { streamingBehavior });
				expect(harness.session.pendingMessageCount).toBe(1);
				await store.selectVersion(updated.manifest.version);
				expect(harness.session.activeHarnessVersion).toBe(one.manifest.version);
			} finally {
				release.resolve();
				await inFlight;
			}
			expect(harness.session.pendingMessageCount).toBe(0);
			await harness.session.prompt("fresh review");

			expect(providerPrompts).toHaveLength(3);
			expectRevisionPrompt(providerPrompts[0] ?? "", one);
			expectRevisionPrompt(providerPrompts[1] ?? "", one);
			expect(userMessages[0]).toContain("queued review");
			expect(userMessages[0]).toContain("# Original alpha-review");
			expect(userMessages[0]).toContain(`version="${reference.version}"`);
			expect(userMessages[0]).toContain(`harness-revision="${one.manifest.version}"`);
			expect(userMessages[0]).not.toContain("Updated");
			expectRevisionPrompt(providerPrompts[2] ?? "", one);
			expect(userMessages[1]).toBe("fresh review");
			expect(harness.session.activeHarnessVersion).toBe(one.manifest.version);
			expect((await store.loadCurrent()).manifest.version).toBe(updated.manifest.version);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("rejects an evolved reference after explicitly switching the active harness", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const workspace = await resolveHarnessWorkspace(harness.tempDir);
		const first = await store.saveVersion(
			{
				memory: "First revision.",
				skills: [
					{
						path: "skills/versioned-review/SKILL.md",
						content: "---\nname: versioned-review\ndescription: Use the first review revision.\n---\n\n# First\n",
						workspace: workspace.workspace,
					},
				],
			},
			rootVersion,
		);
		await harness.session.switchHarnessVersion(first.manifest.version);
		const reference = harness.session.createSkillReferences()[0];
		if (reference === undefined) throw new Error("Expected an evolved skill reference");
		const second = await store.saveVersion(
			{
				memory: "Second revision.",
				skills: [
					{
						path: "skills/versioned-review/SKILL.md",
						content:
							"---\nname: versioned-review\ndescription: Use the second review revision.\n---\n\n# Second\n",
						workspace: workspace.workspace,
					},
				],
			},
			first.manifest.version,
		);
		await store.selectVersion(second.manifest.version);
		await harness.session.switchHarnessVersion(second.manifest.version);

		await expect(harness.session.prompt(`${reference.reference}\n\nreview this`)).rejects.toThrow(
			"is not part of the active harness revision",
		);
		expect(harness.session.activeHarnessVersion).toBe(second.manifest.version);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("switches repeatedly between valid revisions", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const branch = await store.saveVersion({ memory: "Use the alternate harness." }, rootVersion);

		await harness.session.switchHarnessVersion(branch.manifest.version);
		expect(harness.session.activeHarnessVersion).toBe(branch.manifest.version);
		expect((await store.loadCurrent()).manifest.version).toBe(branch.manifest.version);

		await harness.session.switchHarnessVersion(rootVersion);
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
		expect((await store.loadCurrent()).manifest.version).toBe(rootVersion);
	});

	it("keeps idle prompt admission pinned when the selected harness advances", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const providerPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("before activation");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("after activation");
			},
		]);

		await harness.session.prompt("first request");
		const advance = await store.advance({ memory: "Use the newly selected memory." }, rootVersion);
		expect(advance.status).toBe("advanced");
		if (advance.status !== "advanced") throw new Error("Expected harness advance to succeed");

		await harness.session.prompt("second request");

		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
		expect(providerPrompts).toHaveLength(2);
		expect(providerPrompts[0]).not.toContain("<evolution_memory");
		expect(providerPrompts[1]).not.toContain("<evolution_memory");
		expect((await store.loadCurrent()).manifest.version).toBe(advance.bundle.manifest.version);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reconciles the selected harness before regular construction while preserving pinned and fixed bundles", async () => {
		const { harness, store, rootVersion, agentDir } = await createVersionedHarness();
		const successor = await store.saveVersion({ memory: "Use the construction selection." }, rootVersion);
		await store.selectVersion(successor.manifest.version);
		const createSession = async (options: { pinHarnessVersion?: boolean; fixed?: boolean } = {}) => {
			const services = await createAgentSessionServices({
				cwd: harness.tempDir,
				agentDir,
				harnessStateStore: store,
				harnessVersionBundle: await store.loadVersion(rootVersion),
			});
			const sessionManager = SessionManager.inMemory();
			if (options.fixed) markFixedHarnessSubagentSession(sessionManager);
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				subagents: false,
				pinHarnessVersion: options.pinHarnessVersion,
			});
			return created.session;
		};

		const regular = await createSession();
		const pinned = await createSession({ pinHarnessVersion: true });
		const fixed = await createSession({ fixed: true });
		try {
			expect(regular.activeHarnessVersion).toBe(successor.manifest.version);
			expect(pinned.activeHarnessVersion).toBe(rootVersion);
			expect(fixed.activeHarnessVersion).toBe(rootVersion);
		} finally {
			await Promise.all([regular.dispose(), pinned.dispose(), fixed.dispose()]);
		}
	});

	it("adopts the selected revision in a fresh /clear-equivalent session from the same cwd services", async () => {
		const { harness, store, rootVersion, agentDir, one, updated } = await createSkillRevisionChain();
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
			harnessStateStore: store,
			harnessVersionBundle: await store.loadVersion(rootVersion),
		});
		await store.selectVersion(one.manifest.version);
		const providerPrompts: string[] = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("observed session revision");
			}),
		);
		const original = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model: harness.getModel(),
			subagents: false,
		});
		// Isolate session lifecycle requests from the SDK's private scoring continuations.
		original.session.agent.preparePrivateContinuation = undefined;
		try {
			await original.session.prompt("before background selection");
			await store.selectVersion(updated.manifest.version);
			await original.session.prompt("remain pinned before clear");

			expect(original.session.activeHarnessVersion).toBe(one.manifest.version);
			expect(original.session.messages.length).toBeGreaterThan(0);
			expectRevisionPrompt(providerPrompts[0] ?? "", one);
			expectRevisionPrompt(providerPrompts[1] ?? "", one);
		} finally {
			await original.session.dispose();
		}

		// /clear replaces the session with a new SessionManager in the same cwd.
		const cleared = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			sessionStartEvent: { type: "session_start", reason: "new" },
			model: harness.getModel(),
			subagents: false,
		});
		cleared.session.agent.preparePrivateContinuation = undefined;
		try {
			expect(cleared.session.activeHarnessVersion).toBe(updated.manifest.version);
			expect(cleared.session.messages).toEqual([]);
			await cleared.session.prompt("observe the selected revision after clear");

			expectRevisionPrompt(providerPrompts[2] ?? "", updated);
			expect(cleared.session.createSkillReferences()).toEqual(
				updated.state.skills.map((skill) =>
					expect.objectContaining({ name: skill.name, harnessRevision: updated.manifest.version }),
				),
			);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await cleared.session.dispose();
		}
	});

	it("falls back to the built-in harness when selected state cannot be read during construction", async () => {
		const { harness, store, rootVersion, agentDir } = await createVersionedHarness();
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir,
			harnessStateStore: store,
			harnessVersionBundle: await store.loadVersion(rootVersion),
		});
		vi.spyOn(store, "loadCurrent").mockRejectedValueOnce(new Error("selected state is unavailable"));
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			subagents: false,
		});
		try {
			expect(created.session.activeHarnessVersion).toBeUndefined();
			expect(created.harnessStateWarning).toBe(
				"Harness state could not be activated: selected state is unavailable. Continuing with the built-in harness.",
			);
		} finally {
			await created.session.dispose();
		}
	});

	it("keeps the active memory and complete skill catalog pinned after an idle reload", async () => {
		const { harness, store, one, updated } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		const activeBundle = harness.session.harnessVersionBundle;
		const references = harness.session.createSkillReferences();
		await store.selectVersion(updated.manifest.version);

		await harness.session.reload();

		expect(harness.session.harnessVersionBundle).toBe(activeBundle);
		expectRevisionPrompt(harness.session.systemPrompt, one);
		expect(harness.session.createSkillReferences()).toEqual(references);
		expect((await store.loadCurrent()).manifest.version).toBe(updated.manifest.version);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reloads without reading a selected revision that is unavailable", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const successor = await store.saveVersion({ memory: "Do not activate during reload." }, rootVersion);
		await store.selectVersion(successor.manifest.version);
		const loadCurrent = vi.spyOn(store, "loadCurrent").mockRejectedValue(new Error("selection read failed"));

		await expect(harness.session.reload()).resolves.toBeUndefined();

		expect(loadCurrent).not.toHaveBeenCalled();
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
		expect(harness.session.systemPrompt).not.toContain("Do not activate during reload.");
	});

	it("retains the active harness when resource reload fails", async () => {
		const { harness, store, one, updated } = await createSkillRevisionChain();
		await harness.session.switchHarnessVersion(one.manifest.version);
		const activeBundle = harness.session.harnessVersionBundle;
		await store.selectVersion(updated.manifest.version);
		vi.spyOn(harness.session.resourceLoader, "reload").mockRejectedValueOnce(new Error("resource reload failed"));

		await expect(harness.session.reload()).rejects.toThrow("resource reload failed");

		expect(harness.session.harnessVersionBundle).toBe(activeBundle);
		expectRevisionPrompt(harness.session.systemPrompt, one);
	});

	it("rejects reload before rebuilding runtime while work is active", async () => {
		const { harness } = await createVersionedHarness();
		const sessionInternals = harness.session as unknown as { _buildRuntime: () => void };
		const rebuild = vi.spyOn(sessionInternals, "_buildRuntime");
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);

		await expect(harness.session.reload()).rejects.toThrow("Cannot reload while the session is busy.");

		expect(rebuild).not.toHaveBeenCalled();
	});

	it("rejects reload before rebuilding runtime while a continuation is queued", async () => {
		const { harness } = await createVersionedHarness();
		const sessionInternals = harness.session as unknown as { _buildRuntime: () => void };
		const rebuild = vi.spyOn(sessionInternals, "_buildRuntime");
		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued continuation" }],
			display: false,
			timestamp: Date.now(),
		});

		await expect(harness.session.reload()).rejects.toThrow("Cannot reload while the session is busy.");

		expect(rebuild).not.toHaveBeenCalled();
	});

	it("keeps in-flight and later requests pinned until an explicit switch", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const providerPrompts: string[] = [];
		let signalFirstStarted: (() => void) | undefined;
		let resolveFirst: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;
		const firstStarted = new Promise<void>((resolveStarted) => {
			signalFirstStarted = resolveStarted;
		});
		const firstResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolveResponse) => {
			resolveFirst = resolveResponse;
		});
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				signalFirstStarted?.();
				return firstResponse;
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("still pinned");
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("after explicit activation");
			},
		]);

		const inFlight = harness.session.prompt("request admitted before activation");
		await firstStarted;
		const workspace = await resolveHarnessWorkspace(harness.tempDir);
		const advance = await store.advance(
			{
				memory: "Use memory selected during the request.",
				skills: [
					{
						path: "skills/later-review/SKILL.md",
						content:
							"---\nname: later-review\ndescription: Review only after activation.\n---\n\n# Later review\n",
						workspace: workspace.workspace,
					},
				],
			},
			rootVersion,
		);
		expect(advance.status).toBe("advanced");
		if (advance.status !== "advanced") throw new Error("Expected harness advance to succeed");
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
		resolveFirst?.(fauxAssistantMessage("before activation"));
		await inFlight;

		await harness.session.prompt("request admitted after background selection");

		expect(providerPrompts[0]).not.toContain("Use memory selected during the request.");
		expect(providerPrompts[0]).not.toContain("<name>later-review</name>");
		expect(providerPrompts[1]).not.toContain("Use memory selected during the request.");
		expect(providerPrompts[1]).not.toContain("<name>later-review</name>");
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);

		await harness.session.switchHarnessVersion(advance.bundle.manifest.version);
		await harness.session.prompt("request admitted after explicit activation");

		expect(providerPrompts).toHaveLength(3);
		expect(providerPrompts[2]).toContain("Use memory selected during the request.");
		expect(providerPrompts[2]).toContain("<name>later-review</name>");
		expect(harness.session.activeHarnessVersion).toBe(advance.bundle.manifest.version);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reports explicit activation, but not background selection, to the process lifecycle observer", async () => {
		const activatedVersions: HarnessVersion[] = [];
		const agentDir = join(tmpdir(), `diffex-harness-observer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		agentDirs.push(agentDir);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const harness = await createHarness({
			harnessStateStore: store,
			harnessVersionBundle: root,
			lifecycleObserver: {
				operationSettled: () => {},
				harnessActivated: (version) => {
					activatedVersions.push(version);
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("observed")]);
		const successor = await store.advance({ memory: "Observed memory." }, root.manifest.version);
		expect(successor.status).toBe("advanced");
		if (successor.status !== "advanced") throw new Error("Expected harness advance to succeed");

		await harness.session.prompt("observe the pinned harness");

		expect(activatedVersions).toEqual([]);
		expect(harness.session.activeHarnessVersion).toBe(root.manifest.version);

		await harness.session.switchHarnessVersion(successor.bundle.manifest.version);

		expect(activatedVersions).toEqual([successor.bundle.manifest.version]);
	});

	it.each([
		{ property: "isStreaming", message: "while a response is streaming" },
		{ property: "isCompacting", message: "while compaction is in progress" },
		{ property: "isBashRunning", message: "while a bash command is running" },
	] as const)("rejects switching $property when an operation is active", async ({ property, message }) => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const successor = await store.saveVersion({ memory: "New memory." }, rootVersion);
		vi.spyOn(harness.session, property, "get").mockReturnValue(true);

		await expect(harness.session.switchHarnessVersion(successor.manifest.version)).rejects.toThrow(message);
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
	});

	it("treats selecting the active revision as a no-op during an active operation", async () => {
		const { harness, rootVersion } = await createVersionedHarness();
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);

		await expect(harness.session.switchHarnessVersion(rootVersion)).resolves.toBeUndefined();
	});

	it("rejects prompts while a harness switch is in progress", async () => {
		const { harness, store, rootVersion } = await createVersionedHarness();
		const successor = await store.saveVersion({ memory: "New memory." }, rootVersion);
		const listing = await store.listVersions();
		let releaseListing: (() => void) | undefined;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		vi.spyOn(store, "listVersions").mockImplementation(async () => {
			await listingGate;
			return listing;
		});

		const switching = harness.session.switchHarnessVersion(successor.manifest.version);
		await vi.waitFor(() => expect(store.listVersions).toHaveBeenCalledOnce());
		await expect(harness.session.prompt("racing request")).rejects.toThrow(
			"Cannot submit a prompt while a harness version switch is in progress.",
		);

		releaseListing?.();
		await switching;
	});

	it("reports an unavailable revision without changing the active bundle", async () => {
		const { harness, rootVersion } = await createVersionedHarness();
		const missingVersion = `sha256:${"f".repeat(64)}` as HarnessVersion;

		await expect(harness.session.switchHarnessVersion(missingVersion)).rejects.toThrow(
			`Harness version ${missingVersion} was not found.`,
		);
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
	});
});
