import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type Context, estimateContextTokens, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { GoalArchiveDiscovery, GoalRecallRetrieval } from "../../src/core/goal-retrieval.ts";
import { readGoalArchives, validateGoalProvenance } from "../../src/core/pocket-context.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { compactPriorHistory, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

function recordMetric(value: Record<string, unknown>) {
	if (process.env.DIFFEX_GOAL_STRESS_OUTPUT)
		appendFileSync(process.env.DIFFEX_GOAL_STRESS_OUTPUT, `${JSON.stringify(value)}\n`);
}
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

it.each([17, 739, 918])(
	"survives 240 tool exchanges with repeated recovery and durable recall (seed %s)",
	async (seed) => {
		let random = seed;
		let reads = 0;
		let summaries = 0;
		let mainRequests = 0;
		let maxInputTokens = 0;
		const expected: string[] = [];
		const started = performance.now();
		const harness = await createHarness({
			models: [{ id: "stress", contextWindow: 32_000, maxTokens: 8_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 }, retry: { enabled: false } },
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Inspect the next deployment receipt.",
					parameters: Type.Object({}),
					async execute() {
						random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
						const fact = `receipt${seed}x${reads}: owner Mira${reads}; production ${reads % 2 ? "revoked" : "approved"}.`;
						expected.push(fact);
						reads++;
						return {
							content: [
								{
									type: "text" as const,
									text: `${"historical record ".repeat(200 + (random % 1000))}\n${fact}`,
								},
							],
							details: {},
						};
					},
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setGoalModeEnabled(true);
		const respond = (context: Context) => {
			const tokens = estimateContextTokens(context).tokens;
			maxInputTokens = Math.max(maxInputTokens, tokens);
			expect(tokens + 8_000 + 4_096).toBeLessThanOrEqual(32_000);
			if (!context.tools?.length) {
				summaries++;
				return fauxAssistantMessage(
					"Investigation continued. Recall original receipts for exact deployment decisions.",
				);
			}
			mainRequests++;
			return reads < 240
				? fauxAssistantMessage(fauxToolCall("probe", {}, { id: `probe-${reads}` }), { stopReason: "toolUse" })
				: fauxAssistantMessage("All 240 probes completed.");
		};
		harness.setResponses(Array.from({ length: 600 }, () => respond));
		await harness.session.prompt("Inspect all 240 deployment receipts and preserve their exact decisions.");
		expect(reads).toBe(240);
		expect(mainRequests).toBe(241);
		expect(summaries).toBeGreaterThan(20);
		const entries = harness.sessionManager.getBranch();
		const archives = readGoalArchives(entries);
		validateGoalProvenance(entries, archives);
		expect(archives.size).toBe(summaries);
		const projected = harness.session.messages.map(getMessageText).join("\n");
		const discovery = new GoalArchiveDiscovery(entries);
		for (const [index, fact] of expected.entries()) {
			const matches = discovery.search(`receipt${seed}x${index}`);
			if (matches.length) {
				const retrieval = new GoalRecallRetrieval(entries, matches[0].archive.archiveId, 32_000, false);
				const result = JSON.parse(retrieval.search(`receipt${seed}x${index}`).text) as {
					hits: Array<{ chunk_id: string }>;
				};
				expect(
					result.hits.some((hit) => retrieval.expand(hit.chunk_id).text.includes(fact)),
					`missing ${fact}`,
				).toBe(true);
			} else expect(projected.includes(fact), `missing ${fact}`).toBe(true);
		}
		const exported = harness.session.exportToJsonl(join(harness.tempDir, "stress.jsonl"));
		const restored = await createHarness({
			models: [{ id: "stress", contextWindow: 32_000, maxTokens: 8_000 }],
			sessionManager: SessionManager.open(exported),
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		harnesses.push(restored);
		restored.session.agent.state.messages = restored.sessionManager.buildSessionContext().messages;
		const root = [...archives.keys()].at(-1)!;
		for (const index of [0, 79, 159]) {
			const identifier = `receipt${seed}x${index}`;
			restored.setResponses([
				fauxAssistantMessage(
					fauxToolCall("query_block", { archive_id: root, query: identifier }, { id: identifier }),
					{ stopReason: "toolUse" },
				),
				(context) => {
					const initial = context.messages
						.map(getMessageText)
						.join("\n")
						.split("Initial search results: ")[1]
						.split("\n")[0];
					const hit = (JSON.parse(initial) as { hits: Array<{ chunk_id: string }> }).hits[0];
					return fauxAssistantMessage(fauxToolCall("expand_block", { block_id: hit.chunk_id }, { id: "expand" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					expect(getMessageText(toolResult(context, "expand"))).toContain(expected[index]);
					return fauxAssistantMessage(`${expected[index]} [${root}]`);
				},
				(context) => {
					expect(toolResult(context, identifier).isError).toBe(false);
					expect(getMessageText(toolResult(context, identifier))).toContain(expected[index]);
					return fauxAssistantMessage("Verified receipt.");
				},
			]);
			await restored.session.prompt(`Recall ${identifier}.`);
			expect(restored.getPendingResponseCount()).toBe(0);
		}
		recordMetric({
			metric: "goal-long-loop",
			seed,
			reads,
			summaries,
			mainRequests,
			maxInputTokens,
			elapsedMs: performance.now() - started,
		});
	},
	60_000,
);

it("fails closed on an oversized latest exchange, preserves evidence, and recovers with a larger model", async () => {
	const harness = await createHarness({
		models: [{ id: "stress", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Read a large result.",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [
							{
								type: "text" as const,
								text: `${"record ".repeat(30_000)}\noversizedReceipt739: production revoked.`,
							},
						],
						details: {},
					};
				},
			},
		],
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "oversized" }), { stopReason: "toolUse" }),
		(context) => {
			expect(estimateContextTokens(context).tokens + 8_000 + 4_096).toBeLessThanOrEqual(32_000);
			return fauxAssistantMessage("Recovered.");
		},
	]);
	await harness.session.prompt("Inspect the evidence and determine the deployment decision.");
	expect(harness.getPendingResponseCount()).toBe(0);
	expect(harness.session.state.errorMessage).toContain("could not make the request fit");
	expect(harness.faux.state.callCount).toBe(2);
	expect(harness.session.messages.some((message) => getMessageText(message).includes("oversizedReceipt739"))).toBe(
		true,
	);
	await harness.session.setModel({ ...harness.getModel(), contextWindow: 200_000 });
	harness.setResponses([fauxAssistantMessage("Inspected the oversized result.")]);
	await harness.session.prompt("Continue with the larger context window.");
	await harness.session.setModel(harness.getModel());
	harness.setResponses([
		(context) => {
			expect(estimateContextTokens(context).tokens + 8_000 + 4_096).toBeLessThanOrEqual(32_000);
			return fauxAssistantMessage("Recovered after the next user turn.");
		},
	]);
	await harness.session.prompt("Continue and recall oversizedReceipt739 from archived evidence.");
	expect(harness.getPendingResponseCount()).toBe(0);
	expect(harness.session.getLastAssistantText()).toBe("Recovered after the next user turn.");
	const entries = harness.sessionManager.getBranch();
	const match = new GoalArchiveDiscovery(entries).search("oversizedReceipt739")[0];
	expect(match).toBeDefined();
	expect(
		new GoalRecallRetrieval(entries, match.archive.archiveId, 32_000, false).search("oversizedReceipt739").text,
	).toContain("production revoked");
});

it("keeps discovery bounded and branch-local across 256 nested real archives", async () => {
	const started = performance.now();
	const harness = await createHarness({
		models: [{ id: "stress", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	let siblingLeaf = "";
	let maxReceiptChars = 0;
	for (let index = 0; index < 256; index++) {
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt(`${"record ".repeat(6500)}\nreceipt${index}z2026: owner Mira${index}.`);
		await compactPriorHistory(harness, "Investigation complete.", `archive-${index}`);
		if (index === 0) siblingLeaf = harness.sessionManager.getLeafId()!;
	}
	const creationMs = performance.now() - started;
	const entries = harness.sessionManager.getBranch();
	const discovery = new GoalArchiveDiscovery(entries);
	expect(discovery.records).toHaveLength(256);
	for (let index = 0; index < 256; index++) {
		expect(discovery.search(`receipt${index}z2026`)[0]?.archive.archiveId).toBe(
			`ctx-${String(index + 1).padStart(4, "0")}`,
		);
	}
	const discoveryMs = performance.now() - started - creationMs;
	let cursor: string | undefined;
	const found: string[] = [];
	for (let page = 0; page < 13; page++) {
		const callId = `page-${page}`;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("query_block", { query: "*", cursor }, { id: callId }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const result = toolResult(context, callId);
				expect(result.isError).toBe(false);
				const text = getMessageText(result);
				maxReceiptChars = Math.max(maxReceiptChars, text.length);
				const parsed = JSON.parse(text.slice(text.indexOf("{"))) as {
					archives: Array<{ archiveId: string }>;
					next_cursor?: string;
				};
				expect(parsed.archives.length).toBeLessThanOrEqual(20);
				found.push(...parsed.archives.map((archive) => archive.archiveId));
				cursor = parsed.next_cursor;
				return fauxAssistantMessage("Page inspected.");
			},
		]);
		await harness.session.prompt("Browse the archives.");
	}
	expect(cursor).toBeUndefined();
	expect(found).toEqual(discovery.records.map((archive) => archive.archiveId));
	expect(maxReceiptChars).toBeLessThan(12000);
	const deep = new GoalRecallRetrieval(entries, "ctx-0256", 32_000, false);
	expect(deep.search("receipt0z2026").text).toContain("owner Mira0");
	await harness.session.navigateTree(siblingLeaf);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("query_block", { query: "receipt255z2026" }, { id: "sibling" }), {
			stopReason: "toolUse",
		}),
		(context) => {
			const text = getMessageText(toolResult(context, "sibling"));
			expect(JSON.parse(text.slice(text.indexOf("{"))).archives).toEqual([]);
			return fauxAssistantMessage("Sibling isolated.");
		},
	]);
	await harness.session.prompt("Find the sibling receipt.");
	recordMetric({
		metric: "goal-archive-scale",
		archives: 256,
		discoveryQueries: 256,
		pages: 13,
		maxReceiptChars,
		creationMs,
		discoveryMs,
		elapsedMs: performance.now() - started,
	});
}, 300_000);

it("discovers and recalls line-start, escaped, and punctuation-delimited identifiers across chunk boundaries", async () => {
	const harness = await createHarness({
		models: [{ id: "stress", contextWindow: 80_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	const identifiers = [
		...Array.from({ length: 64 }, (_, index) => `needle${index}z739`),
		`needle${"x".repeat(1500)}739`,
	];
	const separators = ["\n", "\r", "\t", "\b", "\f", "\\", '"', ","];
	const evidence =
		`${"x,".repeat(500)}${identifiers.at(-1)}:revoked\n` +
		identifiers
			.slice(0, -1)
			.map(
				(identifier, index) =>
					`${"x,".repeat(1170 + (index % 40))}${separators[index % separators.length]}${identifier}:revoked`,
			)
			.join("\n");
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(evidence);
	await harness.session.setGoalModeEnabled(true);
	const { archiveId } = await compactPriorHistory(harness, "Records inspected.", "boundary-archive");
	const entries = harness.sessionManager.getBranch();
	const discovery = new GoalArchiveDiscovery(entries);
	for (const identifier of identifiers) {
		expect(discovery.search(identifier)[0]?.archive.archiveId, identifier).toBe(archiveId);
		const retrieval = new GoalRecallRetrieval(entries, archiveId, 32_000, false);
		const result = JSON.parse(retrieval.search(identifier).text) as { hits: Array<{ chunk_id: string }> };
		expect(result.hits.length, identifier).toBeGreaterThan(0);
		expect(
			result.hits.some((hit) => retrieval.expand(hit.chunk_id).text.includes(`${identifier}:revoked`)),
			identifier,
		).toBe(true);
	}
	for (const index of [0, 35]) {
		const identifier = identifiers[index];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("query_block", { query: identifier }, { id: `discover-${index}` }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const text = getMessageText(toolResult(context, `discover-${index}`));
				const page = JSON.parse(text.slice(text.indexOf("{"))) as { archives: Array<{ archiveId: string }> };
				expect(page.archives[0]?.archiveId).toBe(archiveId);
				return fauxAssistantMessage(
					fauxToolCall("query_block", { archive_id: archiveId, query: identifier }, { id: `recall-${index}` }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const initial = context.messages
					.map(getMessageText)
					.join("\n")
					.split("Initial search results: ")[1]
					.split("\n")[0];
				const hit = (JSON.parse(initial) as { hits: Array<{ chunk_id: string }> }).hits[0];
				return fauxAssistantMessage(fauxToolCall("expand_block", { block_id: hit.chunk_id }, { id: "expand" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(getMessageText(toolResult(context, "expand"))).toContain(`${identifier}:revoked`);
				return fauxAssistantMessage(`${identifier}:revoked [${archiveId}]`);
			},
			(context) => {
				expect(getMessageText(toolResult(context, `recall-${index}`))).toContain(`${identifier}:revoked`);
				return fauxAssistantMessage("Confirmed.");
			},
		]);
		await harness.session.prompt(`Find and recall ${identifier}.`);
		expect(harness.getPendingResponseCount()).toBe(0);
	}
});
