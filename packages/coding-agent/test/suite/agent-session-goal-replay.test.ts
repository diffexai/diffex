import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { compactPriorHistory, goalControls, goalNotes } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const oldEvidence = `Older deployment evidence. ${"historical observations ".repeat(5_000)}`;
const laterEvidence = `Later deployment evidence. ${"more observations ".repeat(6_000)}`;

// The provenance-field name is an adapter for the final versioned record format.
function corruptProvenance(value: unknown, oldId: string, newValue: unknown, inReferences = false): boolean {
	if (typeof value !== "object" || value === null) return false;
	let changed = false;
	for (const [key, entry] of Object.entries(value)) {
		const isReference = inReferences || /reference|refs/i.test(key);
		if (isReference && entry === oldId) {
			(value as Record<string, unknown>)[key] = newValue;
			changed = true;
		} else if (corruptProvenance(entry, oldId, newValue, isReference)) changed = true;
	}
	return changed;
}

describe("goal session replay", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length) await harnesses.pop()?.cleanup();
	});

	it.each(["malformed", "cyclic"] as const)("does not silently activate %s stored provenance", async (kind) => {
		const original = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(original);
		original.setResponses([fauxAssistantMessage("Initial investigation complete.")]);
		await original.session.prompt(oldEvidence);
		await goalControls(original).setGoalModeEnabled(true);
		const first = await compactPriorHistory(original, "Initial deployment investigation.", "archive-1");
		original.setResponses([fauxAssistantMessage("Later investigation complete.")]);
		await original.session.prompt(laterEvidence);
		const second = await compactPriorHistory(original, "Both deployment investigations.", "archive-2");
		const path = original.session.exportToJsonl(join(original.tempDir, `provenance-${kind}.jsonl`));
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		let changed = false;
		for (let index = 0; index < lines.length; index++) {
			if (!lines[index].includes(first.archiveId) || !lines[index].includes(second.archiveId)) continue;
			const record: unknown = JSON.parse(lines[index]);
			if (corruptProvenance(record, first.archiveId, kind === "cyclic" ? second.archiveId : { invalid: true })) {
				lines[index] = JSON.stringify(record);
				changed = true;
				break;
			}
		}
		expect(changed, "Expected a versioned direct-reference field").toBe(true);
		writeFileSync(path, `${lines.join("\n")}\n`);
		let failure = "";
		let projection = "";
		let catalog = "";
		try {
			const manager = SessionManager.open(path);
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
					return fauxAssistantMessage("continued");
				},
			]);
			await restored.session.prompt("Continue the deployment task.");
			projection = requests.map((context) => context.messages.map(getMessageText).join("\n")).join("\n");
			catalog = requests.flatMap(goalNotes).join("\n");
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		if (failure) expect(failure).toMatch(/corrupt|invalid|cycle|provenance|reference/i);
		else {
			expect(projection).not.toContain(oldEvidence);
			expect(catalog).not.toContain(second.archiveId);
		}
	});

	it("restores the selected archive projection when navigating away and back", async () => {
		const harness = await createHarness({
			models: [{ id: "goal-model", contextWindow: 50_000 }],
			settings: { compaction: { enabled: false, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Initial investigation complete.")]);
		await harness.session.prompt(oldEvidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const priorLeaf = harness.sessionManager.getLeafId();
		if (!priorLeaf) throw new Error("Missing prior branch");
		const { archiveId } = await compactPriorHistory(harness, "Initial deployment investigation.", "archive");
		const archiveLeaf = harness.sessionManager.getLeafId();
		if (!archiveLeaf) throw new Error("Missing archive branch");
		await harness.session.navigateTree(priorLeaf);
		await harness.session.navigateTree(archiveLeaf);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("Continue after navigating.");
		expect(requests).toHaveLength(1);
		const projection = requests[0].messages.map(getMessageText).join("\n");
		expect(projection).toContain("Initial deployment investigation.");
		expect(projection).toContain(archiveId);
		expect(projection).not.toContain(oldEvidence);
	});

	it("discovers archives after emergency compaction removes their summaries", async () => {
		const harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 50_000 },
				{ id: "small", contextWindow: 12_000 },
			],
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(extension) =>
					extension.on("session_before_compact", (event) => ({
						compaction: {
							summary: "Emergency deployment summary.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					})),
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Initial investigation complete.")]);
		await harness.session.prompt(oldEvidence);
		await goalControls(harness).setGoalModeEnabled(true);
		const { archiveId } = await compactPriorHistory(harness, "Initial deployment investigation.", "archive");
		harness.setResponses([fauxAssistantMessage("Later investigation complete.")]);
		await harness.session.prompt(laterEvidence);
		const small = harness.getModel("small");
		if (!small) throw new Error("Missing small model");
		await harness.session.setModel(small);
		const requests: Context[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage(fauxToolCall("query_block", { query: "*" }, { id: "lookup" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("continued");
			},
		]);
		await harness.session.prompt("Continue after emergency compaction.");
		expect(harness.eventsOfType("compaction_end").some((event) => !event.aborted && event.result)).toBe(true);
		expect(requests).toHaveLength(2);
		expect(requests[0].systemPrompt).toContain("To discover archives");
		const projection = requests[1].messages.map(getMessageText).join("\n");
		expect(projection).toContain(archiveId);
		expect(projection).not.toContain(oldEvidence);
	});
});
