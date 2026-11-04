import type { AgentMessage } from "@diffexai/diffex-agent-core";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@diffexai/diffex-ai";
import { GOAL_ARCHIVE_CATALOG_TYPE, GOAL_LABEL_TYPE, GOAL_NOTE_TYPE, GOAL_SUMMARY_TYPE } from "./pocket-context.ts";

/** Project defined evidence fields, never provider records or arbitrary runtime details. */
export function goalEvidence(message: AgentMessage, images: ImageContent[]): Record<string, unknown> | undefined {
	const content = (value: string | Array<TextContent | ThinkingContent | ToolCall | ImageContent>) =>
		typeof value === "string"
			? value
			: value.map((part) => {
					switch (part.type) {
						case "text":
							return { type: "text", text: part.text };
						case "thinking":
							return { type: "thinking", thinking: part.thinking, ...(part.redacted ? { redacted: true } : {}) };
						case "toolCall":
							return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
						case "image":
							images.push({ type: "image", data: part.data, mimeType: part.mimeType });
							return { type: "image", image_index: images.length - 1, mimeType: part.mimeType };
						default:
							throw new Error("Unsupported archived content type.");
					}
				});
	switch (message.role) {
		case "user":
			return { role: message.role, content: content(message.content) };
		case "assistant":
			return {
				role: message.role,
				content: content(message.content),
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
			};
		case "toolResult":
			return {
				role: message.role,
				tool: message.toolName,
				call_id: message.toolCallId,
				is_error: message.isError,
				content: content(message.content),
			};
		case "custom": {
			if ([GOAL_NOTE_TYPE, GOAL_ARCHIVE_CATALOG_TYPE, GOAL_LABEL_TYPE].includes(message.customType))
				return undefined;
			const details = message.details;
			const archiveId =
				message.customType === GOAL_SUMMARY_TYPE &&
				typeof details === "object" &&
				details !== null &&
				"archiveId" in details &&
				typeof details.archiveId === "string"
					? details.archiveId
					: undefined;
			return {
				role: message.role,
				customType: message.customType,
				archive_id: archiveId,
				content: content(message.content),
			};
		}
		case "bashExecution":
			if (message.excludeFromContext) return undefined;
			return {
				role: message.role,
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				fullOutputPath: message.fullOutputPath,
			};
		case "branchSummary":
			return { role: message.role, summary: message.summary, fromId: message.fromId };
		case "compactionSummary":
			return { role: message.role, summary: message.summary };
	}
}
