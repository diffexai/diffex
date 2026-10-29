import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCanonicalOrigin, git, isStableVersion } from "./release-source.mjs";

/** Revalidate local, fully fetched refs before replacing trusted workflow control code. */
export function checkoutApprovedRelease(tag, expectedCommit) {
	assertCanonicalOrigin();
	if (!tag?.startsWith("v") || !isStableVersion(tag.slice(1)) || !/^[a-f0-9]{40}$/.test(expectedCommit ?? ""))
		throw new Error("Approved release checkout requires a stable tag and full commit identity");
	if (git("status", "--porcelain", "--untracked-files=all"))
		throw new Error("Approved release checkout requires a clean control checkout");
	const tagged = git("rev-parse", `refs/tags/${tag}^{commit}`);
	if (tagged !== expectedCommit) throw new Error("Release tag differs from the previously approved source");
	git("merge-base", "--is-ancestor", tagged, "refs/remotes/origin/main");
	let packages = 0;
	for (const path of git("ls-tree", "-r", "--name-only", tagged, "packages").split("\n")) {
		if (!path.endsWith("/package.json")) continue;
		const manifest = JSON.parse(git("show", `${tagged}:${path}`));
		if (manifest.private === true) continue;
		packages++;
		if (manifest.version !== tag.slice(1)) throw new Error("Approved release package/tag version mismatch");
	}
	if (!packages) throw new Error("Approved release has no public packages");
	// Only the exact tagged commit, independently proven to belong to canonical
	// main, can execute in this job. No arbitrary dispatch ref is checked out.
	git("checkout", "--detach", tagged);
	return tagged;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(`Checked out approved release ${checkoutApprovedRelease(process.env.RELEASE_TAG, process.env.DIFFEX_SOURCE_COMMIT)}`);
}
