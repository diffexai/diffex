import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

import { isStableVersion } from "../packages/coding-agent/src/utils/release-contract.ts";
export { isStableVersion };
export const git = (...args) =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function assertCanonicalOrigin() {
	const allowed = new Set([
		"https://github.com/diffexai/diffex.git",
		"https://github.com/diffexai/diffex",
		"git@github.com:diffexai/diffex.git",
		"ssh://git@github.com/diffexai/diffex.git",
	]);
	for (const args of [
		["remote", "get-url", "--all", "origin"],
		["remote", "get-url", "--push", "--all", "origin"],
	]) {
		const urls = git(...args).split("\n");
		if (urls.length !== 1 || !allowed.has(urls[0]))
			throw new Error("Release requires the canonical diffexai/diffex origin for fetch and push");
	}
}

export function assertCleanMain() {
	if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Release requires a clean working tree");
	if (git("branch", "--show-current") !== "main") throw new Error("Release requires main");
}

export function assertPackageVersion(version) {
	if (!isStableVersion(version)) throw new Error("Release requires a canonical stable version");
	const packages = getPublicWorkspacePackages();
	if (!packages.length || packages.some((pkg) => pkg.version !== version))
		throw new Error("Package versions do not match the release version");
	return packages;
}

export function targetVersion(current, target) {
	if (!isStableVersion(current) || !["patch", "minor"].includes(target))
		throw new Error(
			"Use patch for fixes/additions or minor for breaking changes; major and explicit releases are unsupported",
		);
	const [major, minor, patch] = current.split(".").map(BigInt);
	return target === "patch" ? `${major}.${minor}.${patch + 1n}` : `${major}.${minor + 1n}.0`;
}

export function preflightRelease(target) {
	assertCanonicalOrigin();
	assertCleanMain();
	const current = getPublicWorkspacePackages()[0]?.version;
	assertPackageVersion(current);
	const version = targetVersion(current, target);
	git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
	if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main"))
		throw new Error("HEAD must equal refreshed origin/main");
	if (
		git("tag", "--list", `v${version}`) ||
		git("ls-remote", "--tags", "origin", `refs/tags/v${version}`, `refs/tags/v${version}^{}`)
	)
		throw new Error(`Release tag v${version} already exists locally or remotely`);
	return version;
}

export function resolveReleaseSource(tag, recoveryRef, expectedCommit) {
	assertCanonicalOrigin();
	if (!tag?.startsWith("v") || !isStableVersion(tag.slice(1))) throw new Error("Invalid stable release tag");
	// Fetch the exact tag once; downstream jobs use only the resulting object ID.
	git("fetch", "--no-tags", "origin", `refs/tags/${tag}`);
	const commit = git("rev-parse", "FETCH_HEAD^{commit}");
	if (expectedCommit && commit !== expectedCommit)
		throw new Error("Release tag differs from the original event commit");
	if (recoveryRef) {
		if (recoveryRef.startsWith("-") || /[\s\x00-\x1f]/.test(recoveryRef)) throw new Error("Invalid recovery source");
		git("fetch", "--no-tags", "origin", recoveryRef);
		if (git("rev-parse", "FETCH_HEAD^{commit}") !== commit)
			throw new Error("Divergent recovery source; the release tag is immutable");
	}
	git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
	git("merge-base", "--is-ancestor", commit, "origin/main");
	let publicPackages = 0;
	for (const path of git("ls-tree", "-r", "--name-only", commit, "packages")
		.split("\n")
		.filter((path) => path.endsWith("/package.json"))) {
		const pkg = JSON.parse(git("show", `${commit}:${path}`));
		if (pkg.private !== true) {
			publicPackages++;
			if (pkg.version !== tag.slice(1)) throw new Error(`Package/tag version mismatch: ${path}`);
		}
	}
	if (!publicPackages) throw new Error("No public release packages");
	return commit;
}

export function pushPreparedRelease(tag) {
	assertCanonicalOrigin();
	assertCleanMain();
	if (!tag?.startsWith("v") || !isStableVersion(tag.slice(1))) throw new Error("Invalid stable release tag");
	assertPackageVersion(tag.slice(1));
	const commit = git("rev-parse", `refs/tags/${tag}^{commit}`);
	if (
		git("rev-parse", "HEAD^") !== commit ||
		git("log", "-1", "--format=%s") !== "docs(coding-agent): start next release cycle"
	)
		throw new Error("Prepared main must contain exactly the next-cycle commit after the release tag");
	const changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
	if (changed.some((path) => !/^packages\/.+\/CHANGELOG\.md$/.test(path)))
		throw new Error("Unexpected next-cycle changes");
	git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
	git("merge-base", "--is-ancestor", "origin/main", "main");
	const remoteTag = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
	if (
		remoteTag &&
		!remoteTag
			.split("\n")
			.some((line) => line === `${commit}\trefs/tags/${tag}^{}` || line === `${commit}\trefs/tags/${tag}`)
	)
		throw new Error("Remote release tag conflicts; never rewrite it");
	try {
		git("push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `refs/tags/${tag}:refs/tags/${tag}`);
	} catch {
		throw new Error(
			`Atomic push did not confirm completion. Keep both local commits and ${tag}; inspect remote refs and rerun node scripts/release.mjs --push-prepared ${tag}. See docs/release/promotion.md for unsupported-server recovery. Never recreate the release or force-push.`,
		);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const commit = resolveReleaseSource(
		process.env.RELEASE_TAG,
		process.env.SOURCE_REF,
		process.env.EXPECTED_COMMIT || undefined,
	);
	if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
	appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
	console.log(`Verified release source ${commit}`);
}
