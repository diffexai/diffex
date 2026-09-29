export const CURRENT_PLAN_SNAPSHOT_PREFIX = "Current task context (latest plan):\n";

// Branch navigation attaches this authority paragraph with the snapshot.
const BRANCH_PLAN_AUTHORITY =
	"The plan below is authoritative for the selected conversation branch. Plan references in the exploration summary above are historical.\n";

/** Remove only the structured plan snapshot appended to a summary. */
export function stripCurrentPlanSnapshot(summary: string): string {
	const index = summary.lastIndexOf(CURRENT_PLAN_SNAPSHOT_PREFIX);
	const authorityStart = index - BRANCH_PLAN_AUTHORITY.length;
	const hasBranchAuthority = authorityStart >= 0 && summary.slice(authorityStart, index) === BRANCH_PLAN_AUTHORITY;
	const attachmentStart = hasBranchAuthority ? authorityStart : index;
	if (index < 0 || (attachmentStart > 0 && summary.slice(attachmentStart - 2, attachmentStart) !== "\n\n")) {
		return summary;
	}
	try {
		const snapshot: unknown = JSON.parse(summary.slice(index + CURRENT_PLAN_SNAPSHOT_PREFIX.length));
		if (typeof snapshot !== "object" || snapshot === null || !("plan" in snapshot) || !Array.isArray(snapshot.plan)) {
			return summary;
		}
	} catch {
		return summary;
	}
	return summary.slice(0, attachmentStart === 0 ? 0 : attachmentStart - 2);
}
