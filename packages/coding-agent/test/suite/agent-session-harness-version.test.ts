import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTelemetryContext } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { HarnessStateStore, type HarnessVersion } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHarnessWorkspace } from "../../src/core/harness-state-runtime.ts";
import { createHarness, type Harness } from "./harness.ts";

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
		return { harness, store, rootVersion: root.manifest.version, telemetry };
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

	it("refreshes memory and evolved skills from one selected revision", async () => {
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
				version: revision.state.skills[0]?.contentHash,
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
			"diffex.skill.version": revision.state.skills[0]?.contentHash,
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

	it("rejects an evolved reference after the selected harness changes", async () => {
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

	it("refreshes the selected harness before the next admitted request", async () => {
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

		expect(harness.session.activeHarnessVersion).toBe(advance.bundle.manifest.version);
		expect(providerPrompts[0]).not.toContain("<evolution_memory");
		expect(providerPrompts[1]).toContain("Use the newly selected memory.");
	});

	it("keeps an in-flight request pinned while the next request refreshes", async () => {
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
				return fauxAssistantMessage("after activation");
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

		await harness.session.prompt("request admitted after activation");

		expect(providerPrompts[0]).not.toContain("Use memory selected during the request.");
		expect(providerPrompts[0]).not.toContain("<name>later-review</name>");
		expect(providerPrompts[1]).toContain("Use memory selected during the request.");
		expect(providerPrompts[1]).toContain("<name>later-review</name>");
		expect(harness.session.activeHarnessVersion).toBe(advance.bundle.manifest.version);
	});

	it("reports a live activation to the process lifecycle observer", async () => {
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

		await harness.session.prompt("observe the selected harness");

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
