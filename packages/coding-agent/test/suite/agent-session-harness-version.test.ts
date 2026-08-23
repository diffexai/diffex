import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import { HarnessStateStore, type HarnessVersion } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	}> {
		const agentDir = join(tmpdir(), `diffex-harness-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		agentDirs.push(agentDir);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const harness = await createHarness({
			harnessStateStore: store,
			harnessVersionBundle: root,
		});
		harnesses.push(harness);
		return { harness, store, rootVersion: root.manifest.version };
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
		const advance = await store.advance({ memory: "Use memory selected during the request." }, rootVersion);
		expect(advance.status).toBe("advanced");
		if (advance.status !== "advanced") throw new Error("Expected harness advance to succeed");
		expect(harness.session.activeHarnessVersion).toBe(rootVersion);
		resolveFirst?.(fauxAssistantMessage("before activation"));
		await inFlight;

		await harness.session.prompt("request admitted after activation");

		expect(providerPrompts[0]).not.toContain("Use memory selected during the request.");
		expect(providerPrompts[1]).toContain("Use memory selected during the request.");
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
