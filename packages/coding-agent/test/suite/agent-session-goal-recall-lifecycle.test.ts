import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { compactPriorHistory, goalControls, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

const evidence = `The blue gate failed. ${"historical evidence ".repeat(6_000)}`;

describe("goal recall lifecycle", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it("marks a response stopped by the model output limit as incomplete", async () => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The blue gate failed.")]);
		await harness.session.prompt(evidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const { archiveId } = await compactPriorHistory(harness, "The blue gate failed.", "archive");
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("query_block", { archive_id: archiveId, query: "What failed?" }, { id: "query" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Partial evidence: the blue gate failed.", { stopReason: "length" }),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Recall result received.");
			},
		]);
		await harness.session.prompt("Recall the gate result.");
		expect(requests).toHaveLength(1);
		const result = getMessageText(toolResult(requests[0], "query"));
		expect(result).toContain("Partial evidence: the blue gate failed.");
		expect(result).toMatch(/incomplete|truncated|output limit/i);
	});

	it("propagates disposal to the active recall child and waits for it to stop", async () => {
		const started = deferred<void>();
		const aborted = deferred<void>();
		const release = deferred<void>();
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The blue gate failed.")]);
		await harness.session.prompt(evidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const { archiveId } = await compactPriorHistory(harness, "The blue gate failed.", "archive");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("query_block", { archive_id: archiveId, query: "What failed?" }, { id: "query" }),
				{ stopReason: "toolUse" },
			),
			async (_context, options) => {
				if (options?.signal?.aborted) aborted.resolve();
				else options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				started.resolve();
				await aborted.promise;
				await release.promise;
				return fauxAssistantMessage("Disposed child result must not be delivered.");
			},
		]);
		const run = harness.session.prompt("Recall the result.");
		let disposed = false;
		let disposal: Promise<void> | undefined;
		try {
			await started.promise;
			disposal = harness.session.dispose().then(() => {
				disposed = true;
			});
			await aborted.promise;
			expect(disposed).toBe(false);
		} finally {
			release.resolve();
			await disposal;
			await run.catch(() => undefined);
		}
		expect(disposed).toBe(true);
		expect(harness.session.messages.map(getMessageText).join("\n")).not.toContain(
			"Disposed child result must not be delivered.",
		);
	});
});
