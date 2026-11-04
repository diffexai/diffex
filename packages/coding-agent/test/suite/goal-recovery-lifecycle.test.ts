import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, estimateContextTokens, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { GoalRecallRetrieval } from "../../src/core/goal-retrieval.ts";
import { readGoalArchives, validateGoalProvenance } from "../../src/core/pocket-context.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { compactPriorHistory, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];

it("archives and retains whole tool exchanges during emergency recovery inside the tool loop", async () => {
	let reads = 0;
	const harness = await recoveryHarness({
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Inspect",
				parameters: Type.Object({}),
				async execute() {
					return {
						content: [
							{
								type: "text",
								text:
									reads++ === 0
										? `receipt739: owner Mira. ${"record ".repeat(9_000)}`
										: "recent ".repeat(4_000),
							},
						],
						details: {},
					};
				},
			},
		],
	});
	await harness.session.setGoalModeEnabled(true);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "old-probe" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "recent-probe" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Investigation completed."),
		(context) => {
			expect(
				context.messages.some((message) => message.role === "toolResult" && message.toolCallId === "old-probe"),
			).toBe(false);
			expect(toolResult(context, "recent-probe").isError).toBe(false);
			return fauxAssistantMessage("Continued.");
		},
	]);
	await harness.session.prompt("Inspect the deployment evidence in two probes.");
	expect(harness.getPendingResponseCount()).toBe(0);
	expect(harness.session.getGoalDiagnostics().emergencyCompactions).toBe(1);
	const archive = readGoalArchives(harness.sessionManager.getBranch()).get("ctx-0001")!;
	const removed = archive.entryIds.flatMap((id) => {
		const entry = harness.sessionManager.getEntry(id);
		return entry?.type === "message" ? [entry.message] : [];
	});
	expect(
		removed.some(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.id === "old-probe"),
		),
	).toBe(true);
	expect(removed.some((message) => message.role === "toolResult" && message.toolCallId === "old-probe")).toBe(true);
	expect(removed.some((message) => message.role === "toolResult" && message.toolCallId === "recent-probe")).toBe(
		false,
	);
	await recall(harness, "ctx-0001", "receipt739");
});

afterEach(async () => {
	vi.restoreAllMocks();
	while (harnesses.length) await harnesses.pop()?.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function recoveryHarness(options: HarnessOptions = {}) {
	const harness = await createHarness({
		models: [{ id: "goal", contextWindow: 32_000, maxTokens: 8_000 }],
		settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 }, retry: { enabled: false } },
		...options,
	});
	harnesses.push(harness);
	return harness;
}

async function recall(harness: Harness, archiveId: string, identifier: string) {
	let evidence = "";
	let result = "";
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("query_block", { archive_id: archiveId, query: identifier }, { id: `recall-${identifier}` }),
			{ stopReason: "toolUse" },
		),
		(context) => {
			evidence = context.messages.map(getMessageText).join("\n");
			const receipt = evidence.match(new RegExp(`${identifier}: owner ([A-Za-z]+)`));
			return fauxAssistantMessage(
				receipt ? `${identifier}: owner ${receipt[1]} [${archiveId}].` : "Missing evidence.",
			);
		},
		(context) => {
			result = getMessageText(toolResult(context, `recall-${identifier}`));
			return fauxAssistantMessage("Received.");
		},
	]);
	await harness.session.prompt(`Recall ${identifier}.`);
	expect(evidence).toContain(`${identifier}: owner Mira`);
	expect(result).toContain(`${identifier}: owner Mira`);
	expect(harness.getPendingResponseCount()).toBe(0);
}

it("recalls exact evidence after repeated oversized recovery, export, resume, and forks", async () => {
	const harness = await recoveryHarness();
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(`receipt739: owner Mira. ${"evidence ".repeat(10_000)}`);
	await harness.session.setGoalModeEnabled(true);
	const beforeRecovery = harness.sessionManager.getLeafId()!;
	const calls = harness.faux.state.callCount;
	harness.setResponses([
		(context) => {
			expect(estimateContextTokens(context).tokens + 8_000 + 4_096).toBeLessThan(32_000);
			expect(context.messages.map(getMessageText).join("\n")).toContain("without a generated summary");
			return fauxAssistantMessage("Continued.");
		},
	]);
	await harness.session.prompt("Continue.");
	expect(harness.faux.state.callCount - calls).toBe(1);
	await recall(harness, "ctx-0001", "receipt739");
	await harness.session.setModel({ ...harness.getModel(), contextWindow: 200_000 });
	harness.setResponses([fauxAssistantMessage("Recorded second investigation.")]);
	await harness.session.prompt(`receipt840: owner Mira. ${"later evidence ".repeat(8_000)}`);
	await harness.session.setModel(harness.getModel());
	harness.setResponses([fauxAssistantMessage("Recovered again.")]);
	await harness.session.prompt("Continue the second investigation.");
	const archives = readGoalArchives(harness.sessionManager.getBranch());
	expect(archives.size).toBe(2);
	expect(archives.get("ctx-0002")?.references).toContain("ctx-0001");
	expect(archives.get("ctx-0002")?.entryIds).not.toContain(archives.get("ctx-0001")?.entryIds[0]);
	validateGoalProvenance(harness.sessionManager.getBranch(), archives);
	const exported = harness.session.exportToJsonl(join(harness.tempDir, "recovered.jsonl"));
	for (const manager of [
		SessionManager.open(exported),
		harness.sessionManager.forkBranch(harness.sessionManager.getLeafId()!),
	]) {
		const restored = await recoveryHarness({ sessionManager: manager });
		restored.session.agent.state.messages = manager.buildSessionContext().messages;
		await recall(restored, "ctx-0002", "receipt739");
		await recall(restored, "ctx-0002", "receipt840");
	}
	const sibling = harness.sessionManager.forkBranch(beforeRecovery);
	expect(readGoalArchives(sibling.getBranch()).size).toBe(0);
	expect(() => new GoalRecallRetrieval(sibling.getBranch(), "ctx-0001", 32_000, false)).toThrow("unavailable");
});

it("preserves an existing voluntary archive through recovery and a later voluntary replacement", async () => {
	const harness = await recoveryHarness();
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(`receipt739: owner Mira. ${"record ".repeat(8_000)}`);
	await harness.session.setGoalModeEnabled(true);
	await compactPriorHistory(harness, "Investigation complete.", "voluntary");
	await harness.session.setModel({ ...harness.getModel(), contextWindow: 200_000 });
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(`receipt840: owner Mira. ${"evidence ".repeat(10_000)}`);
	await harness.session.setModel(harness.getModel());
	harness.setResponses([fauxAssistantMessage("Continued.")]);
	await harness.session.prompt("Continue.");
	expect(readGoalArchives(harness.sessionManager.getBranch()).get("ctx-0002")?.references).toContain("ctx-0001");
	harness.setResponses([fauxAssistantMessage("Recorded more work.")]);
	await harness.session.prompt("record ".repeat(7_000));
	await compactPriorHistory(harness, "All investigations completed.", "final-archive");
	expect(readGoalArchives(harness.sessionManager.getBranch()).get("ctx-0003")?.references).toContain("ctx-0002");
	await recall(harness, "ctx-0003", "receipt739");
	await recall(harness, "ctx-0003", "receipt840");
});

it.each(["stop", "length", "error", "aborted", "toolUse"] as const)(
	"commits no archive after a failed %s recovery summary",
	async (stopReason) => {
		const harness = await recoveryHarness();
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		const original = `receipt739: owner Mira. ${"record ".repeat(9_000)}`;
		await harness.session.prompt(original);
		await harness.session.setGoalModeEnabled(true);
		let summaryRequest: Context | undefined;
		harness.setResponses([
			(context, options) => {
				summaryRequest = context;
				expect(estimateContextTokens(context).tokens + (options?.maxTokens ?? 0) + 4_096).toBeLessThanOrEqual(
					32_000,
				);
				expect(options?.maxTokens).toBe(8_000);
				return fauxAssistantMessage(stopReason === "toolUse" ? fauxToolCall("unexpected", {}) : "", {
					stopReason,
					errorMessage: stopReason === "error" ? "invalid configuration" : undefined,
				});
			},
		]);
		await expect(harness.session.prompt("Continue. ".repeat(2_500))).rejects.toThrow(/compaction/);
		expect(summaryRequest).toBeDefined();
		expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(0);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
		expect(harness.session.messages.map(getMessageText)).toContain(original);
	},
);

it("reserves summary output headroom and recovers after a transient summarization retry", async () => {
	const harness = await recoveryHarness({
		settings: {
			compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 0 },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		},
	});
	harness.setResponses([fauxAssistantMessage("Recorded.")]);
	await harness.session.prompt(`receipt739: owner Mira. ${"record ".repeat(9_000)}`);
	await harness.session.setGoalModeEnabled(true);
	const requests: Context[] = [];
	harness.setResponses([
		(context) => {
			requests.push(context);
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
		},
		(context, options) => {
			requests.push(context);
			expect(estimateContextTokens(context).tokens + options!.maxTokens! + 4_096).toBeLessThanOrEqual(32_000);
			return fauxAssistantMessage("Investigation complete.");
		},
		(context) => {
			expect(estimateContextTokens(context).tokens + 8_000 + 4_096).toBeLessThan(32_000);
			return fauxAssistantMessage("Continued.");
		},
	]);
	await harness.session.prompt("Continue. ".repeat(2_500));
	expect(requests).toHaveLength(2);
	expect(requests[0].messages).toEqual(requests[1].messages);
	expect(readGoalArchives(harness.sessionManager.getBranch()).size).toBe(1);
	await recall(harness, "ctx-0001", "receipt739");
});

it.each(["cancel-before", "cancel-after", "write-failure", "context-change"] as const)(
	"keeps history and provenance atomic on %s",
	async (failure) => {
		const directory = mkdtempSync(join(tmpdir(), "goal-recovery-"));
		directories.push(directory);
		const manager = SessionManager.create(process.cwd(), directory);
		let harness: Harness;
		harness = await recoveryHarness({
			sessionManager: manager,
			extensionFactories: [
				(extension) => {
					extension.on("session_before_compact", (event) => {
						if (failure === "cancel-before") return { cancel: true };
						if (failure === "context-change") manager.appendCustomEntry("intervening", {});
						return {
							compaction: {
								summary: "Investigation completed.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					extension.on("session_compact", () => {
						if (failure === "cancel-after") harness.session.abortCompaction();
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		const original = `receipt739: owner Mira. ${"evidence ".repeat(10_000)}`;
		await harness.session.prompt(original);
		await harness.session.setGoalModeEnabled(true);
		if (failure === "write-failure") {
			const persist = manager._persist.bind(manager);
			vi.spyOn(manager, "_persist").mockImplementation((entry) => {
				if (entry.type === "compaction") throw new Error("injected write failure");
				persist(entry);
			});
		}
		await expect(harness.session.prompt("Continue.")).rejects.toThrow(/compaction/);
		for (const state of [manager, SessionManager.open(manager.getSessionFile()!)]) {
			expect(readGoalArchives(state.getBranch()).size).toBe(0);
			expect(state.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
			expect(state.buildSessionContext().messages.map(getMessageText)).toContain(original);
		}
	},
);

it.each([false, true])(
	"commits or rolls back deferred recovery provenance with prompt admission (cancel: %s)",
	async (cancel) => {
		const directory = mkdtempSync(join(tmpdir(), "goal-deferred-"));
		directories.push(directory);
		const manager = SessionManager.create(process.cwd(), directory);
		const harness = await recoveryHarness({
			sessionManager: manager,
			extensionFactories: [
				(extension) => {
					extension.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Investigation complete.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("Recorded.")]);
		await harness.session.prompt("receipt739: owner Mira.");
		await harness.session.setGoalModeEnabled(true);
		manager.appendMessage({
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			model: harness.getModel().id,
			provider: harness.getModel().provider,
		});
		harness.session.agent.state.messages = manager.buildSessionContext().messages;
		const controller = new AbortController();
		harness.setResponses([fauxAssistantMessage("Continued.")]);
		const run = harness.session.prompt("Continue.", {
			signal: controller.signal,
			preflightResult: (accepted) => {
				if (accepted && cancel) controller.abort(new Error("cancel admission"));
			},
		});
		if (cancel) await expect(run).rejects.toThrow("cancel admission");
		else await run;
		for (const state of [manager, SessionManager.open(manager.getSessionFile()!)]) {
			expect(readGoalArchives(state.getBranch()).size).toBe(cancel ? 0 : 1);
			expect(state.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(cancel ? 0 : 1);
		}
	},
);
