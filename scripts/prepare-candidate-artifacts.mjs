import { isolatedEnvironment } from "./artifact-acceptance.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { packReviewedPackage } from "./pack-reviewed-package.mjs";
if (!process.argv[2]) throw new Error("Usage: node scripts/prepare-candidate-artifacts.mjs ARTIFACT_DIRECTORY");
const out = resolve(process.argv[2]);
mkdirSync(join(out, "tarballs"), { recursive: true });
// Refuse an existing consumer so same-version local tarballs cannot be cached.
mkdirSync(join(out, "node"));
mkdirSync(join(out, "bun-install"));
const packages = getPublicWorkspacePackages();
const dependencies = {};
const manifest = [];
for (const pkg of packages) {
	const packed = packReviewedPackage(pkg, join(out, "tarballs"));
	const file = packed.file;
	dependencies[pkg.name] = `file:${file}`;
	manifest.push({
		name: pkg.name,
		version: pkg.version,
		filename: file.split("/").pop(),
		sha256: packed.sha256,
		payloadFiles: packed.payloadFiles,
	});
	console.log(`Packed ${pkg.name}`);
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const [consumer, command, args] of [
	["node", "npm", ["install", "--omit=dev", "--ignore-scripts"]],
	["bun-install", "bun", ["install", "--production", "--ignore-scripts"]],
]) {
	writeFileSync(
		join(out, consumer, "package.json"),
		JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }, null, 2) + "\n",
	);
	execFileSync(command, args, {
		cwd: join(out, consumer),
		env: isolatedEnvironment(join(out, consumer)),
		stdio: "inherit",
	});
	for (const pkg of packages) {
		const installed = resolve(out, consumer, "node_modules", pkg.name, "package.json");
		const info = JSON.parse(readFileSync(installed, "utf8"));
		if (info.name !== pkg.name || info.version !== pkg.version) throw new Error("Installed identity mismatch");
	}
	console.log(`All eleven local tarball identities verified in ${consumer} outside the workspace.`);
}
