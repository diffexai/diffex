import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { compactPriorHistory, goalControls, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const originalEvidence = `The red deployment gate failed. ${"Historical evidence. ".repeat(6_000)}`;

// Adapt the reference-field matcher to the final versioned provenance format.
function replaceArchivedReference(value: unknown, originalId: string, brokenId: string, inReferences = false): boolean {
	if (typeof value !== "object" || value === null) return false;
	let changed = false;
	for (const [key, entry] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		const isReference = inReferences || /reference|refs/i.test(key);
		if (isReference && entry === originalId) {
			(value as Record<string, unknown>)[key] = brokenId;
			changed = true;
		} else if (replaceArchivedReference(entry, originalId, brokenId, isReference)) changed = true;
	}
	return changed;
}

async function queryArchive(harness: Harness, archiveId: string): Promise<Context[]> {
	const requests: Context[] = [];
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("query_block", { archive_id: archiveId, query: "What failed?" }, { id: "query" }),
			{ stopReason: "toolUse" },
		),
		(context) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage(`The red deployment gate failed, according to ${archiveId}.`);
		},
		(context) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage("Recall received.");
		},
	]);
	await harness.session.prompt("Recall the deployment result.");
	return requests;
}

describe("goal archive persistence", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it("replays the replacement and retains reachable evidence across resume, clone, and JSONL export", async () => {
		const original = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(original);
		original.setResponses([fauxAssistantMessage("The deployment gate failed.")]);
		await original.session.prompt(originalEvidence);
		await goalControls(original).setGoalModeEnabled(true);
		const beforeArchive = original.sessionManager.getLeafId();
		if (!beforeArchive) throw new Error("Missing branch point");
		const { archiveId } = await compactPriorHistory(
			original,
			"Decision: the red deployment gate failed.",
			"archive-1",
		);
		const afterArchive = original.sessionManager.getLeafId();
		if (!afterArchive) throw new Error("Missing archive leaf");
		const exported = original.session.exportToJsonl(join(original.tempDir, "goal-export.jsonl"));

		for (const sessionManager of [
			original.sessionManager,
			original.sessionManager.forkBranch(afterArchive),
			SessionManager.open(exported),
		]) {
			const restored = await createHarness({
				sessionManager,
				models: [{ id: "goal-model", contextWindow: 50_000 }],
				settings: { compaction: { enabled: false, reserveTokens: 0 } },
			});
			harnesses.push(restored);
			restored.session.agent.state.messages = sessionManager.buildSessionContext().messages;
			expect(goalControls(restored).isGoalModeEnabled).toBe(true);
			const requests = await queryArchive(restored, archiveId);
			expect(requests).toHaveLength(2);
			expect(requests[0].tools?.map((tool) => tool.name)).toEqual(["search_blocks", "expand_block"]);
			expect(requests[0].messages.map(getMessageText).join("\n")).toContain("red deployment gate failed");
			expect(getMessageText(toolResult(requests[1], "query"))).toContain(archiveId);
			const projection = requests[1].messages.map(getMessageText).join("\n");
			expect(projection).toContain("Decision: the red deployment gate failed.");
			expect(projection).not.toContain(originalEvidence);
		}

		const sibling = await createHarness({ sessionManager: original.sessionManager.forkBranch(beforeArchive) });
		harnesses.push(sibling);
		const requests: Context[] = [];
		sibling.setResponses([
			fauxAssistantMessage(
				fauxToolCall("query_block", { archive_id: archiveId, query: "What failed?" }, { id: "foreign" }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await sibling.session.prompt("Try the other branch's archive.");
		expect(requests).toHaveLength(1);
		expect(toolResult(requests[0], "foreign").isError).toBe(true);
		expect(getMessageText(toolResult(requests[0], "foreign"))).not.toContain("red deployment gate failed");
	});

	it("does not resurrect replaced history during ordinary manual compaction", async () => {
		const summaries: Context[] = [];
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The deployment gate failed.")]);
		await harness.session.prompt(originalEvidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const { archiveId } = await compactPriorHistory(
			harness,
			"Decision: the red deployment gate failed.",
			"archive-1",
		);
		harness.setResponses([
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("Ordinary summary: the red gate failed.");
			},
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("Retained turn context: the red gate failed.");
			},
		]);
		await harness.session.compact();
		expect(summaries.length).toBeGreaterThan(0);
		expect(summaries.map((context) => context.messages.map(getMessageText).join("\n")).join("\n")).not.toContain(
			originalEvidence,
		);
		const recall = await queryArchive(harness, archiveId);
		expect(getMessageText(toolResult(recall[1], "query"))).toContain(archiveId);
	});

	it("replays a durable commit captured before the tool result is appended", async () => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("The deployment gate failed.")]);
		await harness.session.prompt(originalEvidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const crashPath = join(harness.tempDir, "before-tool-result.jsonl");
		let captured = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "crash-commit" && !event.isError) {
				harness.session.exportToJsonl(crashPath);
				captured = true;
			}
		});
		const { archiveId } = await compactPriorHistory(
			harness,
			"Decision: the red deployment gate failed.",
			"crash-commit",
		);
		unsubscribe();
		expect(captured).toBe(true);
		const manager = SessionManager.open(crashPath);
		expect(
			manager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "crash-commit",
				),
		).toBe(false);
		const restored = await createHarness({
			sessionManager: manager,
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(restored);
		restored.session.agent.state.messages = manager.buildSessionContext().messages;
		const requests: Context[] = [];
		restored.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Recovered.");
			},
		]);
		await restored.session.prompt("Continue after restart.");
		expect(requests).toHaveLength(1);
		expect(getMessageText(toolResult(requests[0], "crash-commit"))).toContain(archiveId);
		expect(requests[0].messages.map(getMessageText).join("\n")).toContain(
			"Decision: the red deployment gate failed.",
		);
		expect(requests[0].messages.map(getMessageText).join("\n")).not.toContain(originalEvidence);
		const recall = await queryArchive(restored, archiveId);
		expect(getMessageText(toolResult(recall[1], "query"))).toContain(archiveId);
	});

	it("reports a corrupt archive reference without exposing unrelated evidence or resurrecting raw history", async () => {
		const original = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(original);
		original.setResponses([fauxAssistantMessage("The red gate failed.")]);
		await original.session.prompt(originalEvidence);
		await goalControls(original).setGoalModeEnabled(true);
		const first = await compactPriorHistory(original, "The red gate failed.", "archive-one");
		original.setResponses([fauxAssistantMessage("The green gate passed.")]);
		await original.session.prompt(`The green gate passed. ${"later evidence ".repeat(8_000)}`);
		const second = await compactPriorHistory(original, "The red gate failed; the green gate passed.", "archive-two");
		const path = original.session.exportToJsonl(join(original.tempDir, "corrupt-reference.jsonl"));
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		let replaced = false;
		for (let index = 0; index < lines.length; index++) {
			if (!lines[index].includes(first.archiveId) || !lines[index].includes(second.archiveId)) continue;
			const record: unknown = JSON.parse(lines[index]);
			if (replaceArchivedReference(record, first.archiveId, "ctx-999999")) {
				lines[index] = JSON.stringify(record);
				replaced = true;
				break;
			}
		}
		expect(replaced, "Expected a stored direct reference to corrupt").toBe(true);
		writeFileSync(path, `${lines.join("\n")}\n`);
		const manager = SessionManager.open(path);
		const restored = await createHarness({
			sessionManager: manager,
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(restored);
		restored.session.agent.state.messages = manager.buildSessionContext().messages;
		const requests: Context[] = [];
		const response = (context: Context) => {
			requests.push(structuredClone(context));
			return context.tools?.some((tool) => tool.name === "expand_block")
				? fauxAssistantMessage("Missing or corrupt referenced evidence; the earlier result cannot be verified.")
				: fauxAssistantMessage("Recall finished.");
		};
		restored.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"query_block",
					{ archive_id: second.archiveId, query: "What happened to both gates?" },
					{ id: "query" },
				),
				{ stopReason: "toolUse" },
			),
			response,
			response,
		]);
		await restored.session.prompt("Recall both gate results.");
		const parent = requests.find((context) =>
			context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "query"),
		);
		expect(parent).toBeDefined();
		if (!parent) throw new Error("Missing parent query result");
		expect(getMessageText(toolResult(parent, "query"))).toMatch(/missing|corrupt|unavailable|invalid/i);
		expect(parent.messages.map(getMessageText).join("\n")).not.toContain(originalEvidence);
		const child = requests.find((context) => context.tools?.some((tool) => tool.name === "expand_block"));
		if (child) expect(JSON.stringify(child.messages)).toMatch(/missing|corrupt|unavailable|invalid|ctx-999999/i);
	});

	it.each(["same", "changed"] as const)(
		"does not repeat a committed tool-call ID with %s arguments",
		async (argumentKind) => {
			const harness = await createHarness({
				models: [{ id: "goal-model", contextWindow: 50_000 }],
				settings: { compaction: { enabled: false, reserveTokens: 0 } },
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("The deployment gate failed.")]);
			await harness.session.prompt(originalEvidence);
			await goalControls(harness).setGoalModeEnabled(true);
			const committed = await compactPriorHistory(
				harness,
				"Decision: the red deployment gate failed.",
				"duplicate-id",
			);
			const arguments_ =
				argumentKind === "same"
					? { start_id: committed.selected[0], end_id: committed.selected.at(-1) }
					: { start_id: "b9999", end_id: "b9999" };
			const requests: Context[] = [];
			const callCount = harness.faux.state.callCount;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("compact_block", arguments_, { id: "duplicate-id" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("continued");
				},
			]);
			await harness.session.prompt("Continue after the recorded operation.");
			expect(harness.faux.state.callCount).toBe(callCount + 2);
			expect(requests).toHaveLength(1);
			const results = requests[0].messages.filter(
				(message): message is Extract<Context["messages"][number], { role: "toolResult" }> =>
					message.role === "toolResult" && message.toolCallId === "duplicate-id",
			);
			const result = results.at(-1);
			expect(result).toBeDefined();
			if (argumentKind === "changed") expect(result?.isError).toBe(true);
			else expect(result?.isError === true || getMessageText(result).includes(committed.archiveId)).toBe(true);
			const recall = await queryArchive(harness, committed.archiveId);
			expect(getMessageText(toolResult(recall[1], "query"))).toContain(committed.archiveId);
		},
	);
});
