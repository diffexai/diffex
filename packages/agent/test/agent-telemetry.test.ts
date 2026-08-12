import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	Agent,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	runAgentLoop,
} from "../src/index.ts";

class ControlledAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event");
			},
		);
	}
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 3,
			output: 2,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

const TEST_MODEL = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
} satisfies Model<"openai-responses">;

function directLoopConfig(telemetryContext: InMemoryTelemetryContext): AgentLoopConfig {
	return {
		model: TEST_MODEL,
		telemetryContext,
		convertToLlm: (messages) =>
			messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
	};
}

describe("legacy Agent telemetry", () => {
	it("assigns a unique operation id to each direct low-level loop", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = (): AgentContext => ({ systemPrompt: "", messages: [], tools: [] });
		const prompt = (): AgentMessage => ({ role: "user", content: "hello", timestamp: Date.now() });
		const streamFn = () => {
			const stream = new ControlledAssistantStream();
			queueMicrotask(() => {
				const message = assistantMessage([{ type: "text", text: "ok" }], "stop");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		await runAgentLoop([prompt()], context(), directLoopConfig(telemetry), () => {}, undefined, streamFn);
		await runAgentLoop([prompt()], context(), directLoopConfig(telemetry), () => {}, undefined, streamFn);

		const operationIds = telemetry
			.getSpans()
			.filter((span) => span.name === "pi.harness.turn")
			.map((span) => span.attributes["pi.operation.id"]);
		expect(operationIds).toHaveLength(2);
		expect(operationIds[0]).toMatch(/^legacy-run:/);
		expect(operationIds[1]).toMatch(/^legacy-run:/);
		expect(new Set(operationIds)).toHaveLength(2);
	});

	it("keeps the AI request span open through stream consumption", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const stream = new ControlledAssistantStream();
		const agent = new Agent({
			telemetryContext: telemetry,
			sessionId: "session-1",
			streamFn: (_model, _context, options) => {
				expect(options?.telemetryContext).toBeDefined();
				return stream;
			},
		});

		const prompt = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const openRequest = telemetry.getSpans().find((span) => span.name === "pi.ai.request");
		expect(openRequest?.settled).toBe(false);

		const message = assistantMessage([{ type: "text", text: "ok" }], "stop");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		await prompt;

		const spans = telemetry.getSpans();
		const run = spans.find((span) => span.name === "pi.harness.run");
		const turn = spans.find((span) => span.name === "pi.harness.turn");
		const step = spans.find((span) => span.name === "pi.harness.step");
		const request = spans.find((span) => span.name === "pi.ai.request");
		expect(run?.attributes["pi.operation.id"]).toMatch(/^session-1:[^:]+:run-1$/);
		expect(turn?.parentId).toBe(run?.id);
		expect(step?.parentId).toBe(turn?.id);
		expect(request?.parentId).toBe(step?.id);
		expect(request?.attributes).toMatchObject({
			"pi.ai.response.stop_reason": "stop",
			"pi.ai.usage.total_tokens": 6,
			"pi.ai.stream.chunk_count": 1,
		});
		expect(request?.settled).toBe(true);
	});

	it("records phase-2 tool failures without arguments or results", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let request = 0;
		const agent = new Agent({
			telemetryContext: telemetry,
			sessionId: "session-tools",
			streamFn: () => {
				const stream = new ControlledAssistantStream();
				queueMicrotask(() => {
					request += 1;
					const message =
						request === 1
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: "call-secret",
											name: "lookup",
											arguments: { secret: "do-not-trace" },
										},
									],
									"toolUse",
								)
							: assistantMessage([{ type: "text", text: "done" }], "stop");
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const tool: AgentTool = {
			name: "lookup",
			label: "Lookup",
			description: "Lookup",
			parameters: Type.Object({ secret: Type.String() }),
			execute: async () => {
				throw new Error("secret result");
			},
		};
		agent.state.tools = [tool];

		await agent.prompt("run tool");

		const span = telemetry.getSpans().find((candidate) => candidate.name === "pi.harness.tool");
		expect(span?.attributes).toMatchObject({
			"pi.tool.name": "lookup",
			"pi.tool.is_error": true,
		});
		expect(JSON.stringify(span)).not.toContain("do-not-trace");
		expect(JSON.stringify(span)).not.toContain("secret result");
	});

	it("does not retain free-form listener errors from awaited tool updates", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const agent = new Agent({
			telemetryContext: telemetry,
			sessionId: "session-updates",
			streamFn: () => {
				const stream = new ControlledAssistantStream();
				queueMicrotask(() => {
					const message = assistantMessage(
						[
							{
								type: "toolCall",
								id: "call-update",
								name: "update",
								arguments: {},
							},
						],
						"toolUse",
					);
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});
		agent.state.tools = [
			{
				name: "update",
				label: "Update",
				description: "Update",
				parameters: Type.Object({}),
				execute: async (_toolCallId, _params, _signal, onUpdate) => {
					onUpdate?.({ content: [{ type: "text", text: "private partial" }], details: {} });
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			},
		];
		agent.subscribe((event) => {
			if (event.type === "tool_execution_update") throw new Error("private listener failure");
		});

		await agent.prompt("run tool update");

		const toolSpan = telemetry.getSpans().find((span) => span.name === "pi.harness.tool");
		expect(toolSpan?.status).toEqual({ status: "error" });
		expect(toolSpan?.attributes["pi.tool.is_error"]).toBe(true);
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private listener failure");
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private partial");
	});
});
