import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, expect, it } from "vitest";
import { readGoalArchives } from "../../src/core/pocket-context.ts";
import { liveIds, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it.each(["project", "incomplete"])(
	"rejects a model attempt to compact %s content without invoking a summarizer",
	async (target) => {
		const harness = await createHarness({
			models: [{ id: "goal", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt("evidence ".repeat(12_000));
		await harness.session.sendCustomMessage({
			customType: "project",
			content: "Project instruction.",
			display: false,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(
				[
					{ type: "text", text: "Incomplete exchange." },
					fauxToolCall("read", { path: "missing" }, { id: "unfinished" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		harness.sessionManager.appendMessage({ role: "user", content: "Earlier request.", timestamp: Date.now() });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Latest assistant exchange."));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await harness.session.setGoalModeEnabled(true);
		const systemPrompt = harness.session.systemPrompt;
		const expected = {
			project: "Project instruction.",
			incomplete: "Incomplete exchange.",
		}[target]!;
		let error = "";
		harness.setResponses([
			(context) => {
				const index = context.messages.findIndex((message) => getMessageText(message) === expected);
				const id = getMessageText(context.messages[index - 1]).match(/\[context (b\d+)\]/)![1];
				return fauxAssistantMessage(
					fauxToolCall("compact_block", { start_id: id, end_id: id }, { id: "blocked" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				error = getMessageText(toolResult(context, "blocked"));
				return fauxAssistantMessage("Done.");
			},
		]);
		const calls = harness.faux.state.callCount;
		await harness.session.prompt("Latest user request.");
		expect(error).toContain("Protected block");
		expect(harness.faux.state.callCount - calls).toBe(2);
		expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
		expect(harness.session.messages.map(getMessageText)).toContain(expected);
		expect(harness.session.systemPrompt).toBe(systemPrompt);
	},
);

it.each(["before", "during"])("rejects compaction when system instructions change %s summarization", async (when) => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 50_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt("evidence ".repeat(12_000));
	await harness.session.setGoalModeEnabled(true);
	let error = "";
	harness.setResponses([
		(context) => {
			const id = liveIds(context)[0];
			if (when === "before") harness.session.agent.state.systemPrompt += "Changed instruction.";
			return fauxAssistantMessage(fauxToolCall("compact_block", { start_id: id, end_id: id }, { id: "changed" }), {
				stopReason: "toolUse",
			});
		},
		...(when === "during"
			? [
					() => {
						harness.session.agent.state.systemPrompt += "Changed instruction.";
						return fauxAssistantMessage("Summary that must not be committed.");
					},
				]
			: []),
		(context) => {
			error = getMessageText(toolResult(context, "changed"));
			return fauxAssistantMessage("Done.");
		},
	]);
	await harness.session.prompt("Continue.");
	expect(error).toContain("context changed");
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
});
