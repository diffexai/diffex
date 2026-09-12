#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { packReviewedPackage } from "./pack-reviewed-package.mjs";
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

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function isRegistered(name) {
	const result = spawnSync(commandForPlatform("npm"), ["view", name, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}\n${output}` : `Failed to query ${name}`);
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

// Validate every final tarball before registry queries or any publication.
const packDirectory = mkdtempSync(join(tmpdir(), "diffex-approved-npm-"));
process.on("exit", () => rmSync(packDirectory, { recursive: true, force: true }));
const packedPackages = new Map();
for (const pkg of packages) {
	assertBuildOutputExists(pkg.directory);
	packedPackages.set(pkg.name, packReviewedPackage(pkg, packDirectory));
}

mkdirSync(".artifacts", { recursive: true });
writeFileSync(
	".artifacts/npm-payload-inventory.json",
	`${JSON.stringify(
		[...packedPackages.values()].map(({ file, ...artifact }) => ({ ...artifact, filename: file.split("/").pop() })),
		null,
		2,
	)}\n`,
);

const packageStates = packages.map((pkg) => ({
	...pkg,
	published: isPublished(pkg.name, packageVersions.get(pkg.name)),
	registered: false,
	version: packageVersions.get(pkg.name),
}));

if (bootstrap) {
	for (const pkg of packageStates) {
		pkg.registered = pkg.published || isRegistered(pkg.name);
	}
	assertBootstrapPackageStates(packageStates);
}

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(`${pkg.name}@${pkg.version} is not published; validating package contents before publish.`);
	}
	console.log(`  Validated tarball SHA-256: ${packedPackages.get(pkg.name).sha256}`);
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

	run("npm", [...createPublishArgs({ bootstrap }), packedPackages.get(pkg.name).file]);
	console.log();
}

if (bootstrap) {
	console.log("Bootstrap publication is complete. Configure trusted publishing with:\n");
	for (const command of createTrustedPublisherCommands(packages.map((pkg) => pkg.name))) {
		console.log(`  ${command}`);
	}
	console.log("\nThen verify each relationship with npm trust list <package> before running the normal release flow.");
}
