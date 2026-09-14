import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function releaseOutputPaths(changelogs) {
	const directories = findPackageDirectories();
	const trackedLocks = execFileSync(
		"git",
		["ls-files", "-z", "--", ...directories.map((directory) => join(directory, "package-lock.json"))],
		{ encoding: "utf8" },
	)
		.split("\0")
		.filter(Boolean);
	return new Set([
		"package.json",
		"package-lock.json",
		"packages/coding-agent/npm-shrinkwrap.json",
		"packages/coding-agent/install-lock/package.json",
		"packages/coding-agent/install-lock/package-lock.json",
		...directories.map((directory) => join(directory, "package.json")),
		...trackedLocks,
		...changelogs,
	]);
}

export function stageReleaseOutputs(allowed) {
	const paths = execFileSync("git", ["ls-files", "-m", "-o", "-d", "--exclude-standard", "-z"], { encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
	const unexpected = paths.filter((path) => !allowed.has(path));
	if (unexpected.length)
		throw new Error(`Unexpected generated changes; review before release: ${unexpected.join(", ")}`);
	if (paths.length) execFileSync("git", ["add", "--", ...new Set(paths)], { stdio: "inherit" });
}
