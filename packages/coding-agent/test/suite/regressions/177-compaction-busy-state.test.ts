import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@diffexai/diffex-ai";
import { HarnessStateStore, type HarnessVersion } from "@diffexai/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCollaborationModeBusy, setCollaborationMode } from "../../../src/core/collaboration-mode.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

describe("#177 manual compaction status and transition guards", () => {
	const harnesses: Harness[] = [];
	const agentDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		for (const agentDir of agentDirs.splice(0)) rmSync(agentDir, { recursive: true, force: true });
	});

	it.each(["success", "cancelled"] as const)(
		"keeps transition guards until %s compaction settles without blocking terminal prompt delivery",
		async (outcome) => {
			const agentDir = mkdtempSync(join(tmpdir(), "diffex-compaction-busy-"));
			agentDirs.push(agentDir);
			const store = new HarnessStateStore(agentDir);
			const root = await store.initialize();
			const targetVersion: HarnessVersion = `sha256:${"0".repeat(64)}`;
			const harness = await createHarness({
				harnessStateStore: store,
				harnessVersionBundle: root,
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							if (outcome === "cancelled") return { cancel: true };
							return {
								compaction: {
									summary: "Compacted evidence",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("seed response"), fauxAssistantMessage("queued response")]);
			await harness.session.prompt("Evidence to compact");

			let releaseAbort = (): void => {};
			const abortGate = new Promise<void>((resolve) => {
				releaseAbort = resolve;
			});
			const abortSpy = vi.spyOn(harness.session, "abort").mockImplementation(() => abortGate);
			const terminalStates: { compacting: boolean; modeBusy: boolean; transition: string }[] = [];
			let queuedPrompt: Promise<void> | undefined;
			harness.session.subscribe((event) => {
				if (event.type !== "compaction_end" || event.reason !== "manual") return;
				terminalStates.push({
					compacting: harness.session.isCompacting,
					modeBusy: isCollaborationModeBusy(harness.session),
					transition: setCollaborationMode(harness.session, "plan").status,
				});
				if (event.result) queuedPrompt = harness.session.prompt("Queued after compaction");
			});

			const compaction = harness.session.compact();
			try {
				expect(isCollaborationModeBusy(harness.session)).toBe(true);
				expect(harness.session.isCompacting).toBe(false);
				expect(setCollaborationMode(harness.session, "plan").status).toBe("busy");
				await expect(harness.session.switchHarnessVersion(targetVersion)).rejects.toThrow(
					"Cannot switch harness versions while compaction is in progress.",
				);
				expect(abortSpy).toHaveBeenCalledOnce();
			} finally {
				releaseAbort();
			}
			if (outcome === "success") await compaction;
			else await expect(compaction).rejects.toThrow("Compaction cancelled");
			expect(terminalStates).toEqual([{ compacting: false, modeBusy: true, transition: "busy" }]);
			if (outcome === "success") {
				expect(queuedPrompt).toBeDefined();
				await queuedPrompt;
				expect(getUserTexts(harness)).toContain("Queued after compaction");
				expect(harness.session.getLastAssistantText()).toBe("queued response");
			}
			expect(harness.session.isCompacting).toBe(false);
			expect(isCollaborationModeBusy(harness.session)).toBe(false);
			expect(setCollaborationMode(harness.session, "plan").status).toBe("changed");
		},
	);
});
