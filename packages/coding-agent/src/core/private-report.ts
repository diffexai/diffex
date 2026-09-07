import type { PrivateContinuation, StreamFn } from "@earendil-works/diffex-agent-core";
import type { Api, AssistantMessage, Context, Model, Tool } from "@earendil-works/diffex-ai";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/diffex-telemetry";

/** One private continuation, never routed through agent events or extension-instrumented transport. */
export function createPrivateReportContinuation(options: {
	context: Context;
	model: Model<Api>;
	stream: StreamFn;
	prompt: string;
	tool: Tool;
	consume: (message: AssistantMessage) => Promise<void>;
}): PrivateContinuation {
	return async (message, toolResults, signal) => {
		try {
			if (signal?.aborted) return;
			const deadline = AbortSignal.timeout(30_000);
			const privateSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
			const response = await options.stream(
				options.model,
				{
					systemPrompt: options.context.systemPrompt,
					messages: [
						...options.context.messages,
						...structuredClone([message, ...toolResults]),
						{ role: "user", content: options.prompt, timestamp: Date.now() },
					],
					tools: [options.tool],
				},
				{
					signal: privateSignal,
					telemetryContext: NOOP_TELEMETRY_CONTEXT,
					transport: "sse",
					cacheRetention: "none",
					maxTokens: 1024,
					timeoutMs: 30_000,
					maxRetries: 0,
				},
			);
			// Drain privately: no agent events, extension callbacks, or transcript writes.
			for await (const _event of response) {
				// Only the final response is eligible for validation.
			}
			const result = await response.result();
			if (!privateSignal.aborted) await options.consume(result);
		} catch {
			// Missing, failed, or malformed reports are not empty reports and never surface to the user.
		}
	};
}
