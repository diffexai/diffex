import { describe, expect, it } from "vitest";
import { calculateGoalBudget } from "../../src/core/pocket-context.ts";

const contextWindow = 1_000_000;
const consider = "Consider compacting completed work.";
const soon = "Compact older work soon to preserve room.";
const now = "Compact older context now.";

describe("goal budget threshold contract", () => {
	it.each([
		[399_999, false, undefined, false],
		[400_000, true, undefined, false],
		[400_001, true, undefined, false],
		[599_999, true, undefined, false],
		[600_000, true, consider, false],
		[600_001, true, consider, false],
		[749_999, true, consider, false],
		[750_000, true, soon, false],
		[750_001, true, soon, false],
		[849_999, true, soon, false],
		[850_000, true, now, false],
		[850_001, true, now, false],
		[949_999, true, now, false],
		[950_000, true, now, false],
		[950_001, true, now, false],
		[987_711, true, now, false],
		[987_712, true, undefined, true],
		[1_000_000, true, undefined, true],
	] as const)(
		"calculates behavior at %i input tokens",
		(estimatedInputTokens, canCompact, nudge, requiresEmergencyCompaction) => {
			const result = calculateGoalBudget({ estimatedInputTokens, contextWindow });
			expect(result.usage).toBeCloseTo(estimatedInputTokens / contextWindow, 10);
			expect(result.canCompact).toBe(canCompact);
			if (!requiresEmergencyCompaction) expect(result.nudge).toBe(nudge);
			expect(result.requiresEmergencyCompaction).toBe(requiresEmergencyCompaction);
		},
	);

	it("reserves response headroom and provider safety independently of ordinary compaction settings", () => {
		const early = calculateGoalBudget({
			estimatedInputTokens: 40_000,
			contextWindow: 120_000,
		});
		const nearCapacity = calculateGoalBudget({
			estimatedInputTokens: 100_000,
			contextWindow: 120_000,
		});
		expect(early.usage).toBeCloseTo(40_000 / 120_000, 10);
		expect(early.canCompact).toBe(false);
		expect(nearCapacity.usage).toBeCloseTo(100_000 / 120_000, 10);
		expect(nearCapacity.requiresEmergencyCompaction).toBe(false);
	});

	it.each([19_903, 19_904, 19_905])(
		"protects 8k response headroom at %i input tokens in a 32k window",
		(estimatedInputTokens) => {
			const budget = calculateGoalBudget({ estimatedInputTokens, contextWindow: 32_000, maxTokens: 8_000 });
			expect(budget.usage).toBeCloseTo(estimatedInputTokens / 32_000, 10);
			expect(budget.requiresEmergencyCompaction).toBe(estimatedInputTokens >= 19_904);
		},
	);

	it.each([1_024, 8_192, 262_144])("keeps pressure independent of the model output limit %i", (maxTokens) => {
		const budget = calculateGoalBudget({ estimatedInputTokens: 20_000, contextWindow, maxTokens });
		expect(budget.usage).toBe(0.02);
		expect(budget.canCompact).toBe(false);
		expect(budget.nudge).toBeUndefined();
		expect(budget.requiresEmergencyCompaction).toBe(false);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 4_096])("fails closed for an unusable window %s", (window) => {
		expect(
			calculateGoalBudget({ estimatedInputTokens: 100, contextWindow: window }).requiresEmergencyCompaction,
		).toBe(true);
	});
});
