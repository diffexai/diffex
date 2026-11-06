import { type Context, estimateContextTokens, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, expect, it } from "vitest";
import { GoalRecallRetrieval } from "../../src/core/goal-retrieval.ts";
import { readGoalArchives } from "../../src/core/pocket-context.ts";
import { compactPriorHistory, liveIds, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it("rejects expanded JSON evidence before dispatch and preserves the selected history", async () => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	const evidence = "\u0000".repeat(55_000);
	harness.setResponses([fauxAssistantMessage("Recorded."), fauxAssistantMessage("Reviewed.")]);
	await harness.session.prompt(evidence);
	await harness.session.prompt("Review.");
	await harness.session.setGoalModeEnabled(true);
	let final: Context | undefined;
	harness.setResponses([
		(context) => {
			const ids = liveIds(context);
			return fauxAssistantMessage(
				fauxToolCall("compact_block", { start_id: ids[0], end_id: ids.at(-1) }, { id: "oversize" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			final = context;
			return fauxAssistantMessage("Use a larger model for this single large block.");
		},
	]);
	const calls = harness.faux.state.callCount;
	await harness.session.prompt("Compact the evidence.");
	expect(harness.faux.state.callCount - calls).toBe(2);
	expect(final).toBeDefined();
	const result = toolResult(final!, "oversize");
	expect(result.isError).toBe(true);
	expect(getMessageText(result)).toContain("input budget exceeded");
	expect(getMessageText(result)).toContain("oldest eligible blocks");
	expect(final!.messages.map(getMessageText)).toContain(evidence);
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
});

it.each([
	["length", "output limit reached"],
	["stop", "empty summary"],
	["toolUse", "tool calls"],
	["error", "provider failure"],
	["aborted", "cancelled"],
] as const)("reports an actionable %s summary failure without committing an archive", async (stopReason, expected) => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 }, retry: { enabled: false } },
	});
	harnesses.push(harness);
	const evidence = "record ".repeat(9_000);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(evidence);
	await harness.session.setGoalModeEnabled(true);
	let final: Context | undefined;
	harness.setResponses([
		(context) => {
			const ids = liveIds(context);
			return fauxAssistantMessage(
				fauxToolCall("compact_block", { start_id: ids[0], end_id: ids.at(-1) }, { id: "failed" }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage(stopReason === "toolUse" ? fauxToolCall("unexpected", {}) : "", {
			stopReason,
			errorMessage: stopReason === "error" ? "invalid model configuration" : undefined,
		}),
		(context) => {
			final = context;
			return fauxAssistantMessage("Continued.");
		},
	]);
	await harness.session.prompt("Compact completed work.");
	expect(final).toBeDefined();
	const result = toolResult(final!, "failed");
	expect(result.isError).toBe(true);
	expect(getMessageText(result)).toContain(expected);
	expect(getMessageText(result)).toMatch(/smaller range|before retrying|still needed/);
	expect(final!.messages.map(getMessageText)).toContain(evidence);
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
});

it("recovers before dispatch when input fits the window but consumes response headroom", async () => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		extensionFactories: [
			(extension) =>
				extension.on("session_before_compact", (event) => ({
					compaction: {
						summary: "Earlier evidence preserved.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				})),
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt("evidence ".repeat(10_000));
	await harness.session.setGoalModeEnabled(true);
	let request: Context | undefined;
	harness.setResponses([
		(context) => {
			request = context;
			return fauxAssistantMessage("Continued.");
		},
	]);
	await harness.session.prompt("Continue.");
	expect(harness.session.getGoalDiagnostics().emergencyCompactions).toBe(1);
	expect(request).toBeDefined();
	expect(estimateContextTokens(request!).tokens + 8_000 + 4_096).toBeLessThan(32_000);
	expect(JSON.stringify(request)).toContain("Earlier evidence preserved.");
});

it("discovers archives with a rephrased question and offers browsing for empty results", async () => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt("Release gate failure evidence. ".repeat(2_000));
	await harness.session.setGoalModeEnabled(true);
	await compactPriorHistory(harness, "The blue gate blocked the release.", "archive");
	const results: string[] = [];
	for (const [index, query] of ["What blocked the release?", "deployment authorization", "*"].entries()) {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("query_block", { query }, { id: `discover-${index}` }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const text = getMessageText(toolResult(context, `discover-${index}`));
				results.push(text.slice(text.indexOf("{")));
				return fauxAssistantMessage("Checked.");
			},
		]);
		await harness.session.prompt("Find earlier evidence.");
	}
	expect(JSON.parse(results[0]).archives[0].archiveId).toBe("ctx-0001");
	expect(JSON.parse(results[1]).archives).toEqual([]);
	expect(JSON.parse(results[1]).instruction).toContain("non-exhaustive");
	expect(JSON.parse(results[1]).instruction).toContain('query="*"');
	expect(JSON.parse(results[2]).archives[0].archiveId).toBe("ctx-0001");
});

it("paginates ranked archive discovery without skipping older matches after a newer top hit", async () => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	for (let index = 1; index <= 23; index++) {
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt("record ".repeat(6_500));
		await compactPriorHistory(
			harness,
			index === 23 ? "Release cobalt gate." : `Release gate ${index}.`,
			`archive-${index}`,
		);
	}
	const pages: Array<{ archives: Array<{ archiveId: string }>; next_cursor?: string }> = [];
	for (let index = 0; index < 2; index++) {
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"query_block",
					{ query: "cobalt release", ...(pages[0]?.next_cursor ? { cursor: pages[0].next_cursor } : {}) },
					{ id: `page-${index}` },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const text = getMessageText(toolResult(context, `page-${index}`));
				pages.push(JSON.parse(text.slice(text.indexOf("{"))));
				return fauxAssistantMessage("Checked.");
			},
		]);
		await harness.session.prompt("Discover matching archives.");
	}
	expect(pages[0].archives).toHaveLength(20);
	expect(pages[0].archives[0].archiveId).toBe("ctx-0023");
	expect(pages[1].archives).toHaveLength(3);
	expect(pages[1].next_cursor).toBeUndefined();
	expect(new Set(pages.flatMap((page) => page.archives.map((archive) => archive.archiveId))).size).toBe(23);
});

it("compacts signed history and recalls original evidence under a strict 32k request guard", async () => {
	const harness = await createHarness({
		models: [{ id: "guarded", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	const signature = "opaqueSignature".repeat(5_000);
	const evidence = `The blue gate blocked release. ${"record ".repeat(9_000)}`;
	harness.setResponses([
		fauxAssistantMessage([
			{ type: "thinking", thinking: "The gate failed.", thinkingSignature: signature },
			{ type: "text", text: "Recorded the gate failure.", textSignature: signature },
		]),
		fauxAssistantMessage("Ready to continue."),
	]);
	await harness.session.prompt(evidence);
	await harness.session.prompt("Review the recorded result.");
	await harness.session.setGoalModeEnabled(true);
	const requests: Context[] = [];
	let helperTokens = 0;
	let helperOutputLimit: number | undefined;
	let archiveId = "";
	harness.setResponses([
		(context) => {
			requests.push(context);
			const ids = liveIds(context);
			return fauxAssistantMessage(
				fauxToolCall("compact_block", { start_id: ids[0], end_id: ids.at(-1) }, { id: "compact" }),
				{ stopReason: "toolUse" },
			);
		},
		(context, options) => {
			requests.push(context);
			helperTokens = estimateContextTokens(context).tokens;
			helperOutputLimit = options?.maxTokens;
			return helperTokens + 8_000 + 4_096 <= 32_000
				? fauxAssistantMessage("The blue gate blocked release.")
				: fauxAssistantMessage("", { stopReason: "length" });
		},
		(context) => {
			requests.push(context);
			archiveId = getMessageText(toolResult(context, "compact")).match(/ctx-\d+/)?.[0] ?? "";
			return archiveId
				? fauxAssistantMessage(
						fauxToolCall("query_block", { archive_id: archiveId, query: "blue gate" }, { id: "recall" }),
						{ stopReason: "toolUse" },
					)
				: fauxAssistantMessage("Compaction failed.");
		},
		(context) => {
			requests.push(context);
			return fauxAssistantMessage("The blue gate blocked release [ctx-0001].");
		},
		(context) => {
			requests.push(context);
			return fauxAssistantMessage("Investigation complete.");
		},
	]);
	await harness.session.prompt("Compact completed work, then recall the gate result.");
	expect(helperTokens + 8_000 + 4_096).toBeLessThanOrEqual(32_000);
	expect(helperOutputLimit).toBe(8_000);
	expect(requests).toHaveLength(5);
	expect(archiveId).toBe("ctx-0001");
	expect(JSON.stringify(requests[1])).not.toContain("opaqueSignature");
	expect(JSON.stringify(harness.sessionManager.getBranch())).toContain(signature);
	for (const context of requests)
		expect(estimateContextTokens(context).tokens + 8_000 + 4_096).toBeLessThanOrEqual(32_000);
	expect(toolResult(requests[4], "recall").isError).toBe(false);
	const retrieval = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 32_000, false);
	expect(JSON.parse(retrieval.search("opaqueSignature").text).hits).toEqual([]);
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(1);
});
