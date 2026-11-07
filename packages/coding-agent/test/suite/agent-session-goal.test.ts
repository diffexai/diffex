import type { Context, Message } from "@diffexai/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getCollaborationMode, setCollaborationMode } from "../../src/core/collaboration-mode.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import { liveIds as catalogLiveIds, goalControls } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

function snapshots(messages: Message[]): string[] {
	return messages.map(getMessageText).filter((text) => /Context usage: approximately \d+%\./.test(text));
}

function resultFor(messages: Message[], id: string): string {
	const result = messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
	expect(result, `Missing tool result for ${id}`).toBeDefined();
	return getMessageText(result);
}

describe("experimental goal mode", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it("discovers the interactive command", () => {
		expect(BUILTIN_SLASH_COMMANDS.filter((command) => command.name === "goal")).toHaveLength(1);
	});

	it("starts disabled, registers both tools on enable, and stops adding notes on exit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const goal = goalControls(harness);
		expect(goal.isGoalModeEnabled).toBe(false);
		expect(harness.session.getActiveToolNames()).not.toContain("compact_block");
		expect(harness.session.getActiveToolNames()).not.toContain("query_block");

		await goal.setGoalModeEnabled(true);
		expect(goal.isGoalModeEnabled).toBe(true);
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["compact_block", "query_block"]));
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("first answer");
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("second answer");
			},
		]);
		await harness.session.prompt("first request");
		expect(snapshots(requests[0].messages)).toHaveLength(1);
		await goal.setGoalModeEnabled(false);
		await harness.session.prompt("second request");
		expect(goal.isGoalModeEnabled).toBe(false);
		expect(harness.session.getActiveToolNames()).not.toContain("compact_block");
		expect(snapshots(requests[1].messages)).toEqual(snapshots(requests[0].messages));
	});

	it("keeps goal independent of Plan mode and does not widen Plan filesystem tools", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const goal = goalControls(harness);
		setCollaborationMode(harness.session, "plan");
		await goal.setGoalModeEnabled(true);
		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["compact_block", "query_block"]));
		expect(harness.session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["bash"]));
		expect(harness.session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["write"]));
		await goal.setGoalModeEnabled(false);
		expect(getCollaborationMode(harness.session)).toBe("plan");
	});

	it("restores the selected branch's mode on resume and fork", async () => {
		const original = await createHarness();
		harnesses.push(original);
		original.setResponses([fauxAssistantMessage("before"), fauxAssistantMessage("enabled")]);
		await original.session.prompt("before enabling");
		const disabledLeaf = original.sessionManager.getLeafId();
		if (!disabledLeaf) throw new Error("Missing disabled branch point");
		await goalControls(original).setGoalModeEnabled(true);
		await original.session.prompt("while enabled");
		const enabledLeaf = original.sessionManager.getLeafId();
		if (!enabledLeaf) throw new Error("Missing enabled branch point");

		for (const [leaf, expected] of [
			[disabledLeaf, false],
			[enabledLeaf, true],
		] as const) {
			const resumed = await createHarness({ sessionManager: original.sessionManager.forkBranch(leaf) });
			harnesses.push(resumed);
			expect(goalControls(resumed).isGoalModeEnabled).toBe(expected);
			expect(resumed.session.getActiveToolNames().includes("compact_block")).toBe(expected);
		}
		const resumed = await createHarness({ sessionManager: original.sessionManager });
		harnesses.push(resumed);
		expect(goalControls(resumed).isGoalModeEnabled).toBe(true);
	});

	it("does not change the global evolution preference when toggled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const goal = goalControls(harness);
		harness.settingsManager.setEvolutionEnabled(true);
		await goal.setGoalModeEnabled(true);
		expect(harness.settingsManager.getEvolutionEnabled()).toBe(true);
		harness.settingsManager.setEvolutionEnabled(false);
		await goal.setGoalModeEnabled(false);
		expect(harness.settingsManager.getEvolutionEnabled()).toBe(false);
	});

	it("rejects transitions while a tool is running", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const harness = await createHarness({
			tools: [
				{
					name: "wait",
					label: "Wait",
					description: "Wait for the test",
					parameters: Type.Object({}),
					async execute() {
						started.resolve();
						await release.promise;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		const goal = goalControls(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const run = harness.session.prompt("wait");
		try {
			await started.promise;
			await goal.setGoalModeEnabled(true).catch(() => undefined);
			expect(goal.isGoalModeEnabled).toBe(false);
			expect(harness.session.getActiveToolNames()).not.toContain("compact_block");
		} finally {
			release.resolve();
			await run;
		}
		await goal.setGoalModeEnabled(true);
		expect(goal.isGoalModeEnabled).toBe(true);
	});

	it.each([false, true])(
		"rejects a goal transition during direct shell execution (initially enabled: %s)",
		async (enabled) => {
			const started = deferred<void>();
			const release = deferred<void>();
			const harness = await createHarness();
			harnesses.push(harness);
			const goal = goalControls(harness);
			if (enabled) await goal.setGoalModeEnabled(true);
			const execution = harness.session.executeBash("controlled command", undefined, {
				operations: {
					async exec() {
						started.resolve();
						await release.promise;
						return { exitCode: 0 };
					},
				},
			});
			try {
				await started.promise;
				await goal.setGoalModeEnabled(!enabled).catch(() => undefined);
				expect(goal.isGoalModeEnabled).toBe(enabled);
			} finally {
				release.resolve();
				await execution;
			}
			await goal.setGoalModeEnabled(!enabled);
			expect(goal.isGoalModeEnabled).toBe(!enabled);
		},
	);

	it("rejects transitions during manual compaction", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(extension) =>
					extension.on("session_before_compact", async (event) => {
						started.resolve();
						await release.promise;
						return {
							compaction: {
								summary: "Manual summary.",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("First request.");
		await harness.session.prompt("Second request.");
		const goal = goalControls(harness);
		const compaction = harness.session.compact();
		try {
			await started.promise;
			await goal.setGoalModeEnabled(true).catch(() => undefined);
			expect(goal.isGoalModeEnabled).toBe(false);
		} finally {
			release.resolve();
			await compaction;
		}
	});

	it.each([false, true])("adds one immutable note after a parallel batch (tool error: %s)", async (fails) => {
		const harness = await createHarness({
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Test tool",
					parameters: Type.Object({ value: Type.String() }),
					async execute(_id, input) {
						const args = input as { value: string };
						if (fails && args.value === "second") throw new Error("probe failed");
						return { content: [{ type: "text", text: args.value }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(
					[
						fauxToolCall("probe", { value: "first" }, { id: "first" }),
						fauxToolCall("probe", { value: "second" }, { id: "second" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("run the probes");
		expect(requests).toHaveLength(2);
		expect(snapshots(requests[0].messages)).toHaveLength(1);
		expect(snapshots(requests[1].messages)).toHaveLength(2);
		expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
		expect(resultFor(requests[1].messages, "first")).toContain("first");
		if (fails) expect(resultFor(requests[1].messages, "second")).toContain("probe failed");
	});

	it("rejects compact_block below 40 percent without calling the summarizer", async () => {
		const harness = await createHarness({ models: [{ id: "large", contextWindow: 1_000_000 }] });
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(
					fauxToolCall("compact_block", { start_id: "b001", end_id: "b001" }, { id: "compact" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("continue the task");
		expect(requests).toHaveLength(2);
		expect(resultFor(requests[1].messages, "compact")).toContain(
			"Cannot compact below 40% context usage. Continue the task.",
		);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each(["stale", "reversed"] as const)("rejects a %s range without replacing history", async (kind) => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		const first = `First historical request. ${"a".repeat(60_000)}`;
		const second = `Second historical request. ${"b".repeat(60_000)}`;
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt(first);
		await harness.session.prompt(second);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		let ids: string[] = [];
		const before = harness.faux.state.callCount;
		harness.setResponses([
			(context) => {
				ids = catalogLiveIds(context);
				const start = kind === "stale" ? "b999999" : (ids.at(-1) ?? "missing");
				const end = kind === "stale" ? "b999999" : (ids[0] ?? "missing");
				return fauxAssistantMessage(
					fauxToolCall("compact_block", { start_id: start, end_id: end }, { id: "invalid" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("Continue the investigation.");
		if (kind === "reversed") expect(ids.length).toBeGreaterThan(1);
		expect(requests).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(before + 2);
		const result = requests[0].messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "invalid",
		);
		expect(result).toMatchObject({ isError: true });
		expect(requests[0].messages.map(getMessageText)).toEqual(expect.arrayContaining([first, second]));
	});

	it("keeps context tool schemas and ordering stable as usage rises above 40 percent", async () => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Test tool",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("second");
			},
		]);
		await harness.session.prompt("short request");
		await harness.session.prompt(`Additional task evidence: ${"history ".repeat(14_000)}`);
		expect(requests).toHaveLength(2);
		const firstUsage = snapshots(requests[0].messages)
			.at(-1)
			?.match(/approximately (\d+)%/);
		const secondUsage = snapshots(requests[1].messages)
			.at(-1)
			?.match(/approximately (\d+)%/);
		expect(Number(firstUsage?.[1])).toBeLessThan(40);
		expect(Number(secondUsage?.[1])).toBeGreaterThanOrEqual(40);
		expect(requests[0].tools).toEqual(requests[1].tools);
		expect(requests[0].tools?.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["compact_block", "query_block"]),
		);
	});

	it("allows a recall query and an ordinary tool in the same low-usage batch", async () => {
		let executions = 0;
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 1_000_000 }],
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Test tool",
					parameters: Type.Object({}),
					async execute() {
						executions++;
						return { content: [{ type: "text", text: "probe executed" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("query_block", { archive_id: "ctx-9999", query: "What happened?" }, { id: "query" }),
					fauxToolCall("probe", {}, { id: "probe" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Query an unavailable archive and run the probe.");
		expect(executions).toBe(1);
		expect(resultFor(requests[0].messages, "probe")).toContain("probe executed");
		expect(resultFor(requests[0].messages, "query")).not.toContain("Cannot compact below 40%");
		expect(
			requests[0].messages.find((message) => message.role === "toolResult" && message.toolCallId === "query"),
		).toMatchObject({ isError: true });
	});

	it("compacts prior history and recalls the archive after goal mode is disabled", async () => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		const original = `Evidence: the release is blocked by the blue gate. ${"history ".repeat(14_000)}`;
		harness.setResponses([fauxAssistantMessage("The blue gate blocks the release.")]);
		await harness.session.prompt(original);
		const goal = goalControls(harness);
		await goal.setGoalModeEnabled(true);
		const requests: Context[] = [];
		let liveIds: string[] = [];
		let archiveId = "";
		const longAnswer = `The release is blocked by the blue gate. ${"Supporting evidence. ".repeat(2_000)}`;
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				liveIds = catalogLiveIds(context);
				return fauxAssistantMessage(
					fauxToolCall(
						"compact_block",
						{ start_id: liveIds[0] ?? "missing", end_id: liveIds.at(-1) ?? "missing" },
						{ id: "compact" },
					),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Decision: the release remains blocked by the blue gate.");
			},
			(context) => {
				requests.push(structuredClone(context));
				archiveId = resultFor(context.messages, "compact").match(/ctx-\d+/)?.[0] ?? "";
				return fauxAssistantMessage("Compaction complete.");
			},
		]);
		await harness.session.prompt("Preserve the earlier decision and continue.");
		expect(liveIds.length).toBeGreaterThan(0);
		expect(requests).toHaveLength(3);
		expect(requests[1].tools ?? []).toHaveLength(0);
		expect(requests[1].messages.map(getMessageText).join("\n")).toContain("release is blocked by the blue gate");
		expect(requests[1].messages.map(getMessageText).join("\n")).not.toContain("Context usage: approximately");
		expect(archiveId).toMatch(/^ctx-\d+$/);
		expect(resultFor(requests[2].messages, "compact")).toMatch(
			new RegExp(`^\\[context b\\d+\\]\\s+Compacted into ${archiveId}\\. Visible block IDs reassigned;`),
		);
		expect(requests[2].messages.map(getMessageText).join("\n")).toContain(
			"Decision: the release remains blocked by the blue gate.",
		);
		expect(requests[2].messages.map(getMessageText).join("\n")).not.toContain(original);

		await goal.setGoalModeEnabled(false);
		expect(harness.session.getActiveToolNames()).toContain("query_block");
		const recall: Context[] = [];
		harness.setResponses([
			(context) => {
				recall.push(structuredClone(context));
				return fauxAssistantMessage(
					fauxToolCall(
						"query_block",
						{ archive_id: archiveId, query: "What blocked the release?" },
						{ id: "recall" },
					),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				recall.push(structuredClone(context));
				return fauxAssistantMessage(longAnswer);
			},
			(context) => {
				recall.push(structuredClone(context));
				return fauxAssistantMessage("Recall received.");
			},
		]);
		await harness.session.prompt("What blocked the release?");
		expect(recall).toHaveLength(3);
		expect(recall[1].tools?.map((tool) => tool.name)).toEqual(["search_blocks", "expand_block"]);
		expect(recall[1].messages.map(getMessageText).join("\n")).toContain("release is blocked by the blue gate");
		expect(resultFor(recall[2].messages, "recall")).toContain(longAnswer);
		expect(recall[2].messages.slice(0, recall[0].messages.length)).toEqual(recall[0].messages);
	});

	it.each(["empty", "truncated", "tool-bearing", "non-reducing"] as const)(
		"keeps the original context when the summary is %s",
		async (kind) => {
			const harness = await createHarness({
				models: [{ id: "goal-model", contextWindow: 50_000 }],
				settings: { compaction: { enabled: false, reserveTokens: 0 } },
			});
			harnesses.push(harness);
			const original = `Original evidence. ${"history ".repeat(14_000)}`;
			harness.setResponses([fauxAssistantMessage("first answer")]);
			await harness.session.prompt(original);
			await goalControls(harness).setGoalModeEnabled(true);
			const requests: Context[] = [];
			let liveIds: string[] = [];
			const invalidSummary =
				kind === "empty"
					? fauxAssistantMessage("")
					: kind === "truncated"
						? fauxAssistantMessage("partial", { stopReason: "length" })
						: kind === "tool-bearing"
							? fauxAssistantMessage(fauxToolCall("bash", { command: "echo must-not-run" }), {
									stopReason: "toolUse",
								})
							: fauxAssistantMessage(original.repeat(2));
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					liveIds = catalogLiveIds(context);
					return fauxAssistantMessage(
						fauxToolCall(
							"compact_block",
							{ start_id: liveIds[0] ?? "missing", end_id: liveIds.at(-1) ?? "missing" },
							{ id: "compact" },
						),
						{ stopReason: "toolUse" },
					);
				},
				invalidSummary,
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("continued");
				},
			]);
			await harness.session.prompt("Continue the original task.");
			expect(liveIds.length).toBeGreaterThan(0);
			expect(requests).toHaveLength(2);
			const result = requests[1].messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "compact",
			);
			expect(result).toMatchObject({ isError: true });
			expect(requests[1].messages.map(getMessageText)).toContain(original);
			expect(resultFor(requests[1].messages, "compact")).not.toMatch(/Compacted into ctx-\d+/);
		},
	);

	it.each(["compact-first", "compact-last"])("rejects every tool in a mixed compaction batch (%s)", async (order) => {
		let executions = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "probe",
					label: "Probe",
					description: "Test tool",
					parameters: Type.Object({}),
					async execute() {
						executions++;
						return { content: [{ type: "text", text: "executed" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		const compact = fauxToolCall("compact_block", { start_id: "b001", end_id: "b001" }, { id: "compact" });
		const probe = fauxToolCall("probe", {}, { id: "probe" });
		harness.setResponses([
			fauxAssistantMessage(order === "compact-first" ? [compact, probe] : [probe, compact], {
				stopReason: "toolUse",
			}),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("run the batch");
		expect(executions).toBe(0);
		for (const id of ["compact", "probe"]) {
			const result = requests[0].messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === id,
			);
			expect(result).toMatchObject({ isError: true });
		}
	});
});
