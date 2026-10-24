import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@diffexai/diffex-ai";
import { HarnessStateStore } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN_MODE_SYSTEM_PROMPT, setCollaborationMode } from "../../src/core/collaboration-mode.ts";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { markFixedHarnessSubagentSession } from "../../src/core/subagents/session-runtime.ts";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];
	const agentDirs: string[] = [];

	async function createVersionedCompactionHarness(options: HarnessOptions = {}) {
		const agentDir = join(tmpdir(), `diffex-compaction-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		agentDirs.push(agentDir);
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const harness = await createHarness({
			...options,
			harnessStateStore: store,
			harnessVersionBundle: root,
			settings: {
				...options.settings,
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0, ...options.settings?.compaction },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "versioned compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
				...(options.extensionFactories ?? []),
			],
		});
		harnesses.push(harness);
		return { harness, store, root };
	}

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
		for (const agentDir of agentDirs.splice(0)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe(
			`summary from extension\n\nCurrent task context (latest plan):\n${JSON.stringify({ plan: [] }, null, 2)}`,
		);
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				expect(harness.session.isCompacting).toBe(false);
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		await harness.session.compact();
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("reconciles the selected harness after committed manual compaction without queued work", async () => {
		const agentDir = join(tmpdir(), `diffex-compaction-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const harness = await createHarness({
			harnessStateStore: store,
			harnessVersionBundle: root,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		try {
			seedCompactableSession(harness);
			const successor = await store.advance({ memory: "Use the compacted selection." }, root.manifest.version);
			expect(successor.status).toBe("advanced");
			if (successor.status !== "advanced") throw new Error("Expected harness advance to succeed");

			await harness.session.compact();

			expect(harness.session.activeHarnessVersion).toBe(successor.bundle.manifest.version);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("refreshes with a queued continuation and reports a later post-commit harness refresh failure", async () => {
		const agentDir = join(tmpdir(), `diffex-compaction-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		const store = new HarnessStateStore(agentDir);
		const root = await store.initialize();
		const harness = await createHarness({
			harnessStateStore: store,
			harnessVersionBundle: root,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		try {
			seedCompactableSession(harness);
			const successor = await store.advance(
				{ memory: "Activate at the compaction boundary." },
				root.manifest.version,
			);
			expect(successor.status).toBe("advanced");
			if (successor.status !== "advanced") throw new Error("Expected harness advance to succeed");
			harness.session.agent.followUp({
				role: "custom",
				customType: "test",
				content: [{ type: "text", text: "queued continuation" }],
				display: false,
				timestamp: Date.now(),
			});

			await harness.session.compact();

			expect(harness.session.activeHarnessVersion).toBe(successor.bundle.manifest.version);
			harness.session.agent.clearAllQueues();
			seedCompactableSession(harness);
			vi.spyOn(store, "loadCurrent").mockRejectedValueOnce(new Error("selection read failed"));

			const result = await harness.session.compact();

			expect(result.summary).toContain("manual compacted");
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
				reason: "manual",
				aborted: false,
				result,
				errorMessage: "selection read failed",
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it.each(["default", "plan"] as const)(
		"refreshes the %s harness before automatic tool and overflow continuations",
		async (mode) => {
			for (const reason of ["threshold", "overflow"] as const) {
				const { harness, store, root } = await createVersionedCompactionHarness({
					models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
				});
				if (mode === "plan") setCollaborationMode(harness.session, mode);
				seedCompactableSession(harness);
				writeFileSync(join(harness.tempDir, "context.txt"), "context to inspect");
				let selectedVersion = root.manifest.version;
				const prompts: string[] = [];
				harness.setResponses([
					async (context) => {
						prompts.push(context.systemPrompt ?? "");
						const advanced = await store.advance(
							{ memory: "Use memory after automatic compaction." },
							root.manifest.version,
						);
						if (advanced.status !== "advanced") throw new Error("Expected harness advance to succeed");
						selectedVersion = advanced.bundle.manifest.version;
						return reason === "threshold"
							? fauxAssistantMessage(fauxToolCall("read", { path: join(harness.tempDir, "context.txt") }), {
									stopReason: "toolUse",
								})
							: fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
					},
					(context) => {
						prompts.push(context.systemPrompt ?? "");
						harness.settingsManager.setCompactionEnabled(false);
						return fauxAssistantMessage("continued with the new harness");
					},
				]);

				await harness.session.prompt("x".repeat(5000));

				expect(prompts, reason).toHaveLength(2);
				expect(prompts[0]).not.toContain("Use memory after automatic compaction.");
				expect(prompts[1]).toContain("Use memory after automatic compaction.");
				if (mode === "plan") expect(prompts[1]).toContain(PLAN_MODE_SYSTEM_PROMPT);
				expect(harness.session.activeHarnessVersion).toBe(selectedVersion);
				expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ reason, aborted: false });
			}
		},
	);

	it.each([false, true])("refreshes only after pre-prompt compaction commits (cancel: %s)", async (cancel) => {
		const { harness, store, root } = await createVersionedCompactionHarness({
			models: [{ id: "faux-1", contextWindow: 1000 }],
			settings: { compaction: { reserveTokens: 950 } },
		});
		seedCompactableSession(harness);
		const advanced = await store.advance({ memory: "Use committed pre-prompt memory." }, root.manifest.version);
		if (advanced.status !== "advanced") throw new Error("Expected harness advance to succeed");
		const controller = new AbortController();
		harness.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("Use committed pre-prompt memory.");
				harness.settingsManager.setCompactionEnabled(false);
				return fauxAssistantMessage("after pre-prompt compaction");
			},
		]);

		const prompt = harness.session.prompt("continue", {
			signal: controller.signal,
			preflightResult: (accepted) => {
				if (accepted && cancel) controller.abort(new Error("cancel before commit"));
			},
		});
		if (cancel) await expect(prompt).rejects.toThrow("cancel before commit");
		else await prompt;

		expect(harness.session.activeHarnessVersion).toBe(
			cancel ? root.manifest.version : advanced.bundle.manifest.version,
		);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			cancel ? 0 : 1,
		);
		expect(harness.faux.state.callCount).toBe(cancel ? 0 : 1);
	});

	it.each(["pre-prompt", "overflow"] as const)(
		"preserves extension prompt overrides through %s refresh",
		async (boundary) => {
			const { harness, store, root } = await createVersionedCompactionHarness({
				models: [{ id: "faux-1", contextWindow: 1000 }],
				settings: { compaction: { reserveTokens: boundary === "pre-prompt" ? 950 : 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", () => ({ systemPrompt: "Extension-owned prompt" }));
					},
				],
			});
			seedCompactableSession(harness);
			const advanced = await store.advance({ memory: "New base harness memory." }, root.manifest.version);
			if (advanced.status !== "advanced") throw new Error("Expected harness advance to succeed");
			const prompts: string[] = [];
			harness.setResponses([
				(context) => {
					prompts.push(context.systemPrompt ?? "");
					if (boundary === "overflow")
						return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
					harness.settingsManager.setCompactionEnabled(false);
					return fauxAssistantMessage("after pre-prompt compaction");
				},
				(context) => {
					prompts.push(context.systemPrompt ?? "");
					harness.settingsManager.setCompactionEnabled(false);
					return fauxAssistantMessage("after overflow compaction");
				},
			]);

			await harness.session.prompt("continue with the extension prompt");

			expect(prompts).toEqual(Array(boundary === "overflow" ? 2 : 1).fill("Extension-owned prompt"));
			expect(harness.session.activeHarnessVersion).toBe(advanced.bundle.manifest.version);
			expect(harness.session.systemPrompt).toContain("New base harness memory.");
		},
	);

	it("restores next-turn context if cancellation arrives during the committed harness refresh", async () => {
		const { harness, store, root } = await createVersionedCompactionHarness({
			models: [{ id: "faux-1", contextWindow: 1000 }],
			settings: { compaction: { reserveTokens: 950 } },
		});
		seedCompactableSession(harness);
		const advanced = await store.advance({ memory: "Committed harness memory." }, root.manifest.version);
		if (advanced.status !== "advanced") throw new Error("Expected harness advance to succeed");
		await harness.session.sendCustomMessage(
			{ customType: "test", content: "pending context survives cancellation", display: false },
			{ deliverAs: "nextTurn" },
		);
		const controller = new AbortController();
		vi.spyOn(store, "loadCurrent").mockImplementationOnce(async () => {
			controller.abort(new Error("cancel during harness refresh"));
			return advanced.bundle;
		});

		await expect(harness.session.prompt("cancel before agent start", { signal: controller.signal })).rejects.toThrow(
			"cancel during harness refresh",
		);

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		harness.settingsManager.setCompactionEnabled(false);
		harness.setResponses([
			(context) => {
				expect(
					context.messages.filter((message) =>
						getMessageText(message).includes("pending context survives cancellation"),
					),
				).toHaveLength(1);
				return fauxAssistantMessage("restored pending context");
			},
		]);
		await harness.session.prompt("try again");
		expect(harness.session.getLastAssistantText()).toBe("restored pending context");
	});

	it.each(["pinned", "fixed"])("keeps a %s harness unchanged after compaction", async (kind) => {
		const { harness, store, root } = await createVersionedCompactionHarness({ pinHarnessVersion: kind === "pinned" });
		if (kind === "fixed") markFixedHarnessSubagentSession(harness.sessionManager);
		seedCompactableSession(harness);
		await store.advance({ memory: "Do not apply to pinned sessions." }, root.manifest.version);

		await harness.session.compact();

		expect(harness.session.activeHarnessVersion).toBe(root.manifest.version);
	});

	it("reports an automatic refresh failure without undoing compaction or stopping recovery", async () => {
		const { harness, store, root } = await createVersionedCompactionHarness();
		seedCompactableSession(harness);
		await store.advance({ memory: "Unavailable selected memory." }, root.manifest.version);
		vi.spyOn(store, "loadCurrent").mockRejectedValueOnce(new Error("selection read failed"));
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(true);

		expect(harness.session.activeHarnessVersion).toBe(root.manifest.version);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
			result: expect.objectContaining({ summary: expect.stringContaining("versioned compaction summary") }),
			errorMessage: "selection read failed",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("keeps a provider error terminal when threshold compaction queues a report", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000 }],
			settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "threshold summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.result) {
				harness.session.agent.steer({
					role: "custom",
					customType: "subagent_results",
					content: "queued report",
					display: false,
					timestamp: Date.now(),
				});
			}
		});
		harness.setResponses([
			() => {
				harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 999 } });
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" });
			},
			fauxAssistantMessage("unexpected continuation"),
		]);

		await harness.session.prompt("fail near the compaction threshold");

		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", willRetry: false, aborted: false, result: expect.any(Object) }),
		]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "invalid_api_key" });
		expect(harness.session.state.errorMessage).toBe("invalid_api_key");
	});

	it("restores the original failure when overflow compaction is declined", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" })]);

		await harness.session.prompt("overflow");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: true,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "prompt is too long",
		});
		expect(
			harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		).toHaveLength(1);
	});

	it.each([false, true])(
		"allows overflow recovery before settling a parent error (repeated overflow: %s)",
		async (repeated) => {
			const harness = await createHarness({
				settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => ({
							compaction: {
								summary: "overflow summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			harness.setResponses([
				() =>
					fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: "prompt is too long",
						timestamp: Date.now() + 10_000,
					}),
				() =>
					repeated
						? fauxAssistantMessage("", {
								stopReason: "error",
								errorMessage: "prompt is too long",
								timestamp: Date.now() + 20_000,
							})
						: fauxAssistantMessage("recovered after compaction"),
			]);

			await harness.session.prompt("overflow once");

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
			expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: repeated ? "error" : "stop" });
			if (repeated) expect(harness.session.state.errorMessage).toBe("prompt is too long");
			else expect(harness.session.getLastAssistantText()).toBe("recovered after compaction");
		},
	);

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, undefined, undefined);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
