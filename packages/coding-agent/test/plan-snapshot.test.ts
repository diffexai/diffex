import { describe, expect, it } from "vitest";
import { CURRENT_PLAN_SNAPSHOT_PREFIX, stripCurrentPlanSnapshot } from "../src/core/plan-snapshot.ts";

describe("stripCurrentPlanSnapshot", () => {
	it.each([
		{ plan: [] },
		{ plan: [{ id: "active", step: "Active", status: "in_progress", success_criteria: ["Retain criteria"] }] },
		{ plan: [{ id: "finished", step: "Finished", status: "completed" }] },
	])("removes the attached snapshot while preserving narrative and file metadata", ({ plan }) => {
		const narrative = "## Goal\nContinue work\n\n<modified-files>\nsrc/example.ts\n</modified-files>";
		const snapshot = `${CURRENT_PLAN_SNAPSHOT_PREFIX}${JSON.stringify({ plan }, null, 2)}`;

		expect(stripCurrentPlanSnapshot(`${narrative}\n\n${snapshot}`)).toBe(narrative);
		expect(stripCurrentPlanSnapshot(snapshot)).toBe("");
	});

	it.each([
		"Narrative without a plan",
		`Mention of ${CURRENT_PLAN_SNAPSHOT_PREFIX}{"plan": []}`,
		`Narrative\n\n${CURRENT_PLAN_SNAPSHOT_PREFIX}not JSON`,
		`Narrative\n\n${CURRENT_PLAN_SNAPSHOT_PREFIX}{"other": []}`,
		`Narrative\n\n${CURRENT_PLAN_SNAPSHOT_PREFIX}{"plan": []}\nMore narrative`,
	])("preserves text that is not an appended plan snapshot", (summary) => {
		expect(stripCurrentPlanSnapshot(summary)).toBe(summary);
	});
});
