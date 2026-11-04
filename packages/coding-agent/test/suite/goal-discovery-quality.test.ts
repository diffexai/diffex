import { performance } from "node:perf_hooks";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, expect, it } from "vitest";
import { GoalArchiveDiscovery } from "../../src/core/goal-retrieval.ts";
import { readGoalArchives } from "../../src/core/pocket-context.ts";
import { compactPriorHistory, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

interface DiscoveryPage {
	archives: Array<{ archiveId: string; evidence?: Array<{ archive_id: string; entry_id: string }> }>;
	next_cursor?: string;
	instruction?: string;
}

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()?.cleanup();
});

async function discover(
	harness: Harness,
	query: string,
	cursor?: string,
): Promise<{ page: DiscoveryPage; chars: number }> {
	let result = "";
	const callId = `discover-${harness.faux.state.callCount}`;
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("query_block", { query, cursor }, { id: callId }), { stopReason: "toolUse" }),
		(context) => {
			expect(toolResult(context, callId).isError).toBe(false);
			result = getMessageText(toolResult(context, callId));
			return fauxAssistantMessage("Checked.");
		},
	]);
	await harness.session.prompt("Discover earlier evidence.");
	return { page: JSON.parse(result.slice(result.indexOf("{"))), chars: result.length };
}

it("measures evidence-only retrieval and bounded tool cost independently of coding accuracy across many archives", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	const expected = new Map<string, string>();
	let firstLeaf = "";
	for (let index = 0; index < 45; index++) {
		const identifier = `翡翠${1000 + index}`;
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt(`SharedEvidence ${identifier}: owner Mira. ${"record ".repeat(6_500)}`);
		const archive = await compactPriorHistory(harness, "Investigation complete.", `archive-${index}`);
		expected.set(identifier, archive.archiveId);
		if (index === 0) firstLeaf = harness.sessionManager.getLeafId()!;
	}
	const callsBefore = harness.faux.state.callCount;
	let found = 0;
	let maxReceiptChars = 0;
	const started = performance.now();
	for (const [identifier, archiveId] of expected) {
		const { page, chars } = await discover(harness, identifier);
		maxReceiptChars = Math.max(maxReceiptChars, chars);
		if (page.archives[0]?.archiveId === archiveId) found++;
		expect(page.archives[0].evidence?.[0].archive_id).toBe(archiveId);
		const original = harness.sessionManager.getEntry(page.archives[0].evidence![0].entry_id);
		expect(original?.type === "message" && getMessageText(original.message)).toContain(identifier);
		expect(page.instruction).toContain("non-exhaustive");
	}
	const retrievalMs = performance.now() - started;
	expect(found).toBe(expected.size);
	// Each lookup consumes only the parent call and continuation, never a helper/model search request.
	expect(harness.faux.state.callCount - callsBefore).toBe(2 * expected.size);
	expect(maxReceiptChars).toBeLessThan(1_500);
	console.info(
		JSON.stringify({
			metric: "goal-discovery",
			queries: expected.size,
			top1: found / expected.size,
			maxReceiptChars,
			retrievalMs,
			searchHelperRequests: 0,
		}),
	);
	for (const query of ["SharedEvidence", "Investigation complete", "*"]) {
		const all: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const { page, chars } = await discover(harness, query, cursor);
			expect(page.archives.length).toBeLessThanOrEqual(20);
			expect(chars).toBeLessThan(12_000);
			all.push(...page.archives.map((archive) => archive.archiveId));
			cursor = page.next_cursor;
			pages++;
		} while (cursor && pages < 4);
		expect(cursor).toBeUndefined();
		expect(all).toHaveLength(45);
		expect(new Set(all).size).toBe(45);
		const again = await discover(harness, query);
		expect(again.page.archives.map((archive) => archive.archiveId)).toEqual(all.slice(0, 20));
		if (query !== "SharedEvidence") expect(all).toEqual([...expected.values()]);
	}
	await harness.session.navigateTree(firstLeaf);
	expect((await discover(harness, "翡翠1044")).page.archives).toEqual([]);
	expect((await discover(harness, "翡翠1000")).page.archives[0].archiveId).toBe("ctx-0001");
});

it("excludes opaque provider metadata and sibling evidence, and keeps tied ordering deterministic", async () => {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 50_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0 } },
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage([
			{
				type: "thinking",
				thinking: "Visible reasoning receiptAmber.",
				thinkingSignature: "opaquesignaturesentinel",
			},
			{ type: "text", text: "Visible output receiptViolet.", textSignature: "opaquetextsentinel" },
		]),
		fauxAssistantMessage("Reviewed."),
	]);
	await harness.session.prompt(`ReceiptRésumé739 was accepted. ${"record ".repeat(12_000)}`);
	await harness.session.prompt("Review the observation.");
	await harness.session.setGoalModeEnabled(true);
	await compactPriorHistory(harness, "Completed.", "archive");
	for (const query of ["receiptAmber", "receiptViolet", "ReceiptRe\u0301sume\u0301739"]) {
		expect((await discover(harness, query)).page.archives[0].archiveId).toBe("ctx-0001");
	}
	for (const query of ["opaquesignaturesentinel", "opaquetextsentinel", "a and the", "unsharedsynonym"]) {
		const { page } = await discover(harness, query);
		expect(page.archives).toEqual([]);
		expect(page.instruction).toContain("alternate terms");
	}
	const branch = harness.sessionManager.getBranch();
	const archive = readGoalArchives(branch).get("ctx-0001")!;
	const missing = branch.filter((entry) => !archive.entryIds.includes(entry.id));
	expect(new GoalArchiveDiscovery(missing).search("ReceiptRésumé739")).toEqual([]);
	const index = new GoalArchiveDiscovery(branch);
	const tied = index.search("Completed");
	expect(new GoalArchiveDiscovery(structuredClone(branch)).search("Completed")).toEqual(tied);
});

it("rejects oversized queries and foreign pagination cursors before making recall requests", async () => {
	const harness = await createHarness();
	harnesses.push(harness);
	await harness.session.setGoalModeEnabled(true);
	for (const args of [{ query: "x".repeat(2_001) }, { query: "*", cursor: "ctx-9999" }]) {
		let final: Context | undefined;
		const calls = harness.faux.state.callCount;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("query_block", args, { id: "invalid" }), { stopReason: "toolUse" }),
			(context) => {
				final = context;
				return fauxAssistantMessage("Received.");
			},
		]);
		await harness.session.prompt("Find evidence.");
		expect(toolResult(final!, "invalid").isError).toBe(true);
		expect(harness.faux.state.callCount - calls).toBe(2);
	}
});
