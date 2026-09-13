#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { prepareReleaseArtifacts, readReleaseArtifacts } from "./release-artifacts.mjs";
import { readNpmPackageState, verifyNpmArtifact } from "./release-registry.mjs";
import { join } from "node:path";
import {
	assertBootstrapPackageStates,
	BOOTSTRAP_DIST_TAG,
	createPublishArgs,
	createTrustedPublisherCommands,
	parsePublishArgs,
} from "./npm-publish-plan.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const packages = getPublicWorkspacePackages();

let options;
try {
	options = parsePublishArgs(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
const { bootstrap, dryRun } = options;

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(
			output
				? `Command failed: ${command} ${args.join(" ")}\n${output}`
				: `Command failed: ${command} ${args.join(" ")}`,
		);
	}

	return result;
}

const packageVersions = new Map(packages.map((pkg) => [pkg.name, pkg.version]));

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

const mode = [bootstrap ? "bootstrap" : null, dryRun ? "dry run" : null].filter(Boolean).join(", ");
console.log(`Publishing Diffex packages at ${versions[0]}${mode ? ` (${mode})` : ""}\n`);

if (bootstrap) {
	console.log(
		`Bootstrap mode registers new packages under the non-default '${BOOTSTRAP_DIST_TAG}' tag without local provenance.`,
	);
	console.log(
		"It skips packages already published at this exact version and rejects established packages at other versions.\n",
	);
}

const artifactDirectory = options.artifacts ?? (bootstrap ? ".artifacts/npm-bootstrap" : undefined);
if (!artifactDirectory) throw new Error("Normal publication requires --artifacts DIRECTORY from the retained CI build");
if (bootstrap && !existsSync(artifactDirectory)) prepareReleaseArtifacts(artifactDirectory);
const manifest = readReleaseArtifacts(artifactDirectory, {
	version: versions[0],
	sourceCommit: process.env.DIFFEX_SOURCE_COMMIT,
});
// Verify every existing version before publishing any missing version.
// A registry success or matching version string alone never authorizes a skip.
const packageStates = [];
for (const pkg of manifest.packages) {
	packageStates.push({
		...pkg,
		published: Boolean(await verifyNpmArtifact(pkg, { allowMissing: true })),
		registered: false,
	});
}

if (bootstrap) {
	for (const pkg of packageStates) {
		const state = await readNpmPackageState(pkg.name);
		pkg.registered = state.registered;
		if (state.distTags.latest !== undefined || (pkg.published && state.distTags.bootstrap !== pkg.version))
			throw new Error(
				`${pkg.name}: bootstrap requires no latest tag and an exact bootstrap tag for existing artifacts`,
			);
	}
	assertBootstrapPackageStates(packageStates);
}

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; verified exact published tarball bytes.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	console.log(`  Validated tarball SHA-256: ${pkg.sha256}`);
	console.log();
}

if (dryRun) {
	if (bootstrap) {
		console.log("After bootstrap publication, configure trusted publishing with:\n");
		for (const command of createTrustedPublisherCommands(packages.map((pkg) => pkg.name))) {
			console.log(`  ${command}`);
		}
		console.log();
	}
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	run("npm", [...createPublishArgs({ bootstrap }), join(artifactDirectory, pkg.filename)]);
	console.log();
}

if (bootstrap) {
	for (const pkg of packageStates) {
		await verifyNpmArtifact(pkg);
		const state = await readNpmPackageState(pkg.name);
		if (state.distTags.latest !== undefined || state.distTags.bootstrap !== pkg.version)
			throw new Error(`${pkg.name}: bootstrap tag verification failed; do not announce this version`);
	}
	console.log("Bootstrap publication is complete. Configure trusted publishing with:\n");
	for (const command of createTrustedPublisherCommands(packages.map((pkg) => pkg.name))) {
		console.log(`  ${command}`);
	}
	console.log("\nThen verify each relationship with npm trust list <package> before running the normal release flow.");
}
