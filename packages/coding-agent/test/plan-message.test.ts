import { visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	buildContextEntries,
	buildSessionContext,
	type PlanEntry,
	type SessionEntry,
} from "../src/core/session-manager.ts";
import { PlanMessageComponent } from "../src/modes/interactive/components/plan-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	handleEvent,
	PLAN,
	type PlanSubmittedEventContext,
	type RenderPlanEntryContext,
	type RenderSessionEntriesContext,
	renderSessionEntries,
	renderSessionItems,
} from "./interactive-mode-plan-test-utils.ts";

beforeAll(() => initTheme("dark"));

describe("PlanMessageComponent", () => {
	test("renders a submitted plan from the live transcript event", async () => {
		const context: PlanSubmittedEventContext = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			renderPlanArtifact: vi.fn(),
		};

		await handleEvent.call(context, { type: "plan_submitted", plan: PLAN });

		expect(context.renderPlanArtifact).toHaveBeenCalledWith(PLAN);
	});

	test("restores persisted plan artifacts into the transcript", () => {
		const context: RenderPlanEntryContext = {
			pendingTools: new Map(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager: { getEntries: () => [] },
			session: { modelRuntime: {} },
			renderPlanArtifact: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const entry: PlanEntry = {
			type: "plan",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-08-14T00:00:00.000Z",
			plan: PLAN,
		};

		renderSessionItems.call(context, [entry]);

		expect(context.renderPlanArtifact).toHaveBeenCalledWith(PLAN);
		expect(context.ui.requestRender).toHaveBeenCalledOnce();
	});

	test("restores a pending plan omitted from compaction-aware transcript entries without duplicating present plans", () => {
		const context: RenderSessionEntriesContext = {
			session: { pendingPlan: PLAN },
			renderSessionItems: vi.fn(),
			renderPlanArtifact: vi.fn(),
		};
		const entry: PlanEntry = {
			type: "plan",
			id: "plan-entry-1",
			parentId: "user-1",
			timestamp: "2026-08-14T00:00:00.000Z",
			plan: PLAN,
		};
		const entries: SessionEntry[] = [
			{
				type: "collaboration_mode_change",
				id: "plan-mode-1",
				parentId: null,
				timestamp: "2026-08-14T00:00:00.000Z",
				mode: "plan",
			},
			{
				type: "message",
				id: "user-1",
				parentId: "plan-mode-1",
				timestamp: "2026-08-14T00:00:00.000Z",
				message: { role: "user", content: "Create a plan.", timestamp: Date.now() },
			},
			entry,
			{
				type: "message",
				id: "user-2",
				parentId: entry.id,
				timestamp: "2026-08-14T00:01:00.000Z",
				message: { role: "user", content: "Keep this recent context.", timestamp: Date.now() },
			},
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "user-2",
				timestamp: "2026-08-14T00:02:00.000Z",
				summary: "Earlier context, including the pending plan, was compacted.",
				firstKeptEntryId: "user-2",
				tokensBefore: 20_000,
			},
		];
		const contextEntries = buildContextEntries(entries, "compaction-1");
		expect(contextEntries.some((candidate) => candidate.type === "plan")).toBe(false);
		expect(buildSessionContext(entries, "compaction-1").pendingPlan).toEqual(PLAN);

		renderSessionEntries.call(context, contextEntries);
		expect(context.renderPlanArtifact).toHaveBeenCalledWith(PLAN);

		context.renderPlanArtifact.mockClear();
		renderSessionEntries.call(context, [entry, ...contextEntries]);
		expect(context.renderPlanArtifact).not.toHaveBeenCalled();
	});

	test.each([80, 60])("renders normalized plan content within %i columns", (width) => {
		const component = new PlanMessageComponent({ ...PLAN, title: "Add\n\u001b[2J native plan mode" });
		const lines = component.render(width);

		expect(stripAnsi(lines.join("\n"))).toContain("Plan: Add native plan mode");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
