import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/diffex-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ValidateSessionTarget,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { deferred } from "./subagent-harness.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

const extensionContext = {} as ExtensionContext;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			persist?: boolean;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			beforeCreateRuntime?: (sessionManager: SessionManager, requestNumber: number) => Promise<void> | void;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		let runtimeRequestCount = 0;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			runtimeRequestCount += 1;
			await options?.beforeCreateRuntime?.(sessionManager, runtimeRequestCount);
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: options?.persist === false ? SessionManager.inMemory(tempDir) : SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("settles the active response before session replacement", async () => {
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.prompt("hello");
		const firstSessionFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const promptPromise = outgoingSession.prompt("start blocking tool");
		await toolStartedPromise;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionManager.open(outgoingSession.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it.each(["clear", "resume", "fork", "import"] as const)(
		"awaits active child cleanup before %s replacement",
		async (flow) => {
			const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
			await runtime.session.prompt("seed");
			const forkEntryId = runtime.session.getUserMessagesForForking()[0]!.entryId;
			let targetSessionFile: string | undefined;
			if (flow === "resume") {
				const target = SessionManager.create(tempDir);
				target.appendMessage({
					role: "user",
					content: [{ type: "text", text: "target" }],
					timestamp: Date.now(),
				});
				targetSessionFile = target.getSessionFile();
			} else if (flow === "import") {
				targetSessionFile = runtime.session.sessionFile;
			}

			const childProviderStarted = deferred<void>();
			const childProviderAborted = deferred<void>();
			faux.setResponses([
				(_context, options) =>
					new Promise((resolve) => {
						childProviderStarted.resolve();
						options?.signal?.addEventListener(
							"abort",
							() => {
								childProviderAborted.resolve();
								resolve(fauxAssistantMessage("child aborted", { stopReason: "aborted" }));
							},
							{ once: true },
						);
					}),
			]);
			const outgoing = runtime.session;
			const spawn = outgoing.getToolDefinition("spawn_agent")!;
			const agents = outgoing.getToolDefinition("agents")!;
			await spawn.execute("spawn-worker", { name: "worker", task: "wait" }, undefined, undefined, extensionContext);
			await childProviderStarted.promise;
			await spawn.execute("spawn-queued", { name: "queued", task: "wait" }, undefined, undefined, extensionContext);
			const oldWaitResult = agents
				.execute(
					"wait-old",
					{ timeout_ms: 10_000, targets: ["worker", "queued"], until: "all" },
					undefined,
					undefined,
					extensionContext,
				)
				.catch((error: unknown) => error);

			const originalDispose = outgoing.dispose.bind(outgoing);
			const disposeReached = deferred<void>();
			const disposeGate = deferred<void>();
			vi.spyOn(outgoing, "dispose").mockImplementation(async () => {
				await originalDispose();
				disposeReached.resolve();
				await disposeGate.promise;
			});
			let replacement: Promise<unknown>;
			if (flow === "clear") {
				replacement = runtime.newSession();
			} else if (flow === "resume") {
				replacement = runtime.switchSession(targetSessionFile!);
			} else if (flow === "fork") {
				replacement = runtime.fork(forkEntryId);
			} else {
				replacement = runtime.importFromJsonl(targetSessionFile!);
			}

			await Promise.all([childProviderAborted.promise, disposeReached.promise]);
			expect(runtime.session).toBe(outgoing);
			disposeGate.resolve();
			await replacement;
			expect(runtime.session).not.toBe(outgoing);
			await expect(oldWaitResult).resolves.toMatchObject({ message: "Subagent controller is shut down" });

			const nextAgents = runtime.session.getToolDefinition("agents")!;
			await expect(
				nextAgents.execute("list-empty", { timeout_ms: 0 }, undefined, undefined, extensionContext),
			).resolves.toMatchObject({ details: { timed_out: false, agents: [] } });
			faux.setResponses([fauxAssistantMessage("replacement child done")]);
			const nextSpawn = runtime.session.getToolDefinition("spawn_agent")!;
			await nextSpawn.execute(
				"reuse-worker",
				{ name: "worker", task: "again" },
				undefined,
				undefined,
				extensionContext,
			);
			await expect(
				nextAgents.execute(
					"wait-worker",
					{ timeout_ms: 1_000, targets: ["worker"], until: "all" },
					undefined,
					undefined,
					extensionContext,
				),
			).resolves.toMatchObject({
				details: { timed_out: false, agents: [{ name: "worker", status: "idle" }] },
			});
		},
	);

	it("awaits active and queued children during application shutdown", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		const childProviderStarted = deferred<void>();
		const childProviderAborted = deferred<void>();
		faux.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					childProviderStarted.resolve();
					options?.signal?.addEventListener(
						"abort",
						() => {
							childProviderAborted.resolve();
							resolve(fauxAssistantMessage("child aborted", { stopReason: "aborted" }));
						},
						{ once: true },
					);
				}),
		]);
		const outgoing = runtime.session;
		const spawn = outgoing.getToolDefinition("spawn_agent")!;
		const agents = outgoing.getToolDefinition("agents")!;
		await spawn.execute("spawn-active", { name: "active", task: "wait" }, undefined, undefined, extensionContext);
		await childProviderStarted.promise;
		await spawn.execute("spawn-queued", { name: "queued", task: "wait" }, undefined, undefined, extensionContext);
		const agentsResult = agents
			.execute(
				"wait-agents",
				{ timeout_ms: 10_000, targets: ["active", "queued"], until: "all" },
				undefined,
				undefined,
				extensionContext,
			)
			.catch((error: unknown) => error);
		const originalDispose = AgentSession.prototype.dispose;
		const disposedChildren: AgentSession[] = [];
		vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession) {
			if (this !== outgoing) disposedChildren.push(this);
			return originalDispose.call(this);
		});

		const firstDispose = runtime.dispose();
		const secondDispose = runtime.dispose();
		expect(firstDispose).toBe(secondDispose);
		await childProviderAborted.promise;
		await firstDispose;
		await expect(agentsResult).resolves.toMatchObject({ message: "Subagent controller is shut down" });
		expect(disposedChildren).toHaveLength(1);
	});

	it("shares the disposal promise during synchronous re-entry", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const originalAbort = runtime.session.abort.bind(runtime.session);
		let nestedDisposal: Promise<void> | undefined;
		let reentered = false;
		let invalidations = 0;
		runtime.setBeforeSessionInvalidate(() => {
			invalidations += 1;
		});
		vi.spyOn(runtime.session, "abort").mockImplementation(() => {
			if (!reentered) {
				reentered = true;
				nestedDisposal = runtime.dispose();
			}
			return originalAbort();
		});

		const disposal = runtime.dispose();

		expect(nestedDisposal).toBe(disposal);
		await disposal;
		expect(invalidations).toBe(1);
	});

	it("keeps a disposed in-memory session leased through fork activation", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { persist: false });
		await runtime.session.prompt("hello");
		const outgoingSession = runtime.session;
		const outgoingManager = outgoingSession.sessionManager;
		const outgoingLeafId = outgoingManager.getLeafId();
		const outgoingEntries = outgoingManager.getEntries();
		const userMessage = outgoingSession.getUserMessagesForForking()[0];
		if (!userMessage) throw new Error("Expected a user message to fork");
		let mutationError: unknown;
		let mutationFinished!: () => void;
		const mutationFinishedPromise = new Promise<void>((resolve) => {
			mutationFinished = resolve;
		});
		runtime.setBeforeSessionInvalidate(() => {
			queueMicrotask(() => {
				try {
					outgoingSession.setCollaborationMode("plan");
				} catch (error) {
					mutationError = error;
				} finally {
					mutationFinished();
				}
			});
		});

		const result = await runtime.fork(userMessage.entryId, { position: "at" });
		await mutationFinishedPromise;
		runtime.setBeforeSessionInvalidate(undefined);

		expect(result.cancelled).toBe(false);
		expect(runtime.session).not.toBe(outgoingSession);
		expect(runtime.session.sessionManager).not.toBe(outgoingManager);
		expect(runtime.session.collaborationMode).toBe("default");
		expect(outgoingManager.getLeafId()).toBe(outgoingLeafId);
		expect(outgoingManager.getEntries()).toEqual(outgoingEntries);
		expect(mutationError).toBeInstanceOf(Error);
		expect((mutationError as Error).message).toMatch(/replacement/i);
	});

	it("preserves the live in-memory session when fork runtime creation fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, {
			persist: false,
			beforeCreateRuntime: (_sessionManager, requestNumber) => {
				if (requestNumber === 2) throw new Error("candidate creation failed");
			},
		});
		await runtime.session.prompt("hello");
		const outgoingSession = runtime.session;
		const outgoingManager = outgoingSession.sessionManager;
		const outgoingSessionId = outgoingManager.getSessionId();
		const outgoingLeafId = outgoingManager.getLeafId();
		const outgoingEntries = outgoingManager.getEntries();
		expect(outgoingManager.createInMemoryBranch(null).getHeader()?.profile).toEqual(
			outgoingManager.getHeader()?.profile,
		);
		const userMessage = outgoingSession.getUserMessagesForForking()[0];
		if (!userMessage) throw new Error("Expected a user message to fork");

		await expect(runtime.fork(userMessage.entryId, { position: "at" })).rejects.toThrow("candidate creation failed");

		expect(runtime.session).toBe(outgoingSession);
		expect(runtime.session.sessionManager).toBe(outgoingManager);
		expect(outgoingManager.getSessionId()).toBe(outgoingSessionId);
		expect(outgoingManager.getLeafId()).toBe(outgoingLeafId);
		expect(outgoingManager.getEntries()).toEqual(outgoingEntries);
		expect(() => outgoingSession.setCollaborationMode("plan")).not.toThrow();
		outgoingSession.setCollaborationMode("default");
	});

	it("rejects runtime prompts until delayed session rebind completes", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		let rebindStarted!: () => void;
		let releaseRebind!: () => void;
		const rebindStartedPromise = new Promise<void>((resolve) => {
			rebindStarted = resolve;
		});
		const rebindGate = new Promise<void>((resolve) => {
			releaseRebind = resolve;
		});
		runtime.setRebindSession(async (session) => {
			rebindStarted();
			await rebindGate;
			await session.bindExtensions({});
		});

		const replacement = runtime.newSession();
		await rebindStartedPromise;
		const replacementSession = runtime.session;
		await expect(runtime.prompt("too early")).rejects.toThrow(/replacement/i);
		expect(replacementSession.messages).toEqual([]);

		releaseRebind();
		await replacement;
		await runtime.prompt("after rebind");
		expect(runtime.session.messages.some((message) => JSON.stringify(message).includes("after rebind"))).toBe(true);
	});

	it.each(["invalidation", "activation"] as const)(
		"adopts and rebinds the prepared runtime when %s fails after shutdown starts",
		async (failureStage) => {
			const { runtime } = await createRuntimeForTest(() => {});
			const outgoingSession = runtime.session;
			let reboundSession = runtime.session;
			runtime.setRebindSession(async (session) => {
				reboundSession = session;
				await session.bindExtensions({});
			});
			if (failureStage === "invalidation") {
				runtime.setBeforeSessionInvalidate(() => {
					throw new Error("invalidation failed");
				});
			}

			const replacement = runtime.newSession({
				setup:
					failureStage === "activation"
						? async (sessionManager) => {
								const setProfileMetadata = sessionManager.setProfileMetadata.bind(sessionManager);
								let metadataWrites = 0;
								sessionManager.setProfileMetadata = (profile) => {
									metadataWrites += 1;
									if (metadataWrites === 2) throw new Error("activation failed");
									setProfileMetadata(profile);
								};
							}
						: undefined,
			});
			await expect(replacement).rejects.toThrow(`${failureStage} failed`);
			runtime.setBeforeSessionInvalidate(undefined);

			expect(runtime.session).not.toBe(outgoingSession);
			expect(reboundSession).toBe(runtime.session);
			expect(() => outgoingSession.setCollaborationMode("plan")).toThrow(/replacement/i);
			await runtime.prompt("candidate remains live");
			expect(
				runtime.session.messages.some((message) => JSON.stringify(message).includes("candidate remains live")),
			).toBe(true);
		},
	);

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("validates switch and fork targets before replacing or mutating the current session", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const currentSession = runtime.session;
		const currentManager = currentSession.sessionManager;
		const defaultLeafId = currentManager.getLeafId();
		if (!defaultLeafId) throw new Error("Expected a current session leaf");

		const targetManager = SessionManager.create(tempDir, join(tempDir, "target-sessions"));
		targetManager.appendCollaborationModeChange("plan");
		targetManager.appendPlan({ id: "target-plan", title: "Target plan", markdown: "1. Keep planning." });
		targetManager.appendMessage(fauxAssistantMessage("persist target"));
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected a target session file");

		const validateTarget: ValidateSessionTarget = (sessionManager, leafId) => {
			if (buildSessionContext(sessionManager.getEntries(), leafId).collaborationMode === "plan") {
				throw new Error("Cannot activate a plan-mode target");
			}
		};

		await expect(runtime.switchSession(targetSessionFile, { validateTarget })).rejects.toThrow(
			"Cannot activate a plan-mode target",
		);
		expect(runtime.session).toBe(currentSession);
		expect(currentManager.getLeafId()).toBe(defaultLeafId);

		currentManager.appendCollaborationModeChange("plan");
		currentManager.appendPlan({ id: "branch-plan", title: "Branch plan", markdown: "1. Keep planning." });
		const planLeafId = currentManager.getLeafId();
		if (!planLeafId) throw new Error("Expected a plan branch leaf");
		currentManager.branch(defaultLeafId);

		await expect(runtime.fork(planLeafId, { position: "at", validateTarget })).rejects.toThrow(
			"Cannot activate a plan-mode target",
		);
		expect(runtime.session).toBe(currentSession);
		expect(currentManager.getLeafId()).toBe(defaultLeafId);
	});

	it("runs new-session setup and validates its complete context before replacing the current session", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		const currentSession = runtime.session;
		const currentLeafId = currentSession.sessionManager.getLeafId();
		let targetManager: SessionManager | undefined;

		const validateTarget: ValidateSessionTarget = (sessionManager, leafId) => {
			targetManager = sessionManager;
			const context = buildSessionContext(sessionManager.getEntries(), leafId);
			expect(context.collaborationMode).toBe("plan");
			expect(context.pendingPlan?.id).toBe("invalid-target-plan");
			throw new Error("Cannot activate plan mode");
		};

		await expect(
			runtime.newSession({
				setup: async (sessionManager) => {
					sessionManager.appendCollaborationModeChange("plan");
					sessionManager.appendPlan({
						id: "invalid-target-plan",
						title: "Invalid target plan",
						markdown: "1. Keep the active session intact.",
					});
				},
				validateTarget,
			}),
		).rejects.toThrow("Cannot activate plan mode");

		expect(targetManager).toBeDefined();
		expect(targetManager).not.toBe(currentSession.sessionManager);
		expect(runtime.session).toBe(currentSession);
		expect(currentSession.sessionManager.getLeafId()).toBe(currentLeafId);
		expect(currentSession.collaborationMode).toBe("default");
	});

	it("reports why an unflushed session cannot be forked", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		expect(leafId).toBeTruthy();

		await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(
			"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
		);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});

	it("does not refresh a provided model runtime when no providers register", async () => {
		const tempDir = join(tmpdir(), `pi-services-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const refresh = vi.spyOn(modelRuntime, "refresh");
		cleanups.push(async () => rmSync(tempDir, { recursive: true, force: true }));

		await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		expect(refresh).not.toHaveBeenCalled();
	});

	it("awaits the refresh barrier after provider registration", async () => {
		const tempDir = join(tmpdir(), `pi-services-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const refreshResult = { aborted: false, errors: new Map<string, Error>() };
		let releaseBarrier!: () => void;
		const barrier = new Promise<typeof refreshResult>((resolve) => {
			releaseBarrier = () => resolve(refreshResult);
		});
		const refresh = vi
			.spyOn(modelRuntime, "refresh")
			.mockResolvedValueOnce(refreshResult)
			.mockImplementationOnce(() => barrier);
		cleanups.push(async () => {
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		});

		let settled = false;
		const creation = createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						const model = faux.getModel();
						pi.registerProvider("barrier-provider", {
							baseUrl: model.baseUrl,
							api: faux.api,
							models: [
								{
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
									baseUrl: model.baseUrl,
								},
							],
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		}).then((services) => {
			settled = true;
			return services;
		});

		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
		expect(settled).toBe(false);
		releaseBarrier();
		await creation;
		expect(settled).toBe(true);
	});
});
