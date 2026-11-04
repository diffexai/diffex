import { type Context, fauxAssistantMessage, fauxToolCall, type ImageContent } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { GoalRecallRetrieval, type RecallSearchHit } from "../../src/core/goal-retrieval.ts";
import { compactPriorHistory, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function hits(text: string): RecallSearchHit[] {
	return (JSON.parse(text) as { hits: RecallSearchHit[] }).hits;
}

describe("selective goal recall", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});
	async function archive(evidence: string, images?: ImageContent[]) {
		const harness = await createHarness({
			models: [{ id: "recall", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt(evidence, { images });
		await harness.session.setGoalModeEnabled(true);
		const { archiveId } = await compactPriorHistory(
			harness,
			"Investigation complete. Summary-only unicorn.",
			"archive",
		);
		return { harness, archiveId };
	}

	it("ranks original evidence chunks, keeps IDs stable, and bounds pages independently of the context window", async () => {
		const evidence = `${"ordinary deployment logs ".repeat(4_000)}\nNeedle receipt cobalt-739: owner Mira; status approved.\nFollowing context: approval applies only to staging.`;
		const { harness, archiveId } = await archive(evidence);
		const branch = harness.sessionManager.getBranch();
		const small = new GoalRecallRetrieval(branch, archiveId, 50_000, false);
		const large = new GoalRecallRetrieval(branch, archiveId, 1_000_000, false);
		const result = small.search("cobalt-739 Mira");
		const found = hits(result.text);
		expect(found[0].excerpt).toContain("cobalt-739");
		expect(found[0].archive_id).toBe(archiveId);
		expect(result.text.length).toBeLessThanOrEqual(6_000);
		expect(hits(large.search("cobalt-739 Mira").text)).toEqual(found);
		expect(hits(small.search("unicorn").text)).toEqual([]);
		const smallPage = small.expand(found[0].chunk_id);
		const largePage = large.expand(found[0].chunk_id);
		expect(smallPage).toEqual(largePage);
		expect(smallPage.text).toContain("approval applies only to staging");
		expect(smallPage.text.length).toBeLessThan(13_000);
		expect(smallPage.text).not.toContain(evidence);
		const fork = harness.sessionManager.forkBranch(harness.sessionManager.getLeafId()!);
		expect(new GoalRecallRetrieval(fork.getBranch(), archiveId, 50_000, false).expand(found[0].chunk_id)).toEqual(
			smallPage,
		);
	});

	it("provides initial hits before the first recall request and keeps searches and expanded pages private", async () => {
		const { harness, archiveId } = await archive(
			`${"unrelated evidence ".repeat(6_000)}\nReceipt cobalt-739: owner Mira; status approved. Internal evidence sentinel: cedar.`,
		);
		const children: Context[] = [];
		let final: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("query_block", { archive_id: archiveId, query: "cobalt-739" }, { id: "recall" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				children.push(structuredClone(context));
				const first = context.messages.map(getMessageText).join("\n");
				expect(first).toContain("Initial search results:");
				expect(first).toContain("owner Mira; status approved");
				expect(context.messages.some((message) => message.role === "toolResult")).toBe(false);
				return fauxAssistantMessage(fauxToolCall("search_blocks", { query: "Mira approved" }, { id: "search" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				children.push(structuredClone(context));
				const found = hits(getMessageText(toolResult(context, "search")));
				return fauxAssistantMessage(
					fauxToolCall("expand_block", { block_id: found[0].chunk_id }, { id: "expand" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				children.push(structuredClone(context));
				const page = JSON.parse(getMessageText(toolResult(context, "expand"))) as {
					evidence: string;
					chunk_id: string;
				};
				expect(page.evidence).toContain("owner Mira; status approved");
				return fauxAssistantMessage(`Mira approved cobalt-739 [${page.chunk_id}].`);
			},
			(context) => {
				final = structuredClone(context);
				return fauxAssistantMessage("Received.");
			},
		]);
		await harness.session.prompt("Recall receipt cobalt-739.");
		expect(children).toHaveLength(3);
		expect(children[0].tools?.map((tool) => tool.name)).toEqual(["search_blocks", "expand_block"]);
		expect(children[0].systemPrompt).toBe(children[2].systemPrompt);
		expect(children[0].tools).toEqual(children[2].tools);
		expect(final?.tools?.map((tool) => tool.name)).not.toContain("search_blocks");
		expect(JSON.stringify(final)).not.toContain("cedar");
		expect(
			harness.session.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).not.toContain("search_blocks");
		expect(getMessageText(toolResult(final!, "recall"))).toContain("Mira approved cobalt-739");
	});

	it("searches reachable references but never unrelated archives, forged chunks, or sibling entries", async () => {
		const { harness, archiveId } = await archive(`Root secret amber. ${"archived evidence ".repeat(6_000)}`);
		const firstLeaf = harness.sessionManager.getLeafId()!;
		harness.setResponses([fauxAssistantMessage("Later.")]);
		await harness.session.prompt(`Later secret violet. ${"new evidence ".repeat(7_000)}`);
		const second = await compactPriorHistory(harness, "Two investigations.", "second");
		const reachable = new GoalRecallRetrieval(harness.sessionManager.getBranch(), second.archiveId, 50_000, false);
		expect(hits(reachable.search("amber").text)[0].archive_id).toBe(archiveId);
		const narrow = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 50_000, false);
		expect(hits(narrow.search("violet").text)).toEqual([]);
		const laterChunk = hits(reachable.search("violet").text)[0].chunk_id;
		expect(() => narrow.expand(laterChunk)).toThrow("outside");
		expect(() => narrow.expand(second.archiveId)).toThrow("outside");
		expect(() => narrow.expand(`${archiveId}/forged/0/0`)).toThrow("outside");
		const sibling = harness.sessionManager.forkBranch(firstLeaf);
		expect(() => new GoalRecallRetrieval(sibling.getBranch(), second.archiveId, 50_000, false)).toThrow(
			"unavailable",
		);
	});

	it("supports empty searches, bounded browsing, distinct pages, and invalid cursor rejection", async () => {
		const { harness, archiveId } = await archive(`Start marker. ${"old evidence ".repeat(8_000)} End marker.`);
		const retrieval = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 50_000, false);
		expect(hits(retrieval.search("nonexistentzz").text)).toEqual([]);
		expect(hits(retrieval.search("the and what").text)).toEqual([]);
		const page = JSON.parse(retrieval.expand(archiveId).text) as { evidence: string; next_cursor: string };
		expect(page.evidence).toContain("Start marker");
		expect(page.next_cursor).toBeTruthy();
		const next = JSON.parse(retrieval.expand(archiveId, page.next_cursor).text) as {
			start: number;
			evidence: string;
		};
		expect(next.start).toBe(Number(page.next_cursor));
		expect(next.evidence).not.toContain("Start marker");
		expect(JSON.parse(retrieval.expand(archiveId).text)).toEqual({ already_provided: true });
		for (const cursor of ["", "-1", "NaN", "999999999999999999999", "image:999:0"])
			expect(() => retrieval.expand(archiveId, cursor)).toThrow("cursor");
		expect(retrieval.limitation).toContain("do not establish absence");
	});

	it("charges initial search, repeated search, JSON escaping, and expansion against one cumulative budget", async () => {
		const { harness, archiveId } = await archive(`Needle. ${'quoted "evidence" \\ logs '.repeat(5_000)}`);
		const retrieval = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 8_000, false);
		const initial = retrieval.search("Needle");
		expect(retrieval.remainingChars).toBe(retrieval.maxRetrievalChars - initial.text.length);
		let delivered = initial.text.length;
		for (let index = 0; index < 100; index++) {
			const result = retrieval.search("evidence logs");
			if (result.text.includes('"limit_reached":true')) break;
			delivered += result.text.length;
		}
		expect(delivered).toBeLessThanOrEqual(retrieval.maxRetrievalChars);
		expect(retrieval.expand(archiveId).text).toContain('"limit_reached":true');
		expect(retrieval.limitation).toContain("budget exhausted");
		expect(retrieval.remainingChars).toBeGreaterThanOrEqual(0);
	});

	it("finds identifiers near chunk boundaries, ranks rare evidence, and returns bounded surrounding context", async () => {
		const observations = Array.from(
			{ length: 40 },
			(_, index) =>
				`${"routine ".repeat(295)} Observation releaseReceipt${index}: ${index === 17 ? "superseded" : "approved"}.\n`,
		);
		const { harness, archiveId } = await archive(observations.join(""));
		for (const index of [0, 1, 8, 17, 29, 39]) {
			const retrieval = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 50_000, false);
			const found = hits(retrieval.search(`releaseReceipt${index}`).text);
			expect(found.length).toBeGreaterThan(0);
			const pages = found.map((hit) => retrieval.expand(hit.chunk_id, undefined, 1_024).text).join("\n");
			expect(pages).toContain(`releaseReceipt${index}: ${index === 17 ? "superseded" : "approved"}`);
		}
	});

	it("paginates images, charges their budget, and preserves chunk IDs across model image capabilities", async () => {
		const images: ImageContent[] = Array.from({ length: 3 }, () => ({
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZgAAAABJRU5ErkJggg==",
		}));
		const { harness, archiveId } = await archive("routine evidence ".repeat(6_000), images);
		const visual = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 50_000, true);
		const textOnly = new GoalRecallRetrieval(harness.sessionManager.getBranch(), archiveId, 50_000, false);
		const visualHits = hits(visual.search("image png").text);
		expect(hits(textOnly.search("image png").text)).toEqual(visualHits);
		const chunk = visualHits[0].chunk_id;
		let cursor: string | undefined;
		for (let index = 0; index < 3; index++) {
			const before = visual.remainingChars;
			const page = visual.expand(chunk, cursor);
			expect(page.images).toHaveLength(1);
			expect(page.images[0]).toEqual(images[index]);
			expect(before - visual.remainingChars).toBe(page.text.length + 6_000);
			cursor = (JSON.parse(page.text) as { next_cursor?: string }).next_cursor;
		}
		expect(cursor).toBeUndefined();
		expect(textOnly.expand(chunk).images).toEqual([]);
		expect(textOnly.limitation).toContain("images cannot be inspected");
	});

	it("reports missing original evidence without searching entries from outside the branch", async () => {
		const { harness, archiveId } = await archive(`Needle private. ${"routine evidence ".repeat(6_000)}`);
		const branch = harness.sessionManager.getBranch();
		const original = branch.find((entry) => entry.type === "message" && entry.message.role === "user")!;
		const retrieval = new GoalRecallRetrieval(
			branch.filter((entry) => entry.id !== original.id),
			archiveId,
			50_000,
			false,
		);
		expect(hits(retrieval.search("Needle private").text)).toEqual([]);
		expect(retrieval.limitation).toContain("Missing original evidence");
	});

	it("stops retrieval near the child context limit and reports an incomplete answer", async () => {
		const { harness, archiveId } = await archive(`Needle. ${"routine evidence ".repeat(6_000)}`);
		await harness.session.setModel({ ...harness.getModel(), contextWindow: 16_000 });
		const expansion = fauxAssistantMessage(
			[
				{ type: "text", text: "Reviewing evidence. ".repeat(1_100) },
				fauxToolCall("expand_block", { block_id: archiveId }, { id: "expand-limit" }),
			],
			{ stopReason: "toolUse" },
		);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("query_block", { archive_id: archiveId, query: "Needle" }, { id: "recall-limit" }),
				{ stopReason: "toolUse" },
			),
			expansion,
			(context) => {
				expect(getMessageText(toolResult(context, "expand-limit"))).toContain("context limit reached");
				expect(context.tools ?? []).toHaveLength(0);
				return fauxAssistantMessage("Only the initial observation is known.");
			},
			(context) => {
				expect(getMessageText(toolResult(context, "recall-limit"))).toContain("answer may be incomplete");
				return fauxAssistantMessage("Received.");
			},
		]);
		await harness.session.prompt("Recall the needle.");
		expect(
			harness.session.messages
				.filter((message) => message.role === "assistant" && message.stopReason === "error")
				.map((message) => (message.role === "assistant" ? message.errorMessage : "")),
		).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getLastAssistantText()).toBe("Received.");
	});
});
