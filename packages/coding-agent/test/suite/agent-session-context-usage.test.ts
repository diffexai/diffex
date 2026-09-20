import type { AgentContext, AgentMessage } from "@diffexai/diffex-agent-core";
import {
	calculateContextTokens,
	estimateMessageTokens,
	estimateTextTokens,
	fauxAssistantMessage,
} from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionContextEstimator } from "../../src/core/session-context-estimator.ts";
import { createHarness, type Harness } from "./harness.ts";

function localTokens(harness: Harness): number {
	const { systemPrompt, tools, messages } = harness.session.agent.state;
	const definitions = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	return (
		convertToLlm(messages).reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
		estimateTextTokens(systemPrompt) +
		(definitions.length ? estimateTextTokens(JSON.stringify(definitions)) : 0)
	);
}

function append(harness: Harness, message: AgentMessage): void {
	harness.session.agent.state.messages.push(message);
	if (message.role === "compactionSummary" || message.role === "branchSummary") throw new Error("Use summary entries");
	harness.sessionManager.appendMessage(message);
}

describe("AgentSession current context accounting", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	async function start(): Promise<Harness> {
		const harness = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer", { timestamp: 1 })]);
		await harness.session.prompt("hello");
		return harness;
	}

	it("uses captured provider usage once, then estimates later normal context without side effects", async () => {
		const harness = await start();
		const assistant = harness.session.messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("Missing response");
		const usage = calculateContextTokens(assistant.usage);
		expect(harness.session.getContextUsage()?.tokens).toBe(usage);
		const trailing: AgentMessage[] = [
			{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 0 },
			{ role: "custom", customType: "hidden", content: "hidden context", display: false, timestamp: 0 },
			{
				role: "bashExecution",
				command: "echo hello",
				output: "hello",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 0,
			},
			{
				role: "bashExecution",
				command: "ignored",
				output: "x".repeat(10000),
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "file content" }],
				isError: false,
				timestamp: 0,
			},
		];
		for (const message of trailing) append(harness, message);
		const expected = usage + convertToLlm(trailing).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		const before = JSON.stringify(harness.sessionManager.getEntries());
		for (let i = 0; i < 3; i++) expect(harness.session.getContextUsage()?.tokens).toBe(expected);
		expect(harness.session.getSessionStats().contextUsage?.tokens).toBe(expected);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toBe(before);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["window", "system", "tools", "prefix", "model"])(
		"falls back locally when the %s baseline changes",
		async (change) => {
			const harness = await start();
			const state = harness.session.agent.state;
			if (change === "window") state.model = { ...state.model, contextWindow: state.model.contextWindow / 2 };
			if (change === "system") state.systemPrompt += " extra instructions";
			if (change === "tools")
				state.tools = state.tools.map((tool, i) =>
					i === 0 ? { ...tool, description: "new schema description" } : tool,
				);
			if (change === "prefix") state.messages[0] = { role: "user", content: "edited prompt", timestamp: 0 };
			if (change === "model") state.model = { ...state.model, id: "another-model" };
			expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness));
			expect(harness.session.getContextUsage()?.contextWindow).toBe(state.model.contextWindow);
		},
	);

	it("uses selected branch order across compaction despite equal or older response timestamps", async () => {
		const harness = await start();
		const firstId = harness.sessionManager.getBranch()[0].id;
		const oldAssistant = harness.session.messages.at(-1);
		if (oldAssistant?.role !== "assistant") throw new Error("Missing response");
		const oldUsage = calculateContextTokens(oldAssistant.usage);
		harness.sessionManager.appendCompaction("summary", firstId, oldUsage);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness));
		expect(harness.session.getContextUsage()?.tokens).not.toBeNull();
		harness.setResponses([fauxAssistantMessage("new answer", { timestamp: 1 })]);
		await harness.session.prompt("next");
		const assistant = harness.session.messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("Missing new response");
		expect(harness.session.getContextUsage()?.tokens).toBe(calculateContextTokens(assistant.usage));
		const stats = harness.session.getSessionStats();
		expect(stats.tokens.total).toBe(oldUsage + calculateContextTokens(assistant.usage));
	});

	it("ignores sibling usage and estimates loaded branch and compaction summaries locally", async () => {
		const harness = await start();
		const firstId = harness.sessionManager.getBranch()[0].id;
		harness.sessionManager.branchWithSummary(firstId, "branch summary");
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness));
		const assistant = fauxAssistantMessage("loaded response");
		assistant.provider = harness.getModel().provider;
		assistant.model = harness.getModel().id;
		assistant.usage = { ...assistant.usage, input: 900000, totalTokens: 900000 };
		append(harness, assistant);
		expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness));
	});

	it.each(["error", "aborted", "stop"] as const)(
		"keeps earlier usage plus later content after an ineligible %s response",
		async (stopReason) => {
			const harness = await start();
			const assistant = harness.session.messages.at(-1);
			if (assistant?.role !== "assistant") throw new Error("Missing response");
			const trailing = fauxAssistantMessage("partial", { stopReason });
			append(harness, trailing);
			expect(harness.session.getContextUsage()?.tokens).toBe(
				calculateContextTokens(assistant.usage) + estimateMessageTokens(trailing),
			);
		},
	);

	it.each(["zero", "missing", "error", "aborted"] as const)(
		"estimates all context locally for captured %s usage",
		async (kind) => {
			const harness = await start();
			const estimator = new SessionContextEstimator();
			const state = harness.session.agent.state;
			state.messages = state.messages.slice(0, -1);
			estimator.capture(state, state.model);
			const response = fauxAssistantMessage("partial", {
				stopReason: kind === "error" || kind === "aborted" ? kind : "stop",
			});
			response.provider = state.model.provider;
			response.model = state.model.id;
			if (kind === "missing") Reflect.deleteProperty(response, "usage");
			else if (kind !== "zero") response.usage = { ...response.usage, input: 900000, totalTokens: 900000 };
			estimator.complete(response);
			append(harness, response);
			expect(estimator.estimate(state, state.model, harness.sessionManager.getBranch())).toBe(localTokens(harness));
		},
	);

	it.each([undefined, 100])(
		"shares strict threshold accounting with the footer (reserve override: %s)",
		async (reserveOverride) => {
			const harness = await start();
			const internals = harness.session as unknown as {
				_checkCompaction(message: undefined, skipAbortedCheck: boolean): Promise<boolean>;
				_runAutoCompaction(reason: string, willRetry: boolean): Promise<boolean>;
			};
			const compact = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(false);
			harness.settingsManager.applyOverrides({
				compaction: { enabled: true, ...(reserveOverride === undefined ? {} : { reserveTokens: reserveOverride }) },
			});
			const reserve = harness.settingsManager.getCompactionSettings().reserveTokens;
			expect(reserve).toBe(reserveOverride ?? 16384);
			const tokens = localTokens(harness);
			const state = harness.session.agent.state;
			state.model = { ...state.model, contextWindow: tokens + reserve };
			expect(harness.session.getContextUsage()?.tokens).toBe(tokens);
			await internals._checkCompaction(undefined, false);
			expect(compact).not.toHaveBeenCalled();
			state.model = { ...state.model, contextWindow: tokens + reserve - 1 };
			await internals._checkCompaction(undefined, false);
			expect(compact).toHaveBeenCalledWith("threshold", false, undefined, undefined);
			compact.mockClear();
			for (const contextWindow of [0, -1]) {
				state.model = { ...state.model, contextWindow };
				await internals._checkCompaction(undefined, false);
				expect(harness.session.getContextUsage()).toBeUndefined();
			}
			state.model = { ...state.model, contextWindow: 1 };
			harness.settingsManager.applyOverrides({ compaction: { enabled: false } });
			await internals._checkCompaction(undefined, false);
			expect(compact).not.toHaveBeenCalled();
		},
	);

	it("falls back when a request hook changes the public model after request selection", async () => {
		let session: Harness["session"] | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			prepareRequest: () => {
				if (!session) throw new Error("Missing session");
				const model = session.agent.state.model;
				session.agent.state.model = { ...model, contextWindow: model.contextWindow / 2 };
				return undefined;
			},
		});
		harnesses.push(harness);
		session = harness.session;
		harness.setResponses([
			(_context, _options, _state, model) => {
				expect(model.contextWindow).toBe(harness.getModel().contextWindow);
				return fauxAssistantMessage("answer");
			},
		]);
		await session.prompt("hello");
		expect(session.getContextUsage()?.tokens).toBe(localTokens(harness));
		expect(session.getContextUsage()?.contextWindow).toBe(harness.getModel().contextWindow / 2);
	});

	it.each(["agent_start", "message_end", "turn_start", "next_turn"] as const)(
		"rejects a model baseline changed during %s admission",
		async (eventType) => {
			const harness = await createHarness({ settings: { compaction: { enabled: false } } });
			harnesses.push(harness);
			const originalWindow = harness.getModel().contextWindow;
			let changed = false;
			let turns = 0;
			harness.session.subscribe((event) => {
				if (event.type === "turn_start") turns++;
				if (!changed && (event.type === eventType || (eventType === "next_turn" && turns === 2))) {
					changed = true;
					harness.session.agent.state.model = { ...harness.getModel(), contextWindow: originalWindow / 2 };
				}
			});
			harness.setResponses([
				async (_context, _options, _state, model) => {
					expect(model.contextWindow).toBe(originalWindow);
					if (eventType === "next_turn") await harness.session.followUp("follow up");
					return fauxAssistantMessage("answer");
				},
				(_context, _options, _state, model) => {
					expect(model.contextWindow).toBe(originalWindow);
					return fauxAssistantMessage("next answer");
				},
			]);
			await harness.session.prompt("hello");
			expect(changed).toBe(true);
			expect(harness.faux.state.callCount).toBe(eventType === "next_turn" ? 2 : 1);
			expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
			expect(harness.session.getContextUsage()?.tokens).toBe(localTokens(harness));
		},
	);

	it("composes request preparation and never reruns request-only transforms while estimating", async () => {
		const prepareRequest = vi.fn((context: AgentContext) => ({
			...context,
			messages: [...context.messages, { role: "user" as const, content: "prepared", timestamp: 1 }],
		}));
		let contextCalls = 0;
		const harness = await createHarness({
			prepareRequest,
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => {
						contextCalls++;
						return { messages: [...event.messages, { role: "user", content: "request only", timestamp: 1 }] };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				expect(context.messages.at(-2)).toMatchObject({ role: "user", content: "prepared" });
				expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "request only" });
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("hello");
		const assistant = harness.session.messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("Missing response");
		for (let i = 0; i < 3; i++)
			expect(harness.session.getContextUsage()?.tokens).toBe(calculateContextTokens(assistant.usage));
		expect(prepareRequest).toHaveBeenCalledTimes(1);
		expect(contextCalls).toBe(1);
		expect(JSON.stringify(harness.session.messages)).not.toContain("request only");
	});
});
