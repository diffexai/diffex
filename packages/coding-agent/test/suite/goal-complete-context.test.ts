import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { readGoalArchives } from "../../src/core/pocket-context.ts";
import { toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText } from "./harness.ts";

it.each(["first user", "latest user", "latest assistant", "latest tool exchange"])(
	"compacts the %s block through the tool loop",
	async (target) => {
		const evidence = `Receipt cobalt-739. ${"evidence ".repeat(12_000)}`;
		const harness = await createHarness({
			models: [{ id: "goal", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Read evidence",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: evidence }], details: {} };
					},
				},
			],
		});
		try {
			await harness.session.setGoalModeEnabled(true);
			if (target === "latest user" || target === "latest assistant") {
				harness.setResponses([fauxAssistantMessage(target === "latest assistant" ? evidence : "Recorded.")]);
				await harness.session.prompt("Initial request.");
			}
			let selected = "";
			harness.setResponses([
				...(target === "latest tool exchange"
					? [fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe" }), { stopReason: "toolUse" })]
					: []),
				(context) => {
					const index = context.messages.findIndex((message) => getMessageText(message).includes(evidence));
					expect(index).toBeGreaterThan(0);
					selected = getMessageText(context.messages[target === "latest tool exchange" ? index : index - 1]).match(
						/\[context (b\d+)\]/,
					)![1];
					return fauxAssistantMessage(
						fauxToolCall("compact_block", { start_id: selected, end_id: selected }, { id: "compact" }),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					expect(context.messages.map(getMessageText).join("\n")).toContain(evidence);
					return fauxAssistantMessage("Receipt recorded.");
				},
				(context) => {
					expect(toolResult(context, "compact").isError).toBe(false);
					expect(context.messages.map(getMessageText).join("\n")).not.toContain(evidence);
					return fauxAssistantMessage("Done.");
				},
			]);
			await harness.session.prompt(
				target === "latest assistant" || target === "latest tool exchange" ? "Continue." : evidence,
			);
			const archive = readGoalArchives(harness.sessionManager.getBranch()).get("ctx-0001");
			expect(archive?.startId).toBe(selected);
			expect(archive?.endId).toBe(selected);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.cleanup();
		}
	},
);
