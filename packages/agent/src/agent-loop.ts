/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	uuidv7,
	validateToolArguments,
} from "@earendil-works/diffex-ai";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/diffex-telemetry";
import {
	type AgentRuntimeTelemetrySpan,
	type AiTelemetrySpan,
	startAgentRuntimeSpan,
	startAiSpan,
} from "./harness/telemetry.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrivateContinuation,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const invocationId = config.invocationId ?? uuidv7();
	return startAgentRuntimeSpan(
		config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
		"diffex.agent.run",
		{
			"diffex.invocation.id": invocationId,
			...(config.sessionId === undefined ? {} : { "diffex.session.id": config.sessionId }),
			"diffex.agent.run_kind": "prompt",
		},
		async (span) => {
			const newMessages: AgentMessage[] = [...prompts];
			const currentContext: AgentContext = {
				...context,
				messages: [...context.messages, ...prompts],
			};
			const instrumentedConfig = { ...config, telemetryContext: span, invocationId };

			try {
				await emit({ type: "agent_start" });
				await emit({ type: "turn_start" });
				for (const prompt of prompts) {
					await emit({ type: "message_start", message: prompt });
					await emit({ type: "message_end", message: prompt });
				}

				const turnCount = await runLoop(
					currentContext,
					newMessages,
					instrumentedConfig,
					signal,
					emit,
					streamFn ?? getDefaultStreamFn(),
				);
				settleAgentRunSpan(span, newMessages, turnCount);
				return newMessages;
			} catch (error) {
				span.setAttributes({ "diffex.agent.outcome": signal?.aborted ? "aborted" : "failed" });
				span.setStatus({ status: "error" });
				throw error;
			}
		},
	);
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const invocationId = config.invocationId ?? uuidv7();
	return startAgentRuntimeSpan(
		config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
		"diffex.agent.run",
		{
			"diffex.invocation.id": invocationId,
			...(config.sessionId === undefined ? {} : { "diffex.session.id": config.sessionId }),
			"diffex.agent.run_kind": "continue",
		},
		async (span) => {
			const newMessages: AgentMessage[] = [];
			const currentContext: AgentContext = { ...context };
			const instrumentedConfig = { ...config, telemetryContext: span, invocationId };

			try {
				await emit({ type: "agent_start" });
				await emit({ type: "turn_start" });
				const turnCount = await runLoop(
					currentContext,
					newMessages,
					instrumentedConfig,
					signal,
					emit,
					streamFn ?? getDefaultStreamFn(),
				);
				settleAgentRunSpan(span, newMessages, turnCount);
				return newMessages;
			} catch (error) {
				span.setAttributes({ "diffex.agent.outcome": signal?.aborted ? "aborted" : "failed" });
				span.setStatus({ status: "error" });
				throw error;
			}
		},
	);
}

function getAgentOutcome(messages: AgentMessage[]): "completed" | "failed" | "aborted" {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return "failed";
		return "completed";
	}
	return "completed";
}

function settleAgentRunSpan(
	span: AgentRuntimeTelemetrySpan<"diffex.agent.run">,
	messages: AgentMessage[],
	turnCount: number,
): void {
	const outcome = getAgentOutcome(messages);
	span.setAttributes({
		"diffex.agent.outcome": outcome,
		"diffex.agent.turn_count": turnCount,
	});
	if (outcome !== "completed") {
		span.setStatus({ status: "error" });
	}
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<number> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	let turnIndex = 0;
	let deferredPrivateContinuation: DeferredPrivateContinuation | undefined;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			const turnId = uuidv7();
			const runTelemetryContext = config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
			const result = await startAgentRuntimeSpan(
				runTelemetryContext,
				"diffex.agent.turn",
				{
					"diffex.invocation.id": config.invocationId ?? uuidv7(),
					"diffex.turn.id": turnId,
					"diffex.turn.index": turnIndex,
				},
				(span) =>
					runTurn({
						currentContext,
						newMessages,
						config: { ...config, telemetryContext: span, turnId },
						signal,
						emit,
						streamFunction,
						pendingMessages,
						firstTurn,
						span,
					}),
			);
			turnIndex++;
			firstTurn = false;
			currentContext = result.currentContext;
			config = { ...result.config, telemetryContext: runTelemetryContext, turnId: undefined };
			pendingMessages = result.pendingMessages;
			hasMoreToolCalls = result.hasMoreToolCalls;
			if (result.deferredPrivateContinuation) {
				deferredPrivateContinuation = result.deferredPrivateContinuation;
			}
			if (result.discardDeferredPrivateContinuation) {
				deferredPrivateContinuation = undefined;
			}
			if (result.ended) {
				await settlePrivateContinuation(deferredPrivateContinuation, signal);
				await emit({ type: "agent_end", messages: newMessages });
				return turnIndex;
			}
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await settlePrivateContinuation(deferredPrivateContinuation, signal);
	await emit({ type: "agent_end", messages: newMessages });
	return turnIndex;
}

interface RunTurnOptions {
	currentContext: AgentContext;
	newMessages: AgentMessage[];
	config: AgentLoopConfig;
	signal: AbortSignal | undefined;
	emit: AgentEventSink;
	streamFunction: StreamFn;
	pendingMessages: AgentMessage[];
	firstTurn: boolean;
	span: AgentRuntimeTelemetrySpan<"diffex.agent.turn">;
}

interface DeferredPrivateContinuation {
	continuation?: PrivateContinuation;
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
}

interface RunTurnResult {
	currentContext: AgentContext;
	config: AgentLoopConfig;
	pendingMessages: AgentMessage[];
	hasMoreToolCalls: boolean;
	ended: boolean;
	deferredPrivateContinuation?: DeferredPrivateContinuation;
	discardDeferredPrivateContinuation?: boolean;
}

async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
	let { currentContext, config, pendingMessages } = options;
	if (!options.firstTurn) {
		await options.emit({ type: "turn_start" });
	}

	if (pendingMessages.length > 0) {
		for (const message of pendingMessages) {
			await options.emit({ type: "message_start", message });
			await options.emit({ type: "message_end", message });
			currentContext.messages.push(message);
			options.newMessages.push(message);
		}
		pendingMessages = [];
	}

	const { message, privateContinuation } = await streamAssistantResponse(
		currentContext,
		config,
		options.signal,
		options.emit,
		options.streamFunction,
	);
	options.newMessages.push(message);
	const outcome =
		message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "failed" : "completed";
	options.span.setAttributes({ "diffex.agent.outcome": outcome });
	if (outcome !== "completed") {
		options.span.setStatus({ status: "error" });
		await options.emit({ type: "turn_end", message, toolResults: [] });
		return {
			currentContext,
			config,
			pendingMessages,
			hasMoreToolCalls: false,
			ended: true,
			discardDeferredPrivateContinuation: true,
		};
	}

	const toolCalls = message.content.filter((content) => content.type === "toolCall");
	const toolResults: ToolResultMessage[] = [];
	let hasMoreToolCalls = false;
	if (toolCalls.length > 0) {
		const executedToolBatch =
			message.stopReason === "length"
				? await failToolCallsFromTruncatedMessage(toolCalls, config, options.signal, options.emit)
				: await executeToolCalls(currentContext, message, config, options.signal, options.emit);
		toolResults.push(...executedToolBatch.messages);
		hasMoreToolCalls = !executedToolBatch.terminate;
		for (const result of toolResults) {
			currentContext.messages.push(result);
			options.newMessages.push(result);
		}
	}

	const deferredPrivateContinuation =
		config.privateContinuationMode === "per-turn"
			? { continuation: privateContinuation, message, toolResults }
			: undefined;
	if (config.privateContinuationMode !== "per-turn") {
		await settlePrivateContinuation({ continuation: privateContinuation, message, toolResults }, options.signal);
	}

	await options.emit({ type: "turn_end", message, toolResults });
	const nextTurnContext = {
		message,
		toolResults,
		context: currentContext,
		newMessages: options.newMessages,
	};
	const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
	if (nextTurnSnapshot) {
		currentContext = nextTurnSnapshot.context ?? currentContext;
		config = {
			...config,
			model: nextTurnSnapshot.model ?? config.model,
			reasoning:
				nextTurnSnapshot.thinkingLevel === undefined
					? config.reasoning
					: nextTurnSnapshot.thinkingLevel === "off"
						? undefined
						: nextTurnSnapshot.thinkingLevel,
		};
	}

	if (
		await config.shouldStopAfterTurn?.({
			message,
			toolResults,
			context: currentContext,
			newMessages: options.newMessages,
		})
	) {
		return {
			currentContext,
			config,
			pendingMessages,
			hasMoreToolCalls,
			ended: true,
			deferredPrivateContinuation,
		};
	}

	pendingMessages = (await config.getSteeringMessages?.()) || [];
	return {
		currentContext,
		config,
		pendingMessages,
		hasMoreToolCalls,
		ended: false,
		deferredPrivateContinuation,
	};
}

async function settlePrivateContinuation(
	deferred: DeferredPrivateContinuation | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	try {
		await deferred?.continuation?.(deferred.message, deferred.toolResults, signal);
	} catch {
		// Private assessment failures must never enter transcript, events, or trace errors.
	}
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<{ message: AssistantMessage; privateContinuation?: PrivateContinuation }> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	let privateContinuation: PrivateContinuation | undefined;
	try {
		privateContinuation = config.preparePrivateContinuation?.(
			{ ...llmContext, messages: structuredClone(llmContext.messages) },
			config.model,
		);
	} catch {
		// A missing or invalid private binding does not affect the main request.
	}

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const requestId = uuidv7();
	return startAiSpan(
		config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
		"diffex.ai.request",
		{
			...(config.invocationId === undefined ? {} : { "diffex.invocation.id": config.invocationId }),
			...(config.turnId === undefined ? {} : { "diffex.turn.id": config.turnId }),
			"diffex.request.id": requestId,
			"diffex.ai.operation": "stream",
			"diffex.ai.provider": config.model.provider,
			"diffex.ai.model": config.model.id,
			"diffex.ai.api": config.model.api,
			"diffex.ai.streaming": true,
		},
		async (span) => {
			const startedAt = performance.now();
			let firstChunkAt: number | undefined;
			let chunkCount = 0;
			const response = await streamFunction(config.model, llmContext, {
				...config,
				apiKey: resolvedApiKey,
				signal,
				telemetryContext: span,
			});

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;

			for await (const event of response) {
				chunkCount++;
				firstChunkAt ??= performance.now();
				switch (event.type) {
					case "start":
						partialMessage = event.partial;
						context.messages.push(partialMessage);
						addedPartial = true;
						await emit({ type: "message_start", message: { ...partialMessage } });
						break;

					case "text_start":
					case "text_delta":
					case "text_end":
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						if (partialMessage) {
							partialMessage = event.partial;
							context.messages[context.messages.length - 1] = partialMessage;
							await emit({
								type: "message_update",
								assistantMessageEvent: event,
								message: { ...partialMessage },
							});
						}
						break;

					case "done":
					case "error": {
						const finalMessage = await response.result();
						if (addedPartial) {
							context.messages[context.messages.length - 1] = finalMessage;
						} else {
							context.messages.push(finalMessage);
						}
						if (!addedPartial) {
							await emit({ type: "message_start", message: { ...finalMessage } });
						}
						await emit({ type: "message_end", message: finalMessage });
						settleAiRequestSpan(span, finalMessage, chunkCount, startedAt, firstChunkAt);
						return { message: finalMessage, privateContinuation };
					}
				}
			}

			const finalMessage = await response.result();
			if (addedPartial) {
				context.messages[context.messages.length - 1] = finalMessage;
			} else {
				context.messages.push(finalMessage);
				await emit({ type: "message_start", message: { ...finalMessage } });
			}
			await emit({ type: "message_end", message: finalMessage });
			settleAiRequestSpan(span, finalMessage, chunkCount, startedAt, firstChunkAt);
			return { message: finalMessage, privateContinuation };
		},
	);
}

function settleAiRequestSpan(
	span: AiTelemetrySpan<"diffex.ai.request">,
	message: AssistantMessage,
	chunkCount: number,
	startedAt: number,
	firstChunkAt: number | undefined,
): void {
	const stopReason =
		message.stopReason === "pending" ? undefined : message.stopReason === "toolUse" ? "tool_use" : message.stopReason;
	span.setAttributes({
		...(message.responseModel === undefined ? {} : { "diffex.ai.response.model": message.responseModel }),
		...(message.responseId === undefined ? {} : { "diffex.ai.response.id": message.responseId }),
		...(stopReason === undefined ? {} : { "diffex.ai.response.stop_reason": stopReason }),
		"diffex.ai.usage.input_tokens": message.usage.input,
		"diffex.ai.usage.output_tokens": message.usage.output,
		"diffex.ai.usage.cache_read_tokens": message.usage.cacheRead,
		"diffex.ai.usage.cache_write_tokens": message.usage.cacheWrite,
		...(message.usage.reasoning === undefined ? {} : { "diffex.ai.usage.reasoning_tokens": message.usage.reasoning }),
		"diffex.ai.usage.total_tokens": message.usage.totalTokens,
		"diffex.ai.usage.cost": message.usage.cost.total,
		"diffex.ai.stream.chunk_count": chunkCount,
		...(firstChunkAt === undefined ? {} : { "diffex.ai.stream.time_to_first_chunk_ms": firstChunkAt - startedAt }),
		...(message.stopReason === "error" ? { "diffex.ai.error.type": "AssistantMessageError" } : {}),
	});
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		span.setStatus({ status: "error" });
	}
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized = await withToolSpan(config, signal, toolCall, async () => ({
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		}));
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const finalized = await withToolSpan(config, signal, toolCall, async () => {
			const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
			if (preparation.kind === "immediate") {
				return {
					toolCall,
					result: preparation.result,
					isError: preparation.isError,
				};
			}
			const executed = await executePreparedToolCall(preparation, signal, emit);
			return finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
		});

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = await withToolSpan(config, signal, toolCall, async () => ({
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			}));
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const finalized = await withToolSpan(config, signal, toolCall, async () => {
				const executed = await executePreparedToolCall(preparation, signal, emit);
				return finalizeExecutedToolCall(currentContext, assistantMessage, preparation, executed, config, signal);
			});
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

async function withToolSpan(
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	toolCall: AgentToolCall,
	run: () => Promise<FinalizedToolCallOutcome>,
): Promise<FinalizedToolCallOutcome> {
	return startAgentRuntimeSpan(
		config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
		"diffex.agent.tool",
		{
			"diffex.invocation.id": config.invocationId ?? uuidv7(),
			"diffex.turn.id": config.turnId ?? uuidv7(),
			"diffex.tool.call_id": toolCall.id,
			"diffex.tool.name": toolCall.name,
		},
		async (span) => {
			const finalized = await run();
			const outcome = finalized.isError ? (signal?.aborted ? "aborted" : "failed") : "completed";
			span.setAttributes({
				"diffex.tool.is_error": finalized.isError,
				"diffex.tool.outcome": outcome,
			});
			if (finalized.isError) span.setStatus({ status: "error" });
			return finalized;
		},
	);
}

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
