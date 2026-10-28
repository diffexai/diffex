#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { acceptArtifacts, isolatedEnvironment } from "./artifact-acceptance.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { packReviewedPackage } from "./pack-reviewed-package.mjs";
import { assertChangelogsReady } from "./prepare-distribution.mjs";

const packages = getPublicWorkspacePackages();

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated directory outside the repository for local release testing.
Acceptance requires npm, pnpm@10.28.2, and Bun (unless --skip-bun-install).

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh before building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = {
		force: false,
		outDir: undefined,
		skipBunInstall: false,
		skipCheck: false,
		skipInstall: false,
		skipTest: false,
	};
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--skip-check") {
			options.skipCheck = true;
			continue;
		}
		if (arg === "--skip-test") {
			options.skipTest = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-bun-install") {
			options.skipBunInstall = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) {
				throw new Error("--out requires a directory");
			}
			options.outDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) {
		return mkdtempSync(join(tmpdir(), "diffex-local-release-"));
	}

	const outDir = resolve(options.outDir);

	if (isInsidePath(outDir, repoRoot)) {
		throw new Error(`Output directory must be outside the repository: ${outDir}`);
	}

	if (existsSync(outDir)) {
		if (!options.force) {
			throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		}
		rmSync(outDir, { force: true, recursive: true });
	}

	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function createDiffexShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "diffex.cmd"))) {
			writeFileSync(join(installDirectory, "diffex.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\diffex.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "diffex.ps1"), '& "$PSScriptRoot/node_modules/.bin/diffex.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "diffex.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\diffex.exe" %*\r\n');
		writeFileSync(join(installDirectory, "diffex.ps1"), '& "$PSScriptRoot/node_modules/.bin/diffex.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "diffex"), join(installDirectory, "diffex"));
}

const options = parseArgs();
assertChangelogsReady();
const repoRoot = process.cwd();
const rootPackageJson = readPackageJson(repoRoot);

if (rootPackageJson.name !== "diffex-monorepo") {
	throw new Error("Run this script from the repository root");
}

const outDir = prepareOutputDirectory(options, repoRoot);
const tarballDirectory = join(outDir, "tarballs");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");
mkdirSync(tarballDirectory, { recursive: true });

// Release artifacts always use a freshly generated, strictly validated catalog,
// including when checks or tests are explicitly skipped.
run("npm", ["run", "generate:models"], { cwd: repoRoot });

if (!options.skipCheck) {
	run("npm", ["run", "check"], { cwd: repoRoot });
}

run("npm", ["run", "build:offline"], { cwd: repoRoot });

if (!options.skipTest) {
	run("./test.sh", [], { cwd: repoRoot });
}

const tarballs = new Map();
const records = [];
for (const pkg of packages) {
	const packed = packReviewedPackage(pkg, tarballDirectory);
	const tarball = packed.file;
	records.push({ name: pkg.name, version: pkg.version, filename: tarball.split(/[\\/]/).pop(), sha256: packed.sha256 });
	tarballs.set(pkg.name, tarball);
}

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(records, null, 2)}\n`);

if (!options.skipInstall) {
	acceptArtifacts(outDir, join(outDir, "acceptance"), { managers: options.skipBunInstall ? ["npm", "pnpm"] : ["npm", "pnpm", "bun"] });
	// Standalone compilation is deliberately excluded by the approved policy.

	mkdirSync(nodeInstallDirectory, { recursive: true });
	const dependencies = Object.fromEntries(
		packages.map((pkg) => [pkg.name, fileSpecifier(nodeInstallDirectory, tarballs.get(pkg.name))]),
	);
	const installPackageJson = `${JSON.stringify({ private: true, dependencies, overrides: dependencies }, undefined, "\t")}\n`;
	writeFileSync(join(nodeInstallDirectory, "package.json"), installPackageJson);

	run("npm", ["install", "--omit=dev", "--ignore-scripts"], {
		cwd: nodeInstallDirectory,
		env: isolatedEnvironment(nodeInstallDirectory),
	});
	createDiffexShim(nodeInstallDirectory);

	if (!options.skipBunInstall) {
		if (!commandExists("bun")) {
			throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
		}
		mkdirSync(bunInstallDirectory, { recursive: true });
		const bunDependencies = Object.fromEntries(
			packages.map((pkg) => [pkg.name, fileSpecifier(bunInstallDirectory, tarballs.get(pkg.name))]),
		);
		writeFileSync(
			join(bunInstallDirectory, "package.json"),
			`${JSON.stringify({ private: true, dependencies: bunDependencies, overrides: bunDependencies }, undefined, "\t")}\n`,
		);
		run("bun", ["install", "--production", "--ignore-scripts"], {
			cwd: bunInstallDirectory,
			env: isolatedEnvironment(bunInstallDirectory),
		});
		createDiffexShim(bunInstallDirectory);
	}
}

console.log("\nLocal release artifacts created:");
console.log(`  ${outDir}`);
console.log("\nTarballs:");
for (const tarball of tarballs.values()) {
	console.log(`  ${tarball}`);
}

if (!options.skipInstall) {
	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "diffex.cmd" : "diffex")} --help`);

	if (!options.skipBunInstall) {
		console.log("\nIsolated Bun package install:");
		console.log(`  ${bunInstallDirectory}`);
		console.log("\nRun the locally packed Bun package CLI from outside the repository:");
		console.log(`  ${join(bunInstallDirectory, process.platform === "win32" ? "diffex.cmd" : "diffex")} --help`);
	}
}
