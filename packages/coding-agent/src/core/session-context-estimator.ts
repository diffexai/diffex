import { createHash } from "node:crypto";
import type { AgentContext } from "@diffexai/diffex-agent-core";
import { calculateContextTokens, estimateMessageTokens, estimateTextTokens } from "@diffexai/diffex-ai";
import type { AssistantMessage, Message, Model } from "@diffexai/diffex-ai/compat";
import { convertToLlm } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

interface RequestBaseline {
	configuration: string;
	prefix: string;
	messageCount: number;
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toolDefinitions(context: AgentContext) {
	return context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) ?? [];
}

function configuration(context: AgentContext, model: Model<string> | undefined): string {
	return fingerprint({ model, systemPrompt: context.systemPrompt, tools: toolDefinitions(context) });
}

/** In-memory request provenance; estimating never changes session or request state. */
export class SessionContextEstimator {
	private pending: RequestBaseline | undefined;
	private readonly responses = new WeakMap<AssistantMessage, RequestBaseline & { response: string }>();

	capture(context: AgentContext, model: Model<string> | undefined): void {
		const messages = convertToLlm(context.messages);
		this.pending = {
			configuration: configuration(context, model),
			prefix: fingerprint(messages),
			messageCount: messages.length,
		};
	}

	complete(message: AssistantMessage): void {
		if (this.pending) this.responses.set(message, { ...this.pending, response: fingerprint(message) });
		this.pending = undefined;
	}

	estimate(context: AgentContext, model: Model<string> | undefined, branch: SessionEntry[]): number {
		const messages = convertToLlm(context.messages);
		const eligible = new Set<AssistantMessage>();
		for (const entry of branch) {
			// Kept messages can appear after the summary in rebuilt context but were
			// generated before it. Only selected branch entry order proves eligibility.
			if (entry.type === "compaction") eligible.clear();
			else if (entry.type === "message" && entry.message.role === "assistant") eligible.add(entry.message);
		}
		const currentConfiguration = configuration(context, model);
		let trailingTokens = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message: Message = messages[i];
			if (message.role === "assistant" && eligible.has(message)) {
				const baseline = this.responses.get(message);
				const usageTokens = message.usage ? calculateContextTokens(message.usage) : 0;
				if (
					baseline &&
					message.stopReason !== "error" &&
					message.stopReason !== "aborted" &&
					usageTokens > 0 &&
					message.provider === model?.provider &&
					message.model === model.id &&
					baseline.configuration === currentConfiguration &&
					baseline.messageCount === i &&
					baseline.response === fingerprint(message) &&
					baseline.prefix === fingerprint(messages.slice(0, i))
				) {
					// Provider usage already includes this request's system prompt and tools.
					return usageTokens + trailingTokens;
				}
			}
			trailingTokens += estimateMessageTokens(message);
		}
		const tools = toolDefinitions(context);
		return (
			trailingTokens +
			estimateTextTokens(context.systemPrompt) +
			(tools.length > 0 ? estimateTextTokens(JSON.stringify(tools)) : 0)
		);
	}
}
