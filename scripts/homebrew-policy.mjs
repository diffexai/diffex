export const HOMEBREW_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

/** The implementation does not itself approve redistribution or native qualification. */
export function assertHomebrewPublicationPolicy(policy) {
	const approval = policy.homebrewApproval;
	if (policy.status !== "approved" || policy.channels?.homebrew !== "enable" ||
		policy.channels?.standalone !== "defer" || approval?.status !== "approved" ||
		approval.publicRepository !== "diffexai/diffex" || approval.tapRepository !== "diffexai/homebrew-tap" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(approval.reviewedAt ?? "") ||
		!Array.isArray(approval.nativeAcceptance) ||
		!HOMEBREW_TARGETS.every((platform) => approval.nativeAcceptance.includes(platform)) ||
		approval.redistribution !== "approved" || approval.quarantine !== "accepted" ||
		approval.daytona !== "accepted") {
		throw new Error("Homebrew publication requires approved redistribution, four native targets, quarantine and Daytona evidence, and authorized public/tap repositories");
	}
}
