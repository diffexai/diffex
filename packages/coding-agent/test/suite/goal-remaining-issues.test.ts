import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, expect, it } from "vitest";
import { readGoalArchives } from "../../src/core/pocket-context.ts";
import { compactPriorHistory, liveIds, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

it("rejects a recovery suggestion after a concurrent context change", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt("record ".repeat(8_000));
	await harness.session.setGoalModeEnabled(true);
	let error = "";
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("compact_block", { start_id: "b999999", end_id: "b999999" }, { id: "invalid" }),
			{ stopReason: "toolUse" },
		),
		(context) => {
			const suggested = JSON.parse(
				getMessageText(toolResult(context, "invalid")).match(/Eligible range: (\{[^}]+\})/)![1],
			);
			const message = { role: "user" as const, content: "Intervening request.", timestamp: Date.now() };
			harness.sessionManager.appendMessage(message);
			harness.session.agent.state.messages.push(message);
			return fauxAssistantMessage(fauxToolCall("compact_block", suggested, { id: "stale" }), {
				stopReason: "toolUse",
			});
		},
		(context) => {
			error = getMessageText(toolResult(context, "stale"));
			return fauxAssistantMessage("Received.");
		},
	]);
	await harness.session.prompt("Compact completed work.");
	expect(error).toContain("context changed since the request was presented");
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
});

it("rejects removed block IDs after a successful compaction instead of selecting replacement content", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 50_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("First recorded."), fauxAssistantMessage("Second recorded.")]);
	await harness.session.prompt("earlier ".repeat(6_000));
	await harness.session.prompt("current ".repeat(10_000));
	await harness.session.setGoalModeEnabled(true);
	let oldId = "";
	let error = "";
	harness.setResponses([
		(context) => {
			oldId = liveIds(context)[0];
			return fauxAssistantMessage(
				fauxToolCall("compact_block", { start_id: oldId, end_id: oldId }, { id: "compact" }),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Earlier observations completed."),
		(context) => {
			expect(toolResult(context, "compact").isError).toBe(false);
			return fauxAssistantMessage(
				fauxToolCall("compact_block", { start_id: oldId, end_id: oldId }, { id: "stale" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			error = getMessageText(toolResult(context, "stale"));
			return fauxAssistantMessage("Received.");
		},
	]);
	await harness.session.prompt("Compact earlier observations.");
	expect(error).toContain(`Unknown or stale block ID: ${oldId}`);
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(1);
});

afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it("explains an unknown selection and provides an eligible recovery range through the tool loop", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt("record ".repeat(8_000));
	await harness.session.setGoalModeEnabled(true);
	let final: Context | undefined;
	harness.setResponses([
		(context) =>
			fauxAssistantMessage(
				fauxToolCall("compact_block", { start_id: "b999999", end_id: liveIds(context)[0] }, { id: "invalid" }),
				{ stopReason: "toolUse" },
			),
		(context) => {
			final = context;
			return fauxAssistantMessage("Received.");
		},
	]);
	await harness.session.prompt("Compact completed work.");
	expect(final).toBeDefined();
	expect(toolResult(final!, "invalid").isError).toBe(true);
	expect(getMessageText(toolResult(final!, "invalid"))).toContain("Unknown or stale block ID: b999999");
	expect(getMessageText(toolResult(final!, "invalid"))).toContain("Eligible range:");
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
});

it("discovers evidence omitted from the archive summary through query_block", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(`Receipt 翡翠739 belongs to Mira. ${"record ".repeat(8_000)}`);
	await harness.session.setGoalModeEnabled(true);
	const { archiveId } = await compactPriorHistory(harness, "Investigation completed.", "archive");
	let result = "";
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("query_block", { query: "翡翠739" }, { id: "discover" }), {
			stopReason: "toolUse",
		}),
		(context) => {
			result = getMessageText(toolResult(context, "discover"));
			return fauxAssistantMessage("Received.");
		},
	]);
	await harness.session.prompt("Find earlier receipt.");
	expect(result).toContain(archiveId);
	expect(result).toContain("entry_id");
	expect(result).toContain("non-exhaustive");
});

it("makes evidence removed by emergency recovery discoverable through query_block", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		extensionFactories: [
			(extension) =>
				extension.on("session_before_compact", (event) => ({
					compaction: {
						summary: "Investigation completed.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				})),
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(`Receipt emerald739 belongs to Mira. ${"evidence ".repeat(10_000)}`);
	await harness.session.setGoalModeEnabled(true);
	let result = "";
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("query_block", { query: "emerald739" }, { id: "discover" }), {
			stopReason: "toolUse",
		}),
		(context) => {
			result = getMessageText(toolResult(context, "discover"));
			return fauxAssistantMessage("Received.");
		},
	]);
	await harness.session.prompt("Find earlier receipt.");
	expect(harness.session.getGoalDiagnostics().emergencyCompactions).toBe(1);
	expect(result).toContain("ctx-0001");
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(1);
});

it.each([
	["boundary", "Invalid block boundary"],
	["reversed", "Reversed block range"],
	["protected", "Protected block"],
] as const)(
	"rejects %s selections without archiving and follows the suggested range successfully",
	async (kind, expected) => {
		const harness = await createHarness({
			models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt("record ".repeat(8_000));
		await harness.session.sendCustomMessage({
			customType: "project-rule",
			content: "Protected project instruction.",
			display: false,
		});
		await harness.session.setGoalModeEnabled(true);
		let error = "";
		let receipt = "";
		harness.setResponses([
			(context) => {
				const oldest = liveIds(context)[0];
				const requestIndex = context.messages.findIndex(
					(message) => getMessageText(message) === "Protected project instruction.",
				);
				const protectedId = getMessageText(context.messages[requestIndex - 1]).match(/\[context (b\d+)\]/)![1];
				const args =
					kind === "boundary"
						? { start_id: `${oldest}:1`, end_id: oldest }
						: kind === "reversed"
							? { start_id: protectedId, end_id: oldest }
							: { start_id: oldest, end_id: protectedId };
				return fauxAssistantMessage(fauxToolCall("compact_block", args, { id: "invalid" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				error = getMessageText(toolResult(context, "invalid"));
				expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
				const suggested = JSON.parse(error.match(/Eligible range: (\{[^}]+\})/)![1]);
				return fauxAssistantMessage(fauxToolCall("compact_block", suggested, { id: "recovered" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("Earlier evidence was recorded."),
			(context) => {
				receipt = getMessageText(toolResult(context, "recovered"));
				return fauxAssistantMessage("Done.");
			},
		]);
		await harness.session.prompt("Compact completed work.");
		expect(error).toContain(expected);
		expect(receipt).toContain("Compacted into ctx-0001");
		expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(1);
	},
);

it("identifies a protected interior block and suggests only the contiguous eligible prefix", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 50_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("Recorded."), fauxAssistantMessage("Reviewed.")]);
	await harness.session.prompt("record ".repeat(12_000));
	await harness.session.sendCustomMessage({
		customType: "project-rule",
		content: "Protected project instruction.",
		display: false,
	});
	await harness.session.prompt("Later historical request.");
	await harness.session.setGoalModeEnabled(true);
	let protectedId = "";
	let error = "";
	harness.setResponses([
		(context) => {
			const marker = (text: string) =>
				getMessageText(
					context.messages[context.messages.findIndex((message) => getMessageText(message) === text) - 1],
				).match(/\[context (b\d+)\]/)![1];
			protectedId = marker("Protected project instruction.");
			return fauxAssistantMessage(
				fauxToolCall(
					"compact_block",
					{ start_id: liveIds(context)[0], end_id: marker("Later historical request.") },
					{ id: "cross-gap" },
				),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			error = getMessageText(toolResult(context, "cross-gap"));
			const suggested = JSON.parse(error.match(/Eligible range: (\{[^}]+\})/)![1]);
			return fauxAssistantMessage(fauxToolCall("compact_block", suggested, { id: "prefix" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("Recorded original evidence."),
		(context) => {
			expect(toolResult(context, "prefix").isError).toBe(false);
			expect(context.messages.map(getMessageText)).toContain("Protected project instruction.");
			expect(context.messages.map(getMessageText)).toContain("Later historical request.");
			return fauxAssistantMessage("Done.");
		},
	]);
	await harness.session.prompt("Compact completed work.");
	expect(error).toContain(`Protected block ${protectedId} lies inside`);
	expect(harness.getPendingResponseCount()).toBe(0);
});
