import { fauxAssistantMessage } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("bounded proactive compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function seed(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({
			...options,
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 1000 }],
			settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt(`old history ${"x".repeat(6000)}`);
		const tokens = harness.session.getContextUsage()!.tokens!;
		harness.settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 10000 - tokens + 1 },
		});
		harness.events.length = 0;
		return harness;
	}

	it.each(["failure", "cancel", "insufficient", "auth"] as const)(
		"warns once for %s, continues queued work, and resets before the next idle preflight",
		async (outcome) => {
			const harness = await seed({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							if (outcome === "cancel") return { cancel: true };
							if (outcome === "insufficient")
								return {
									compaction: {
										summary: `oversized summary ${"s".repeat(10000)}`,
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
									},
								};
						});
					},
				],
			});
			if (outcome === "auth")
				vi.spyOn(harness.session.modelRuntime, "getAuth").mockRejectedValue(new Error("auth unavailable"));
			const order: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end") order.push("warning");
				if (event.type === "agent_end" && order.filter((item) => item === "normal").length === 1) {
					harness.session.agent.followUp({ role: "user", content: "automatic continuation", timestamp: 1 });
				}
			});
			const normal = () => {
				order.push("normal");
				return fauxAssistantMessage(`large final ${"a".repeat(8000)}`);
			};
			harness.setResponses([
				...(outcome === "failure"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary rejected" })]
					: []),
				(context) => {
					expect(context.messages.filter((message) => getMessageText(message) === "pending prompt")).toHaveLength(
						1,
					);
					return normal();
				},
				(context) => {
					expect(
						context.messages.filter((message) => getMessageText(message) === "automatic continuation"),
					).toHaveLength(1);
					return normal();
				},
			]);
			await harness.session.prompt("pending prompt");
			expect(order).toEqual(["warning", "normal", "normal"]);
			const warnings = harness.eventsOfType("compaction_end");
			expect(warnings).toHaveLength(1);
			expect(warnings[0].errorMessage).toBeTruthy();
			expect(warnings[0].aborted).toBe(outcome === "cancel");
			expect(Boolean(warnings[0].result)).toBe(outcome === "insufficient");
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.isCompacting).toBe(false);
			if (outcome === "insufficient") {
				expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
				expect(harness.session.messages[0]).toMatchObject({
					role: "compactionSummary",
					summary: warnings[0].result!.summary,
				});
			}
			harness.setResponses([
				...(outcome === "failure"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary rejected again" })]
					: []),
				(context) => {
					expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
					expect(
						context.messages.filter((message) => getMessageText(message) === "next idle prompt"),
					).toHaveLength(1);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("next idle prompt");
			expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
		},
	);

	it("reports nothing compactable before summarization, then allows another idle custom run", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1 }],
			settings: { retry: { enabled: false }, compaction: { reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText)).toEqual(["fresh"]);
				expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
				expect(harness.eventsOfType("compaction_end")[0].errorMessage).toContain("nothing compactable");
				return fauxAssistantMessage("answer");
			},
			(context) => {
				expect(context.messages.filter((message) => getMessageText(message).includes("custom wake"))).toHaveLength(
					1,
				);
				return fauxAssistantMessage("custom answer");
			},
		]);
		await harness.session.prompt("fresh");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		await harness.session.sendCustomMessage(
			{ customType: "wake", content: "custom wake", display: false },
			{ triggerTurn: true },
		);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")[1]).toMatchObject({ aborted: true, willRetry: false });
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each([false, true])(
		"compacts a successful final response without retry (over window: %s)",
		async (overWindow) => {
			const harness = await seed({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "compact summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			// Start below threshold so this is an eligible successful-answer check.
			harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 0 } });
			harness.setResponses([
				(context) => {
					expect(context.messages.some((message) => getMessageText(message) === "answer now")).toBe(true);
					harness.session.agent.state.model = {
						...harness.session.agent.state.model,
						contextWindow: overWindow ? 2000 : 10000,
					};
					harness.settingsManager.applyOverrides({ compaction: { reserveTokens: overWindow ? 0 : 8000 } });
					return fauxAssistantMessage(`completed answer ${"a".repeat(4000)}`);
				},
			]);
			await harness.session.prompt("answer now");
			expect(harness.eventsOfType("compaction_end")).toEqual([
				expect.objectContaining({
					reason: overWindow ? "overflow" : "threshold",
					willRetry: false,
					aborted: false,
					result: expect.any(Object),
				}),
			]);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.getLastAssistantText()).toContain("completed answer");
			expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
		},
	);

	it("allows renewed growth after a successful preflight reduction", async () => {
		const harness = await seed({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "small summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([
			(context) => {
				expect(getMessageText(context.messages[0])).toContain("small summary");
				expect(harness.eventsOfType("compaction_end")[0].errorMessage).toBeUndefined();
				return fauxAssistantMessage(`large answer ${"a".repeat(10000)}`);
			},
		]);
		await harness.session.prompt("grow again");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")[1].result).toBeDefined();
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it.each(["prompt", "session", "independent"] as const)(
		"links %s cancellation during summarization authentication",
		async (kind) => {
			const harness = await seed();
			let announceStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				announceStarted = resolve;
			});
			vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (_model, options) => {
				expect(harness.session.isCompacting).toBe(true);
				announceStarted();
				return await new Promise((_, reject) =>
					options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }),
				);
			});
			harness.setResponses([
				(context) => {
					expect(context.messages.filter((message) => getMessageText(message) === "pending")).toHaveLength(1);
					return fauxAssistantMessage("continued");
				},
			]);
			const controller = new AbortController();
			const prompt = harness.session.prompt(
				"pending",
				kind === "session" ? undefined : { signal: controller.signal },
			);
			const result = prompt.then(
				() => undefined,
				(error: unknown) => error,
			);
			await started;
			if (kind === "prompt") controller.abort(new Error("prompt cancelled"));
			else if (kind === "session") await harness.session.abort();
			else harness.session.abortCompaction();
			if (kind === "prompt") expect(await result).toBe(controller.signal.reason);
			else if (kind === "session") expect(await result).toMatchObject({ message: "Prompt cancelled" });
			else expect(await result).toBeUndefined();
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				aborted: true,
				errorMessage: expect.any(String),
			});
			expect(harness.faux.state.callCount).toBe(kind !== "independent" ? 1 : 2);
			expect(harness.session.isCompacting).toBe(false);
			expect(harness.session.isIdle).toBe(true);
		},
	);
	it("keeps manual compaction and bounded failure recovery independent of proactive suppression", async () => {
		const harness = await seed({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) =>
						event.reason === "threshold"
							? { cancel: true }
							: {
									compaction: {
										summary: "recovery summary",
										firstKeptEntryId: event.preparation.firstKeptEntryId,
										tokensBefore: event.preparation.tokensBefore,
									},
								},
					);
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("partial", { stopReason: "length" }),
			(context) => {
				expect(
					context.messages.some((message) => message.role === "assistant" && message.stopReason === "length"),
				).toBe(false);
				return fauxAssistantMessage(`recovered ${"a".repeat(8000)}`);
			},
		]);
		await harness.session.prompt("recover this");
		expect(harness.eventsOfType("compaction_end").map((event) => [event.reason, event.willRetry])).toEqual([
			["threshold", false],
			["overflow", true],
		]);
		expect(harness.session.getLastAssistantText()).toContain("recovered");
		expect(harness.faux.state.callCount).toBe(3);
		await harness.session.compact();
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			result: expect.any(Object),
		});
	});

	it.each(["during", "end"] as const)(
		"session abort at post-answer compaction %s prevents queued continuation",
		async (stage) => {
			let announceStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				announceStarted = resolve;
			});
			const harness = await seed({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							announceStarted();
							if (stage === "during")
								await new Promise<void>((resolve) => {
									event.signal.addEventListener("abort", () => resolve(), { once: true });
								});
							return {
								compaction: {
									summary: "saved summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 0 } });
			harness.setResponses([
				() => {
					harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 9999 } });
					return fauxAssistantMessage("completed answer");
				},
				fauxAssistantMessage("unexpected continuation"),
			]);
			let abort: Promise<void> | undefined;
			harness.session.subscribe((event) => {
				if (event.type !== "compaction_end") return;
				harness.session.agent.followUp({ role: "user", content: "queued after compaction", timestamp: 1 });
				if (stage === "end") abort = harness.session.abort();
			});
			const prompt = harness.session.prompt("complete first");
			await started;
			if (stage === "during") abort = harness.session.abort();
			await prompt;
			await abort;
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.isCompacting).toBe(false);
		},
	);
	it("rolls back saved preflight compaction when an unsignaled prompt is aborted through the session", async () => {
		let saved!: () => void;
		let release!: () => void;
		const savedEntry = new Promise<void>((resolve) => {
			saved = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await seed({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "tentative summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("session_compact", async () => {
						saved();
						await released;
					});
				},
			],
		});
		const before = harness.session.messages.slice();
		const prompt = harness.session.prompt("never admitted").catch((error: unknown) => error);
		await savedEntry;
		expect(harness.sessionManager.getLeafEntry()?.type).toBe("compaction");
		await harness.session.abort();
		release();
		expect(await prompt).toMatchObject({ message: "Prompt cancelled" });
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.session.messages).toEqual(before);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isCompacting).toBe(false);
	});
});
