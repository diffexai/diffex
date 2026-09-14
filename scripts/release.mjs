#!/usr/bin/env node
// Prepare a patch or minor release from synchronized main, review generated
// changes, and atomically publish the release and next-cycle commits.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { createInterface } from "node:readline/promises";
import { preflightRelease, pushPreparedRelease, assertPackageVersion } from "./release-source.mjs";
import { releaseOutputPaths, stageReleaseOutputs } from "./release-outputs.mjs";

if (process.argv[2] === "--push-prepared") {
	if (process.argv.length !== 4) throw new Error("Usage: node scripts/release.mjs --push-prepared vX.Y.Z");
	pushPreparedRelease(process.argv[3]);
	process.exit(0);
}

const RELEASE_TARGET = process.argv[2];
if (process.argv.length !== 3 || !["patch", "minor"].includes(RELEASE_TARGET)) {
	throw new Error("Usage: node scripts/release.mjs <patch|minor>; major and explicit versions are unsupported");
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		const result = spawnSync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["view", packageName, "version", "--json"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		throw new Error(
			output
				? `Failed to query npm registration for ${packageName}\n${output}`
				: `Failed to query npm registration for ${packageName}`,
		);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(
			`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nFollow the first-publication process in RELEASING.md before running a release.`,
		);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]));
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

function bumpVersion(target) {
	run(`npm run version:${target}`);
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

console.log("Validating release source before mutation...");
const expectedVersion = preflightRelease(RELEASE_TARGET);
assertPackagesAreRegisteredWithNpm();
// Capture tracked workspace lockfiles before npm version updates them.
const intendedOutputs = releaseOutputPaths(getChangelogs());

// Bump the approved release version
const version = bumpVersion(RELEASE_TARGET);
if (version !== expectedVersion) throw new Error("Version generator did not produce the preflighted release version");
assertPackageVersion(version);
console.log(`  New version: ${version}\n`);

// Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// Regenerate release artifacts
console.log("Regenerating release artifacts...");
// Catalog updates must be reviewed and merged before release preparation.
run("npm run hydrate:model-data");
run("npm run check:model-data");
run("npm run shrinkwrap:coding-agent");
run("npm run install-lock:coding-agent");
console.log();

// Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

console.log("Running tests...");
run("./test.sh");
console.log();

// Commit and tag
console.log("Committing and tagging...");
run("git diff --check");
run("git diff --stat");
run(
	"git diff -- package.json package-lock.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/install-lock",
);
if (!process.stdin.isTTY)
	throw new Error("Review generated diffs in an interactive terminal before committing and pushing");
const review = createInterface({ input: process.stdin, output: process.stdout });
try {
	if (
		(
			await review.question(
				`Review all generated diffs with git diff in another terminal, then type ${version} to commit and push: `,
			)
		).trim() !== version
	)
		throw new Error("Release review was not confirmed; changes remain local");
} finally {
	review.close();
}
// Refresh again after the build/review interval, before creating release refs.
execFileSync("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
	stdio: "inherit",
});
if (
	execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }) !==
	execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" })
)
	throw new Error("origin/main changed during preparation; review the new main before releasing");
stageReleaseOutputs(intendedOutputs);
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// Commit
console.log("Committing changelog updates...");
stageReleaseOutputs(new Set(getChangelogs()));
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// Push
console.log("Pushing to remote...");
pushPreparedRelease(`v${version}`);
console.log();

console.log(
	`=== Prepared release v${version}; CI publication and Diffex release announcement start after the tag push ===`,
);
