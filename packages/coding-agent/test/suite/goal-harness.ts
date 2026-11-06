import type { Context, Message } from "@diffexai/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { expect } from "vitest";
import { getMessageText, type Harness } from "./harness.ts";

// The plan specifies typed asynchronous controls without naming them.
// Adapt this boundary when the production API is named.
export interface GoalControls {
	readonly isGoalModeEnabled: boolean;
	setGoalModeEnabled(enabled: boolean): Promise<unknown>;
}

export function goalControls(harness: Harness): GoalControls {
	const controls = harness.session as unknown as GoalControls;
	expect(typeof controls.setGoalModeEnabled, "Goal mode SDK control is missing").toBe("function");
	expect(typeof controls.isGoalModeEnabled, "Goal mode SDK state is missing").toBe("boolean");
	return controls;
}

export function goalNotes(context: Context): string[] {
	return context.messages.map(getMessageText).filter((text) => /Context usage: approximately \d+%\./.test(text));
}

export function liveIds(context: Context): string[] {
	const blocks = context.messages.flatMap((message, index) => {
		if (message.role !== "user") return [];
		const text = getMessageText(message);
		const id = text.match(/^(?:Context usage: approximately \d+%\.[\s\S]*\n)?\[context (b\d+)\]$/)?.[1];
		const next = context.messages[index + 1];
		return id && next && !getMessageText(next).startsWith("Context usage:") ? [{ id, role: next.role, index }] : [];
	});
	const lastUser = blocks.findLast((block) => block.role === "user");
	const lastAssistant = blocks.findLast((block) => block.role === "assistant");
	return blocks.filter((block) => block !== lastUser && block !== lastAssistant).map((block) => block.id);
}

export function toolResult(context: Context, callId: string): Extract<Message, { role: "toolResult" }> {
	const result = context.messages.find(
		(message): message is Extract<Message, { role: "toolResult" }> =>
			message.role === "toolResult" && message.toolCallId === callId,
	);
	if (!result) throw new Error(`Missing tool result ${callId}`);
	return result;
}

/** Create a real archive through a model-originated tool call and the summarization pipeline. */
export async function compactPriorHistory(harness: Harness, summary: string, callId: string) {
	const requests: Context[] = [];
	const modelIds: string[] = [];
	const reasoning: Array<string | undefined> = [];
	let selected: string[] = [];
	harness.setResponses([
		(context, options, _state, model) => {
			requests.push(structuredClone(context));
			modelIds.push(model.id);
			reasoning.push(options?.reasoning);
			selected = liveIds(context);
			return fauxAssistantMessage(
				fauxToolCall(
					"compact_block",
					{ start_id: selected[0] ?? "missing", end_id: selected.at(-1) ?? "missing" },
					{ id: callId },
				),
				{ stopReason: "toolUse" },
			);
		},
		(context, options, _state, model) => {
			requests.push(structuredClone(context));
			modelIds.push(model.id);
			reasoning.push(options?.reasoning);
			return fauxAssistantMessage(summary);
		},
		(context, options, _state, model) => {
			requests.push(structuredClone(context));
			modelIds.push(model.id);
			reasoning.push(options?.reasoning);
			return fauxAssistantMessage("Compaction completed.");
		},
	]);
	await harness.session.prompt("Continue the task and preserve the earlier evidence.");
	expect(selected.length).toBeGreaterThan(0);
	expect(requests).toHaveLength(3);
	const result = toolResult(requests[2], callId);
	expect(result.isError).toBe(false);
	const archiveId = getMessageText(result).match(/ctx-\d+/)?.[0];
	if (!archiveId) throw new Error("Compaction did not produce an archive ID");
	return { archiveId, requests, selected, modelIds, reasoning };
}
