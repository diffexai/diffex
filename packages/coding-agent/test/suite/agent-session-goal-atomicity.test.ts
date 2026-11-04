import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { goalControls, liveIds, toolResult } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const evidence = `Important original evidence. ${"older investigation ".repeat(6_000)}`;

describe("goal compaction atomicity", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length) await harnesses.pop()?.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("keeps both the live projection and durable history when the archive commit fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-goal-write-failure-"));
		directories.push(directory);
		const manager = SessionManager.create(process.cwd(), directory);
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Initial evidence recorded.")]);
		await harness.session.prompt(evidence);
		await goalControls(harness).setGoalModeEnabled(true);
		let attemptedWrite = false;
		let selected: string[] = [];
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				selected = liveIds(context);
				return fauxAssistantMessage(
					fauxToolCall(
						"compact_block",
						{ start_id: selected[0] ?? "missing", end_id: selected.at(-1) ?? "missing" },
						{ id: "compact" },
					),
					{ stopReason: "toolUse" },
				);
			},
			() => {
				vi.spyOn(manager, "_persist").mockImplementationOnce(() => {
					attemptedWrite = true;
					throw new Error("injected archive write failure");
				});
				return fauxAssistantMessage("Decision record that must not become active.");
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("Continue the investigation.").catch(() => undefined);
		expect(selected.length).toBeGreaterThan(0);
		expect(attemptedWrite).toBe(true);
		const active = JSON.stringify(harness.session.messages);
		expect(active).toContain(evidence);
		expect(active).not.toContain("Decision record that must not become active.");
		if (requests.length) expect(toolResult(requests[0], "compact").isError).toBe(true);
		const path = manager.getSessionFile();
		if (!path) throw new Error("Missing disk session path");
		const reopened = SessionManager.open(path);
		const restored = JSON.stringify(reopened.buildSessionContext().messages);
		expect(restored).toContain(evidence);
		expect(restored).not.toContain("Decision record that must not become active.");
	});

	it("rejects a selection when the session context changes after its catalog was presented", async () => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Initial evidence recorded.")]);
		await harness.session.prompt(evidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const requests: Context[] = [];
		let selected: string[] = [];
		const before = harness.faux.state.callCount;
		harness.setResponses([
			(context) => {
				selected = liveIds(context);
				const intervening = {
					role: "user" as const,
					content: [{ type: "text" as const, text: "Intervening genuine request." }],
					timestamp: Date.now(),
				};
				harness.sessionManager.appendMessage(intervening);
				harness.session.agent.state.messages.push(intervening);
				return fauxAssistantMessage(
					fauxToolCall(
						"compact_block",
						{ start_id: selected[0] ?? "missing", end_id: selected.at(-1) ?? "missing" },
						{ id: "stale" },
					),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("Continue the investigation.");
		expect(selected.length).toBeGreaterThan(0);
		expect(harness.faux.state.callCount).toBe(before + 2);
		expect(requests).toHaveLength(1);
		expect(toolResult(requests[0], "stale").isError).toBe(true);
		expect(requests[0].messages.map(getMessageText)).toEqual(
			expect.arrayContaining([evidence, "Intervening genuine request."]),
		);
	});
});
