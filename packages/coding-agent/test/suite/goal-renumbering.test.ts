import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { expect, it } from "vitest";
import { readGoalArchives, validateGoalProvenance } from "../../src/core/pocket-context.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText } from "./harness.ts";

function marker(context: Context, text: string): string {
	const index = context.messages.findIndex((message) => getMessageText(message) === text);
	expect(index).toBeGreaterThan(0);
	return getMessageText(context.messages[index - 1]).match(/\[context (b\d+)\]/)![1];
}

function markers(context: Context): string[] {
	return context.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		const id = getMessageText(message).match(/\[context (b\d+)\]$/)?.[1];
		return id ? [id] : [];
	});
}

it("renumbers visible blocks after nested compaction and recalls stable archives after restart and fork", async () => {
	const manager = SessionManager.inMemory();
	const first = `Receipt cobalt739: owner Mira. ${"record ".repeat(6_000)}`;
	const second = `Receipt emerald840: owner Arun. ${"evidence ".repeat(12_000)}`;
	for (const text of ["Unchanged prefix.", first, second]) {
		manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("Recorded."));
	}
	const harness = await createHarness({
		sessionManager: manager,
		models: [{ id: "goal", contextWindow: 60_000, maxTokens: 1_024 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	try {
		harness.session.agent.state.messages = manager.buildSessionContext().messages;
		await harness.session.setGoalModeEnabled(true);
		const requests: Context[] = [];
		const calls: Array<{ start_id: string; end_id: string }> = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				calls.push({ start_id: marker(context, first), end_id: "b004" });
				return fauxAssistantMessage(fauxToolCall("compact_block", calls[0], { id: "first" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("First receipt recorded."),
			(context) => {
				requests.push(structuredClone(context));
				calls.push({
					start_id: marker(context, "[ctx-0001] Assistant-generated decision record:\nFirst receipt recorded."),
					end_id: marker(context, second),
				});
				return fauxAssistantMessage(fauxToolCall("compact_block", calls[1], { id: "second" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Both receipts recorded."),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Compact both investigations in sequence.");
		expect(requests).toHaveLength(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		for (const context of requests) {
			const ids = markers(context);
			expect(ids).toEqual(ids.map((_, index) => `b${String(index + 1).padStart(3, "0")}`));
			expect(context.messages.slice(0, 4)).toEqual(requests[0].messages.slice(0, 4));
		}
		expect(marker(requests[0], second)).toBe("b005");
		expect(marker(requests[1], second)).toBe("b004");
		for (const callId of ["first", "second"]) {
			const result = toolResult(requests[2], callId);
			expect(result.isError).toBe(false);
			expect(getMessageText(result)).toContain("Visible block IDs reassigned");
			expect(getMessageText(result)).toContain("past tool calls are stale");
		}
		const persistedCalls = requests[2].messages.flatMap((message) =>
			message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : [],
		);
		expect(persistedCalls.map((call) => call.arguments)).toEqual(calls);
		const archives = readGoalArchives(manager.getBranch());
		expect([...archives.keys()]).toEqual(["ctx-0001", "ctx-0002"]);
		expect(archives.get("ctx-0002")?.references).toEqual(["ctx-0001"]);
		validateGoalProvenance(manager.getBranch(), archives);
		const exported = harness.session.exportToJsonl(join(harness.tempDir, "renumbered.jsonl"));
		for (const restoredManager of [SessionManager.open(exported), manager.forkBranch(manager.getLeafId()!)]) {
			const restored = await createHarness({ sessionManager: restoredManager });
			try {
				restored.session.agent.state.messages = restoredManager.buildSessionContext().messages;
				for (const [archiveId, query, fact] of [
					["ctx-0001", "cobalt739", "owner Mira"],
					["ctx-0002", "cobalt739", "owner Mira"],
					["ctx-0002", "emerald840", "owner Arun"],
				]) {
					const callId = `${archiveId}-${query}`;
					let expanded = "";
					let answer = "";
					restored.setResponses([
						fauxAssistantMessage(fauxToolCall("query_block", { archive_id: archiveId, query }, { id: callId }), {
							stopReason: "toolUse",
						}),
						(context) => {
							const initial = context.messages
								.map(getMessageText)
								.join("\n")
								.split("Initial search results: ")[1]
								.split("\n")[0];
							const hit = (JSON.parse(initial) as { hits: Array<{ chunk_id: string }> }).hits[0];
							return fauxAssistantMessage(
								fauxToolCall("expand_block", { block_id: hit.chunk_id }, { id: "expand" }),
								{ stopReason: "toolUse" },
							);
						},
						(context) => {
							expanded = getMessageText(toolResult(context, "expand"));
							return fauxAssistantMessage(`${fact} [${archiveId}]`);
						},
						(context) => {
							answer = getMessageText(toolResult(context, callId));
							return fauxAssistantMessage("Recalled.");
						},
					]);
					await restored.session.prompt(`Recall ${query}.`);
					expect(expanded).toContain(fact);
					expect(answer).toContain(`${fact} [${archiveId}]`);
					expect(restored.getPendingResponseCount()).toBe(0);
				}
			} finally {
				await restored.cleanup();
			}
		}
	} finally {
		await harness.cleanup();
	}
});
