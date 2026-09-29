export const CURRENT_PLAN_SNAPSHOT_PREFIX = "Current task context (latest plan):\n";

/** Remove only the structured plan snapshot appended to a summary. */
export function stripCurrentPlanSnapshot(summary: string): string {
	const index = summary.lastIndexOf(CURRENT_PLAN_SNAPSHOT_PREFIX);
	if (index < 0 || (index > 0 && summary.slice(index - 2, index) !== "\n\n")) return summary;
	try {
		const snapshot: unknown = JSON.parse(summary.slice(index + CURRENT_PLAN_SNAPSHOT_PREFIX.length));
		if (typeof snapshot !== "object" || snapshot === null || !("plan" in snapshot) || !Array.isArray(snapshot.plan)) {
			return summary;
		}
	} catch {
		return summary;
	}
	return summary.slice(0, index === 0 ? 0 : index - 2);
}
