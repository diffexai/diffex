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
	completeAiRequestSpan,
	failAiRequestSpan,
	startAiSpan,
	startHarnessSpan,
	type TelemetryContext,
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
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
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

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
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
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	let turnSequence = 0;
	const telemetryContext = config.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
	const telemetryMetadata = config.telemetryMetadata ?? {
		laneName: "main",
		operationId: `legacy-run:${uuidv7()}`,
	};
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			const turnId = `${telemetryMetadata.operationId}:turn-${++turnSequence}`;
			const turnResult = await startHarnessSpan(
				telemetryContext,
				"diffex.harness.turn",
				{
					"diffex.lane.name": telemetryMetadata.laneName,
					"diffex.operation.id": telemetryMetadata.operationId,
					"diffex.turn.id": turnId,
				},
				async (turnSpan) => {
					try {
						return await executeAgentTurn(
							currentContext,
							newMessages,
							pendingMessages,
							config,
							signal,
							emit,
							streamFunction,
							{
								context: turnSpan,
								laneName: telemetryMetadata.laneName,
								operationId: telemetryMetadata.operationId,
								turnId,
							},
						);
					} catch (error) {
						turnSpan.setStatus({ status: "error" });
						throw error;
					}
				},
			);
			pendingMessages = [];
			hasMoreToolCalls = turnResult.hasMoreToolCalls;
			const { message, toolResults } = turnResult;

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
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
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
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

	await emit({ type: "agent_end", messages: newMessages });
}

interface ActiveTurnTelemetry {
	context: TelemetryContext;
	laneName: string;
	operationId: string;
	turnId: string;
}

interface AgentTurnResult {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	hasMoreToolCalls: boolean;
}

async function executeAgentTurn(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	pendingMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
	telemetry: ActiveTurnTelemetry,
): Promise<AgentTurnResult> {
	for (const pendingMessage of pendingMessages) {
		await emit({ type: "message_start", message: pendingMessage });
		await emit({ type: "message_end", message: pendingMessage });
		currentContext.messages.push(pendingMessage);
		newMessages.push(pendingMessage);
	}

	const message = await startHarnessSpan(
		telemetry.context,
		"diffex.harness.step",
		{
			"diffex.lane.name": telemetry.laneName,
			"diffex.operation.id": telemetry.operationId,
			"diffex.step.kind": "assistant",
			"diffex.step.attempt": 1,
		},
		async (stepSpan) => {
			try {
				const assistant = await streamAssistantResponse(
					currentContext,
					config,
					signal,
					emit,
					streamFunction,
					stepSpan,
				);
				if (assistant.stopReason === "error") {
					stepSpan.setAttributes({ "diffex.step.outcome": "failed" });
					stepSpan.setStatus({ status: "error" });
				} else if (assistant.stopReason === "aborted") {
					stepSpan.setAttributes({ "diffex.step.outcome": "aborted" });
				} else if (assistant.stopReason === "deferred") {
					stepSpan.setAttributes({ "diffex.step.outcome": "deferred" });
				} else {
					stepSpan.setAttributes({ "diffex.step.outcome": "succeeded" });
				}
				return assistant;
			} catch (error) {
				const aborted = signal?.aborted === true;
				stepSpan.setAttributes({ "diffex.step.outcome": aborted ? "aborted" : "failed" });
				stepSpan.setStatus({ status: aborted ? "ok" : "error" });
				throw error;
			}
		},
	);
	newMessages.push(message);

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		await emit({ type: "turn_end", message, toolResults: [] });
		return { message, toolResults: [], hasMoreToolCalls: false };
	}

	const toolCalls = message.content.filter((content) => content.type === "toolCall");
	const toolResults: ToolResultMessage[] = [];
	let hasMoreToolCalls = false;
	if (toolCalls.length > 0) {
		const executedToolBatch =
			message.stopReason === "length"
				? await failToolCallsFromTruncatedMessage(toolCalls, emit)
				: await executeToolCalls(currentContext, message, config, signal, emit, telemetry);
		toolResults.push(...executedToolBatch.messages);
		hasMoreToolCalls = !executedToolBatch.terminate;

		for (const result of toolResults) {
			currentContext.messages.push(result);
			newMessages.push(result);
		}
	}

	await emit({ type: "turn_end", message, toolResults });
	return { message, toolResults, hasMoreToolCalls };
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
	telemetryContext: TelemetryContext,
): Promise<AssistantMessage> {
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

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;
	const requestStartedAt = Date.now();
	return startAiSpan(
		telemetryContext,
		"diffex.ai.request",
		{
			"diffex.ai.operation": "stream",
			"diffex.ai.provider": config.model.provider,
			"diffex.ai.model": config.model.id,
			"diffex.ai.api": config.model.api,
			"diffex.ai.streaming": true,
		},
		async (requestSpan) => {
			let httpStatusCode: number | undefined;
			let chunkCount = 0;
			let timeToFirstChunkMs: number | undefined;
			try {
				const { telemetryMetadata: _telemetryMetadata, ...streamOptions } = config;
				const response = await streamFunction(config.model, llmContext, {
					...streamOptions,
					apiKey: resolvedApiKey,
					signal,
					telemetryContext: requestSpan,
					onResponse: async (providerResponse, model) => {
						httpStatusCode = providerResponse.status;
						await config.onResponse?.(providerResponse, model);
					},
				});

				let partialMessage: AssistantMessage | null = null;
				let addedPartial = false;

				for await (const event of response) {
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
							chunkCount += 1;
							timeToFirstChunkMs ??= Math.max(0, Date.now() - requestStartedAt);
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
							completeAiRequestSpan(requestSpan, finalMessage, {
								chunkCount,
								timeToFirstChunkMs,
								httpStatusCode,
							});
							return finalMessage;
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
				completeAiRequestSpan(requestSpan, finalMessage, {
					chunkCount,
					timeToFirstChunkMs,
					httpStatusCode,
				});
				return finalMessage;
			} catch (error) {
				failAiRequestSpan(requestSpan, classifyTelemetryError(error));
				throw error;
			}
		},
	);
}

function classifyTelemetryError(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") return "AbortError";
	if (error instanceof TypeError) return "TypeError";
	if (error instanceof Error) return "Error";
	return "NonError";
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
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
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
	telemetry: ActiveTurnTelemetry,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit, telemetry);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, telemetry);
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
	telemetry: ActiveTurnTelemetry,
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

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit, telemetry);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

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
	telemetry: ActiveTurnTelemetry,
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
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit, telemetry);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
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
	telemetry: ActiveTurnTelemetry,
): Promise<ExecutedToolCallOutcome> {
	return startHarnessSpan(
		telemetry.context,
		"diffex.harness.tool",
		{
			"diffex.lane.name": telemetry.laneName,
			"diffex.operation.id": telemetry.operationId,
			"diffex.turn.id": telemetry.turnId,
			"diffex.tool.name": prepared.toolCall.name,
			"diffex.tool.call_id": prepared.toolCall.id,
			"diffex.tool.replay": "never",
			"diffex.tool.recovery": false,
		},
		async (toolSpan) => {
			try {
				const updateEvents: Promise<void>[] = [];
				let acceptingUpdates = true;
				let outcome: ExecutedToolCallOutcome;

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
					outcome = { result, isError: false };
				} catch (error) {
					acceptingUpdates = false;
					await Promise.all(updateEvents);
					outcome = {
						result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
						isError: true,
					};
				} finally {
					acceptingUpdates = false;
				}

				toolSpan.setAttributes({ "diffex.tool.is_error": outcome.isError });
				if (outcome.isError) toolSpan.setStatus({ status: "error" });
				return outcome;
			} catch (error) {
				toolSpan.setAttributes({ "diffex.tool.is_error": true });
				toolSpan.setStatus({ status: "error" });
				throw error;
			}
		},
	);
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
