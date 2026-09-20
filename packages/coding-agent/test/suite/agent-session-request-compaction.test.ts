import type { AgentContext, AgentTool } from "@diffexai/diffex-agent-core";
import {
	calculateContextTokens,
	estimateMessageTokens,
	estimateTextTokens,
	fauxAssistantMessage,
	fauxToolCall,
} from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function localTokens(context: AgentContext): number {
	const tools = context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) ?? [];
	return (
		convertToLlm(context.messages).reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
		estimateTextTokens(context.systemPrompt) +
		(tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0)
	);
}

describe("compaction before normal model requests", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		// Faux converts callback assertion failures into error responses; surface them after settlement.
		const errors = harnesses.flatMap((harness) =>
			harness.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
		);
		while (harnesses.length) await harnesses.pop()?.cleanup();
		expect(errors).toEqual([]);
	});
	async function seed(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({
			tools: [],
			models: [{ id: "faux-1", contextWindow: 30000 }],
			settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
			...options,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("old answer")]);
		await harness.session.prompt("x".repeat(40000));
		harness.settingsManager.applyOverrides({ compaction: { enabled: true } });
		harness.events.length = 0;
		return harness;
	}

	it.each(["valid", "zero", "missing"] as const)(
		"budgets complete tool batches with %s usage and recompacts only after renewed growth",
		async (usage) => {
			let executions = 0;
			const measured: Array<[number | null | undefined, number]> = [];
			const tool: AgentTool = {
				name: "large",
				label: "Large",
				description: "large result",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "t".repeat(++executions <= 2 ? 10000 : 20000) }],
					details: {},
				}),
			};
			const harness = await seed({
				tools: [tool],
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", (event) => {
							if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
							if (usage === "missing") Reflect.deleteProperty(event.message, "usage");
							if (usage === "zero") event.message.usage = fauxAssistantMessage("").usage;
							measured.push([
								harness.session.getContextUsage()?.tokens,
								usage === "valid"
									? calculateContextTokens(event.message.usage) +
										event.toolResults.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
									: localTokens(harness.session.state),
							]);
						});
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			const originalUsage = harness.session.getSessionStats().tokens.total;
			// Invalidate the older seed baseline without changing its billed usage.
			if (usage !== "valid") harness.session.agent.state.model = { ...harness.getModel(), contextWindow: 30001 };
			const order: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end") {
					order.push("compact");
				}
			});
			const batch = () =>
				fauxAssistantMessage([fauxToolCall("large", {}), fauxToolCall("large", {})], { stopReason: "toolUse" });
			harness.setResponses([
				() => {
					order.push("request");
					return batch();
				},
				(context) => {
					order.push("request");
					expect(getMessageText(context.messages[0])).toContain("checkpoint");
					const calls = context.messages.flatMap((message) =>
						message.role === "assistant"
							? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
							: [],
					);
					const results = context.messages.filter((message) => message.role === "toolResult");
					expect(results.map((message) => message.toolCallId)).toEqual(calls);
					expect(results).toHaveLength(2);
					expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness.session.state));
					expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
					return batch();
				},
				(context) => {
					order.push("request");
					expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
					return fauxAssistantMessage("finished");
				},
			]);
			await harness.session.prompt("run tools");
			expect(harness.eventsOfType("compaction_end").map((event) => event.errorMessage)).toEqual([
				undefined,
				undefined,
			]);
			expect(order).toEqual(["request", "compact", "request", "compact", "request"]);
			expect(executions).toBe(4);
			expect(measured).toHaveLength(2);
			for (const [actual, expected] of measured) expect(actual).toBe(expected);
			if (usage !== "missing") {
				const billed = harness.sessionManager
					.getEntries()
					.reduce(
						(sum, entry) =>
							sum +
							(entry.type === "message" && entry.message.role === "assistant"
								? calculateContextTokens(entry.message.usage)
								: 0),
						0,
					);
				expect(harness.session.getSessionStats().tokens.total).toBe(billed);
				expect(billed).toBeGreaterThan(originalUsage);
			}
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.session.getLastAssistantText()).toBe("finished");
		},
	);

	it.each([false, true])(
		"preserves idle customs, fresh images and multiple admitted customs (preflight: %s)",
		async (preflight) => {
			const harness = await seed();
			harness.settingsManager.applyOverrides({ compaction: { reserveTokens: preflight ? 25000 : 15000 } });
			for (const text of ["idle one", "idle two"])
				await harness.session.sendCustomMessage({
					customType: text,
					content: text,
					display: false,
					details: { text },
				});
			for (const text of ["next one", "next two"])
				await harness.session.sendCustomMessage(
					{ customType: text, content: text, display: false },
					{ deliverAs: "nextTurn" },
				);
			const prompt = `fresh ${"p".repeat(preflight ? 1000 : 20000)}`;
			harness.setResponses([
				(context) => {
					for (const text of ["idle one", "idle two", "next one", "next two", prompt])
						expect(context.messages.filter((message) => getMessageText(message) === text)).toHaveLength(1);
					expect(
						context.messages
							.flatMap((message) =>
								message.role === "user" && Array.isArray(message.content) ? message.content : [],
							)
							.filter((part) => part.type === "image"),
					).toHaveLength(1);
					expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt(prompt, { images: [{ type: "image", data: "AA==", mimeType: "image/png" }] });
			const firstCompact = harness.events.findIndex((event) => event.type === "compaction_start");
			const admission = harness.events.findIndex((event) => event.type === "agent_start");
			expect(firstCompact < admission).toBe(preflight);
			expect(harness.session.messages.map(({ timestamp, ...message }) => message)).toEqual(
				harness.sessionManager.buildSessionContext().messages.map(({ timestamp, ...message }) => message),
			);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"checks delivered %s input before its request without duplicate delivery",
		async (delivery) => {
			const harness = await seed();
			const text = `queued ${"q".repeat(20000)}`;
			harness.setResponses([
				async () => {
					await harness.session[delivery](text, [{ type: "image", data: "AA==", mimeType: "image/png" }]);
					return fauxAssistantMessage("first");
				},
				(context) => {
					expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
					expect(context.messages.filter((message) => getMessageText(message) === text)).toHaveLength(1);
					expect(context.messages.filter((message) => getMessageText(message) === text)).toEqual([
						expect.objectContaining({
							content: [
								{ type: "text", text },
								{ type: "image", data: "AA==", mimeType: "image/png" },
							],
						}),
					]);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("start");
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.session.pendingMessageCount).toBe(0);
		},
	);

	it.each([undefined, 100])("uses strict request threshold with reserve %s", async (reserveOverride) => {
		for (const delta of [-1, 0, 1, "disabled", "zero", "negative"] as const) {
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { ...(reserveOverride === undefined ? {} : { reserveTokens: reserveOverride }) } },
			});
			harnesses.push(harness);
			const prompt = "p".repeat(2000);
			const tokens = localTokens({
				...harness.session.state,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 }],
			});
			const reserve = harness.settingsManager.getCompactionSettings().reserveTokens;
			expect(reserve).toBe(reserveOverride ?? 16384);
			harness.session.agent.state.model = {
				...harness.getModel(),
				contextWindow:
					delta === "zero"
						? 0
						: delta === "negative"
							? -1
							: tokens + reserve - (typeof delta === "number" ? delta : 1),
			};
			if (delta === "disabled") harness.session.setAutoCompactionEnabled(false);
			harness.setResponses([
				() => {
					expect(harness.eventsOfType("compaction_end")).toHaveLength(delta === 1 ? 1 : 0);
					expect(harness.session.getContextUsage()?.tokens).toBe(
						delta === "zero" || delta === "negative" ? undefined : tokens,
					);
					harness.session.setAutoCompactionEnabled(false);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt(prompt);
		}
	});

	it("uses the loop-selected smaller window for eligibility and insufficient reduction", async () => {
		const harness = await seed();
		harness.session.agent.state.model = { ...harness.getModel(), contextWindow: 20000 };
		harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 0 } });
		harness.session.subscribe((event) => {
			if (event.type === "agent_start")
				harness.session.agent.state.model = { ...harness.getModel(), contextWindow: 200000 };
		});
		harness.setResponses([
			(context, _options, _state, model) => {
				expect(model.contextWindow).toBe(20000);
				expect(context.messages.filter((message) => getMessageText(message) === "p".repeat(90000))).toHaveLength(1);
				expect(context.messages.some((message) => getMessageText(message).includes("checkpoint"))).toBe(true);
				expect(harness.eventsOfType("compaction_end")[0].errorMessage).toContain("remains above");
				expect(harness.session.getContextUsage()?.contextWindow).toBe(200000);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("p".repeat(90000));
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});
	it.each([false, true])(
		"composes a previous hook once and preserves effective callback configuration (callback: %s)",
		async (callback) => {
			let enabled = false;
			let calls = 0;
			let pending: AgentContext["messages"][number] | undefined;
			const tool: AgentTool = {
				name: "replacement",
				label: "Replacement",
				description: "d".repeat(6000),
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			};
			const harness = await seed({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
						pi.on("session_compact", () => {
							if (callback) {
								pi.setActiveTools([]);
								harness.session.agent.state.systemPrompt = "callback instructions";
							}
						});
					},
				],
				prepareRequest: (context) => {
					calls++;
					if (!enabled) return;
					const messages = structuredClone(context.messages);
					pending = messages.at(-1);
					return {
						...context,
						messages,
						systemPrompt: `replacement instructions ${"s".repeat(12000)}`,
						tools: [tool],
					};
				},
			});
			enabled = true;
			harness.setResponses([
				(context) => {
					expect(calls).toBe(2);
					expect(context.systemPrompt).toContain(callback ? "callback instructions" : "replacement instructions");
					expect(context.tools?.map((item) => item.name)).toEqual(callback ? [] : ["replacement"]);
					expect(harness.session.messages.at(-1)).toBe(pending);
					expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness.session.state));
					expect(harness.eventsOfType("compaction_end")).toEqual([
						expect.objectContaining({ result: expect.any(Object) }),
					]);
					expect(harness.eventsOfType("compaction_end")[0].errorMessage).toBeUndefined();
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("new input");
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		},
	);

	it.each(["add", "remove", "reorder", "custom details", "excluded bash"] as const)(
		"warns and preserves an unmappable %s hook replacement across later proactive sites",
		async (kind) => {
			let enabled = false;
			let changed: AgentContext["messages"] | undefined;
			const harness = await seed({
				prepareRequest: (context) => {
					if (!enabled || changed) return;
					const messages = structuredClone(context.messages);
					if (kind === "add") messages.push({ role: "user", content: "hook-only input", timestamp: 1 });
					if (kind === "remove") messages.splice(1, 1);
					if (kind === "reorder") [messages[0], messages[1]] = [messages[1], messages[0]];
					if (kind === "custom details")
						for (const message of messages) if (message.role === "custom") message.details = { modified: true };
					if (kind === "excluded bash")
						for (const message of messages)
							if (message.role === "bashExecution") message.output = "modified hidden output";
					changed = messages;
					return { ...context, messages };
				},
			});
			await harness.session.sendCustomMessage({
				customType: "metadata",
				content: "custom",
				display: false,
				details: { original: true },
			});
			const bash = {
				role: "bashExecution" as const,
				command: "echo",
				output: "original",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 1,
			};
			harness.sessionManager.appendMessage(bash);
			harness.session.agent.state.messages.push(bash);
			enabled = true;
			harness.setResponses([
				async (context) => {
					expect(harness.eventsOfType("compaction_end")[0].errorMessage).toContain("do not match");
					expect(context.messages).toEqual(convertToLlm(changed!));
					await harness.session.followUp("queued continuation");
					return fauxAssistantMessage("first");
				},
				() => {
					expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
					return fauxAssistantMessage("second");
				},
			]);
			await harness.session.prompt("p".repeat(20000));
			expect(harness.session.messages.slice(0, changed!.length)).toEqual(changed);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			harness.setResponses([
				() => {
					expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
					return fauxAssistantMessage("next idle");
				},
			]);
			await harness.session.prompt("idle");
			expect(harness.eventsOfType("compaction_end").map((event) => event.errorMessage)).toEqual([
				expect.stringContaining("do not match"),
				expect.stringContaining("do not match"),
			]);
		},
	);

	it.each(["failure", "independent", "parent", "unsafe tool cut"] as const)(
		"bounds request-time %s and preserves cancellation ownership",
		async (kind) => {
			let started!: () => void;
			const ready = new Promise<void>((resolve) => {
				started = resolve;
			});
			let normal = 0;
			const tool: AgentTool = {
				name: "large",
				label: "Large",
				description: "large result",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "t".repeat(20000) }], details: {} }),
			};
			const harness = await seed({
				tools: [tool],
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							started();
							if (kind === "unsafe tool cut")
								return {
									compaction: {
										summary: "invalid cut",
										firstKeptEntryId: event.branchEntries.at(-1)!.id,
										tokensBefore: event.preparation.tokensBefore,
									},
								};
							if (kind === "parent" || kind === "independent")
								await new Promise<void>((resolve) =>
									event.signal.addEventListener("abort", () => resolve(), { once: true }),
								);
						});
					},
				],
			});
			const batch = () => {
				normal++;
				return fauxAssistantMessage([fauxToolCall("large", {})], { stopReason: "toolUse" });
			};
			harness.setResponses([
				batch,
				...(kind === "failure"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" })]
					: []),
				batch,
				async () => {
					normal++;
					await harness.session.followUp("queued after failed compaction");
					return fauxAssistantMessage("final");
				},
				() => {
					normal++;
					return fauxAssistantMessage("queued answer");
				},
			]);
			const prompt = harness.session.prompt("run");
			await ready;
			if (kind === "parent") await harness.session.abort();
			if (kind === "independent") harness.session.abortCompaction();
			await prompt;
			expect(normal).toBe(kind === "parent" ? 1 : 4);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				result: undefined,
				aborted: kind === "parent" || kind === "independent",
				errorMessage: expect.any(String),
			});
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it("bypasses the request hook during standalone summaries and delivers input queued during summarization once", async () => {
		let hookCalls = 0;
		const harness = await seed({
			extensionFactories: [],
			prepareRequest: () => {
				hookCalls++;
				return undefined;
			},
		});
		harness.setResponses([
			async () => {
				expect(hookCalls).toBe(2);
				expect(harness.session.isCompacting).toBe(true);
				await harness.session.followUp("during summary");
				return fauxAssistantMessage("standalone checkpoint");
			},
			(context) => {
				expect(hookCalls).toBe(2);
				expect(getMessageText(context.messages[0])).toContain("standalone checkpoint");
				expect(context.messages.some((message) => getMessageText(message) === "during summary")).toBe(false);
				return fauxAssistantMessage("first");
			},
			(context) => {
				expect(hookCalls).toBe(3);
				expect(context.messages.filter((message) => getMessageText(message) === "during summary")).toHaveLength(1);
				return fauxAssistantMessage("second");
			},
		]);
		await harness.session.prompt("p".repeat(20000));
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(4);
	});

	it.each(["tail", "branch", "compaction", "unsafe cut"] as const)(
		"validates selected history during asynchronous preparation: %s",
		async (kind) => {
			const harness = await seed({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async (event) => {
							await Promise.resolve();
							const manager = harness.sessionManager;
							if (kind === "tail") {
								manager.appendCustomMessageEntry("tail", "appended tail", false, { retained: true });
								harness.session.agent.state.messages.push({
									role: "custom",
									customType: "tail",
									content: "appended tail",
									display: false,
									details: { retained: true },
									timestamp: 1,
								});
							}
							if (kind === "branch") {
								manager.branch(manager.getBranch()[0].id);
								harness.session.agent.state.messages = manager.buildSessionContext().messages;
							}
							if (kind === "compaction") {
								manager.appendCompaction("concurrent checkpoint", event.preparation.firstKeptEntryId, 1);
								harness.session.agent.state.messages = manager.buildSessionContext().messages;
							}
							return {
								compaction: {
									summary: "scheduled checkpoint",
									firstKeptEntryId:
										kind === "unsafe cut"
											? event.branchEntries.at(-1)!.id
											: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			await harness.session.sendCustomMessage({ customType: "pending", content: "pending custom", display: false });
			harness.setResponses([
				(context) => {
					const event = harness.eventsOfType("compaction_end")[0];
					if (kind === "tail") {
						expect(event.errorMessage).toBeUndefined();
						expect(
							context.messages.filter((message) => getMessageText(message) === "appended tail"),
						).toHaveLength(1);
					} else
						expect(event.errorMessage).toContain(
							kind === "unsafe cut" ? "discard pending input" : "Selected session context changed",
						);
					if (kind !== "branch")
						expect(
							context.messages.filter((message) => getMessageText(message) === "pending custom"),
						).toHaveLength(1);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("p".repeat(20000));
			expect(harness.session.state.errorMessage).toBeUndefined();
			expect(harness.session.getLastAssistantText()).toBe("done");
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
				kind === "tail" || kind === "compaction" ? 1 : 0,
			);
		},
	);
});
