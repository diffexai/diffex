import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

export const BINARY_PLATFORMS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
	"windows-x64",
	"windows-arm64",
];
export const DEFERRED_BINARY_ASSETS = BINARY_PLATFORMS.map(
	(platform) => `diffex-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`,
);
export const BINARY_ASSETS = [];
export const INSTALL_LOCK_ASSETS = ["release/install-package.json", "release/install-package-lock.json"];
export const VERIFICATION_ASSETS = ["release/distribution-manifest.json", "distribution-files.json"];

export function createDistributionManifest({ packages, sourceCommit, policy, artifacts = [] }) {
	if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("Source commit must be a full Git object ID");
	const names = packages.map((pkg) => pkg.name);
	if (names.length !== 1 || names[0] !== "@diffexai/diffex")
		throw new Error("Reviewed distribution requires only the CLI package");
	const versions = new Set(packages.map((pkg) => pkg.version));
	if (versions.size !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packages[0].version))
		throw new Error("Public packages must use one stable version");
	return {
		schemaVersion: 1,
		version: packages[0].version,
		source: { repository: "diffexai/diffex", commit: sourceCommit, visibility: "private" },
		disclosurePolicy: policy,
		packages: packages
			.map(({ name, version }) => ({
				name,
				version,
				tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
		binaryPlatforms: [],
		deferredBinaryPlatforms: BINARY_PLATFORMS,
		npmPlatforms: BINARY_PLATFORMS.filter((platform) => !platform.startsWith("windows-")),
		deferredNpmPlatforms: ["windows-x64", "windows-arm64"],
		nodeVersion: ">=22.19.0",
		publicAssets: [...BINARY_ASSETS, ...INSTALL_LOCK_ASSETS, ...VERIFICATION_ASSETS],
		hostedRuntime: { image: "ghcr.io/diffexai/diffex-runtime", publication: "deferred", interactiveCliChannel: false },
		artifacts,
	};
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [policyFile, outputFile] = process.argv.slice(2);
	if (!policyFile || !outputFile)
		throw new Error("Usage: node scripts/release-distribution-manifest.mjs POLICY_JSON OUTPUT_JSON");
	const policyBytes = readFileSync(policyFile);
	const manifest = createDistributionManifest({
		packages: getPublicWorkspacePackages(),
		sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		policy: { ...JSON.parse(policyBytes), sha256: createHash("sha256").update(policyBytes).digest("hex") },
	});
	writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
