import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { GoalRecallRetrieval, type RecallSearchHit } from "../../src/core/goal-retrieval.ts";
import { GOAL_REPLACEMENT_ENTRY, type GoalArchive } from "../../src/core/pocket-context.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText } from "./harness.ts";

function writeReport(name: string, report: object): void {
	const output = process.env.DIFFEX_GOAL_COMPARISON_OUTPUT;
	if (!output) return;
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
}

function visibleMessages(context: Context, removeGoalMetadata: boolean) {
	return context.messages.flatMap((message) => {
		if (
			removeGoalMetadata &&
			message.role === "user" &&
			/^(?:Context usage: approximately \d+%\.[\s\S]*\n)?\[context b\d+\]$/.test(getMessageText(message))
		)
			return [];
		const content =
			removeGoalMetadata && message.role === "toolResult"
				? message.content.filter((part) => part.type !== "text" || !/^\[context b\d+\]\n$/.test(part.text))
				: message.content;
		return [{ role: message.role, content }];
	});
}

it.each([12, 80])("isolates metadata overhead by replaying %i identical tool exchanges", async (exchanges) => {
	const runs = [];
	for (const goal of [false, true]) {
		const harness = await createHarness({
			models: [{ id: "replay", contextWindow: 1_000_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
			extensionFactories: [
				(extension) =>
					extension.registerTool({
						name: "replay_evidence",
						label: "Replay evidence",
						description: "Return recorded test evidence.",
						parameters: Type.Object({ index: Type.Number() }),
						async execute(_id, input) {
							return {
								content: [
									{ type: "text", text: `Observation ${input.index}: ${"verified evidence ".repeat(100)}` },
								],
								details: {},
							};
						},
					}),
			],
		});
		try {
			if (goal) await harness.session.setGoalModeEnabled(true);
			const requests: Context[] = [];
			const steps: FauxResponseStep[] = Array.from({ length: exchanges + 1 }, (_, index) => (context) => {
				requests.push(
					structuredClone({
						...context,
						tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
					}),
				);
				return index === exchanges
					? fauxAssistantMessage("Verified.", { timestamp: index + 1 })
					: fauxAssistantMessage(fauxToolCall("replay_evidence", { index }, { id: `call-${index}` }), {
							stopReason: "toolUse",
							timestamp: index + 1,
						});
			});
			harness.setResponses(steps);
			const started = performance.now();
			await harness.session.prompt("Replay the recorded investigation with unchanged verification requirements.");
			const latencyMs = performance.now() - started;
			expect(harness.session.getLastAssistantText()).toBe("Verified.");
			expect(requests).toHaveLength(exchanges + 1);
			for (const request of requests) {
				expect(request.systemPrompt).toBe(requests[0].systemPrompt);
				expect(request.tools).toEqual(requests[0].tools);
			}
			runs.push({
				goal,
				requests,
				latencyMs,
				systemChars: requests.reduce((sum, request) => sum + (request.systemPrompt?.length ?? 0), 0),
				toolSchemaChars: requests.reduce((sum, request) => sum + JSON.stringify(request.tools).length, 0),
				messageChars: requests.reduce(
					(sum, request) => sum + JSON.stringify(visibleMessages(request, false)).length,
					0,
				),
				returnedEvidenceChars: harness.session.messages
					.filter((message) => message.role === "toolResult")
					.reduce((sum, message) => sum + getMessageText(message).length, 0),
			});
		} finally {
			await harness.cleanup();
		}
	}
	for (let index = 0; index < runs[0].requests.length; index++) {
		expect(visibleMessages(runs[1].requests[index], true)).toEqual(visibleMessages(runs[0].requests[index], true));
	}
	writeReport(`replay-${exchanges}`, {
		kind: "deterministic faux-provider replay; character counts exclude provider framing and are not token measurements",
		exchanges,
		identicalEvidenceAndActions: true,
		runs: runs.map(({ requests, ...run }) => ({
			...run,
			requests: requests.length,
			totalInputTokens: null,
			newlyProcessedInput: null,
			billedCost: null,
			planningOnlyRequests: 0,
			failedToolCalls: 0,
			summarizationRequests: 0,
			recallRequests: 0,
		})),
	});
});

it.each([200_000, 1_000_000])(
	"compares selective recall evidence completeness with eager attachment at %i tokens",
	async (contextWindow) => {
		const manager = SessionManager.inMemory();
		const entryIds: string[] = [];
		const observations = [];
		for (let index = 0; index < 60; index++) {
			const fact =
				index === 17
					? "Receipt cobalt-739; owner Mira; status approved for staging."
					: index === 53
						? "Receipt cobalt-739; production approval revoked after security review."
						: "Routine observation.";
			const text = `${fact} ${"Routine release evidence. ".repeat(Math.ceil((contextWindow * 2.6) / 60 / 26))}`;
			observations.push(text);
			entryIds.push(manager.appendMessage({ role: "user", content: text, timestamp: index + 1 }));
		}
		const archive: GoalArchive = {
			version: 1,
			archiveId: "ctx-0001",
			toolCallId: "seed",
			startId: "b001",
			endId: "b060",
			entryIds,
			references: [],
			summary: "Release evidence with staging and production decisions.",
		};
		manager.appendCustomEntry(GOAL_REPLACEMENT_ENTRY, archive);
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "recall-replay", contextWindow }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		try {
			const query = "What are the receipt, owner, staging status, and production status for cobalt-739?";
			let firstRequest: Context | undefined;
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("query_block", { archive_id: archive.archiveId, query }, { id: "recall" }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					firstRequest = structuredClone(context);
					const text = context.messages.map(getMessageText).join("\n");
					const complete =
						text.includes("owner Mira") &&
						text.includes("approved for staging") &&
						text.includes("production approval revoked");
					return fauxAssistantMessage(
						complete
							? "Mira's cobalt-739 was approved for staging; production approval was revoked [ctx-0001]."
							: "Incomplete evidence.",
					);
				},
				fauxAssistantMessage("Received."),
			]);
			const started = performance.now();
			await harness.session.prompt(query);
			const sessionLatencyMs = performance.now() - started;
			expect(firstRequest).toBeDefined();
			const text = firstRequest!.messages.map(getMessageText).join("\n");
			expect(text).toContain("owner Mira");
			expect(text).toContain("production approval revoked");
			expect(text.length).toBeLessThan(8_000);
			const indexStart = performance.now();
			const retrieval = new GoalRecallRetrieval(manager.getBranch(), archive.archiveId, contextWindow, false);
			const hits = (JSON.parse(retrieval.search(query).text) as { hits: RecallSearchHit[] }).hits;
			const pages = hits.map((hit) => retrieval.expand(hit.chunk_id).text);
			const retrievalLatencyMs = performance.now() - indexStart;
			expect(pages.join("\n")).toContain("production approval revoked");
			writeReport(`recall-${contextWindow}`, {
				kind: "deterministic evidence comparison; faux synthesis correctness is not live model quality",
				contextWindow,
				eagerEvidenceChars: JSON.stringify(observations).length,
				selectiveFirstRequestChars: text.length,
				selectiveExpandedChars: pages.reduce((sum, page) => sum + page.length, 0),
				expectedFacts: 4,
				foundFacts: 4,
				initialModelSearchRoundTrips: 0,
				sessionLatencyMs,
				retrievalLatencyMs,
				totalInputTokens: null,
				billedCost: null,
			});
		} finally {
			await harness.cleanup();
		}
	},
);
