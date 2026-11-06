import { type Context, fauxAssistantMessage } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createTestResourceLoader } from "../extension-test-utils.ts";
import { goalControls, goalNotes } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const evidence = `Initial investigation completed. ${"historical observations ".repeat(5_000)}`;

describe("goal mode context pressure", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it.each([
		[58, ""],
		[62, "Consider compacting completed work."],
		[73, "Consider compacting completed work."],
		[77, "Compact older work soon to preserve room."],
		[83, "Compact older work soon to preserve room."],
		[85, "Compact older context now."],
		[87, "Compact older context now."],
		[93, "Compact older context now."],
		[97, "Compact older context now."],
	] as const)("uses the strongest nudge near %s percent", async (target, expected) => {
		// Keep fixed prompt overhead small so the generated input lands near the
		// intended boundary after system and tool schemas are included.
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getSystemPrompt = () => "You are a test assistant.";
		const harness = await createHarness({
			models: [{ id: "pressure", contextWindow: 1_000_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
			resourceLoader,
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("x".repeat(Math.floor((target * 1_000_000 * 4) / 100)));
		expect(requests).toHaveLength(1);
		const note = goalNotes(requests[0]).at(-1) ?? "";
		const usage = Number(note.match(/approximately (\d+)%/)?.[1]);
		expect(usage).toBeGreaterThanOrEqual(target - 1);
		expect(usage).toBeLessThan(target + 2);
		const nudges = [
			"Consider compacting completed work.",
			"Compact older work soon to preserve room.",
			"Compact completed work before further investigation.",
			"Compact older context now.",
		];
		for (const nudge of nudges) {
			if (nudge === expected) expect(note).toContain(nudge);
			else expect(note).not.toContain(nudge);
		}
	});

	it("runs emergency compaction before the next provider request even with auto-compaction disabled", async () => {
		const requests: Context[] = [];
		let compactions = 0;
		const harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 200_000 },
				{ id: "small", contextWindow: 20_000 },
			],
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(extension) =>
					extension.on("session_before_compact", (event) => {
						compactions++;
						return {
							compaction: {
								summary: "Emergency summary of the investigation.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Initial investigation completed.")]);
		await harness.session.prompt(evidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const small = harness.getModel("small");
		if (!small) throw new Error("Missing small test model");
		await harness.session.setModel(small);
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Continued after emergency compaction.");
			},
		]);
		await harness.session.prompt("Continue the investigation.");
		expect(compactions).toBe(1);
		expect(requests).toHaveLength(1);
		expect(requests[0].messages.map(getMessageText).join("\n")).toContain("Emergency summary of the investigation.");
		expect(requests[0].messages.map(getMessageText).join("\n")).not.toContain(evidence);
		expect(goalNotes(requests[0]).length).toBeGreaterThan(0);
	});

	it("stops with an actionable failure when emergency compaction is cancelled", async () => {
		let attempts = 0;
		const harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 200_000 },
				{ id: "small", contextWindow: 20_000 },
			],
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(extension) =>
					extension.on("session_before_compact", () => {
						attempts++;
						return { cancel: true };
					}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Initial investigation completed.")]);
		await harness.session.prompt(evidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const small = harness.getModel("small");
		if (!small) throw new Error("Missing small test model");
		await harness.session.setModel(small);
		const priorCalls = harness.faux.state.callCount;
		harness.setResponses([fauxAssistantMessage("Oversized request must not be sent.")]);
		let thrown = "";
		try {
			await harness.session.prompt("Continue the investigation.");
		} catch (error) {
			thrown = error instanceof Error ? error.message : String(error);
		}
		expect(attempts).toBe(1);
		expect(harness.faux.state.callCount).toBe(priorCalls);
		const errors = [
			thrown,
			harness.session.state.errorMessage ?? "",
			...harness.eventsOfType("compaction_end").map((event) => event.errorMessage ?? ""),
		].join(" ");
		expect(errors).toMatch(/compact|context/i);
		expect(errors).toMatch(/cancel|fail|unable/i);
	});
});
