import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createTestResourceLoader } from "../extension-test-utils.ts";
import { goalControls, goalNotes, liveIds, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("goal mode full-window pressure and request capacity", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it("reports the fraction of the full window rather than the smaller input budget", async () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getSystemPrompt = () => "You are a test assistant.";
		const harness = await createHarness({
			models: [{ id: "pressure", contextWindow: 49_152 }],
			settings: { compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 1 } },
			resourceLoader,
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		let request: Context | undefined;
		harness.setResponses([
			(context) => {
				request = structuredClone(context);
				return fauxAssistantMessage("Continued the task.");
			},
		]);
		await harness.session.prompt("x".repeat(140_000));
		expect(request).toBeDefined();
		const note = goalNotes(request as Context).at(-1) ?? "";
		const usage = Number(note.match(/approximately (\d+)%/)?.[1]);
		expect(usage).toBeGreaterThanOrEqual(70);
		expect(usage).toBeLessThan(75);
		expect(note).toContain("Consider compacting completed work.");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("rejects voluntary compaction below 40% of the full window even above 40% of input capacity", async () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getSystemPrompt = () => "You are a test assistant.";
		const harness = await createHarness({
			models: [{ id: "pressure", contextWindow: 49_152 }],
			settings: { compaction: { enabled: false, reserveTokens: 16_384 } },
			resourceLoader,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Investigation recorded.")]);
		await harness.session.prompt("x".repeat(63_000));
		await goalControls(harness).setGoalModeEnabled(true);
		let result: string | undefined;
		harness.setResponses([
			(context) => {
				const ids = liveIds(context);
				expect(ids.length).toBeGreaterThan(0);
				return fauxAssistantMessage(
					fauxToolCall("compact_block", { start_id: ids[0], end_id: ids.at(-1) }, { id: "early" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				result = getMessageText(toolResult(context, "early"));
				return fauxAssistantMessage("Continued without compacting.");
			},
		]);
		await harness.session.prompt("Continue the task.");
		expect(result).toContain("Cannot compact below 40% context usage.");
		expect(harness.session.getGoalDiagnostics().compactionFailures).toBe(1);
	});

	it.each(["error", "length"] as const)("still recovers from a provider %s below the full window", async (failure) => {
		const harness = await createHarness({
			models: [{ id: "pressure", contextWindow: 49_152 }],
			settings: { compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(extension) =>
					extension.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Previous investigation retained.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					})),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Investigation recorded.")]);
		await harness.session.prompt("Prior evidence. ".repeat(500));
		await goalControls(harness).setGoalModeEnabled(true);
		harness.setResponses([
			failure === "error"
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Your input exceeds the context window" })
				: fauxAssistantMessage("Partial response", { stopReason: "length" }),
			fauxAssistantMessage("Recovered after overflow."),
		]);
		await harness.session.prompt("Continue the task.");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("Recovered after overflow.");
	});
});
