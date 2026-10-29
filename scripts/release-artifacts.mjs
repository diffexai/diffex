import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { packReviewedPackage } from "./pack-reviewed-package.mjs";
import { integrity, sha256 } from "./release-registry.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { assertPackageVersion, git, isStableVersion } from "./release-source.mjs";
import { assertHomebrewPublicationPolicy } from "./homebrew-policy.mjs";
import { readRetainedFile, resolveReleaseDirectory, writeRetainedFile } from "./homebrew-release-paths.mjs";

export function assertEnabledChannels(policy) {
	if (
		policy.status !== "approved" ||
		policy.sourceRepository !== "diffexai/diffex" ||
		policy.publicRegistry !== "https://registry.npmjs.org" ||
		policy.publicHosting !== "npmjs" ||
		policy.channels?.npmjs !== "enable" ||
		Object.entries(policy.channels).some(([name, value]) => !["npmjs", "homebrew"].includes(name) && value !== "defer") ||
		!["defer", "enable"].includes(policy.channels?.homebrew)
	)
		throw new Error(
			"Unapproved distribution channels: public asset verification must be implemented before enabling another channel",
		);
	if (policy.channels.homebrew === "enable") assertHomebrewPublicationPolicy(policy);
}

function sourceIdentity() {
	const policyBytes = readFileSync("docs/release/distribution-policy.json");
	assertEnabledChannels(JSON.parse(policyBytes));
	return {
		repository: "diffexai/diffex",
		commit: git("rev-parse", "HEAD"),
		tree: git("rev-parse", "HEAD^{tree}"),
		lockSha256: sha256(readFileSync("package-lock.json")),
		policySha256: sha256(policyBytes),
	};
}

export function readReleaseArtifacts(directory, { version, sourceCommit } = {}) {
	directory = resolveReleaseDirectory(directory);
	const manifest = JSON.parse(readRetainedFile(directory, "manifest.json", 1024 * 1024, "utf8"));
	const identity = sourceIdentity();
	if (
		!/^[a-f0-9]{40}$/.test(identity.commit) ||
		!isStableVersion(manifest.version) ||
		manifest.schemaVersion !== 1 ||
		!isDeepStrictEqual(manifest.source, identity) ||
		(sourceCommit && identity.commit !== sourceCommit) ||
		(version && manifest.version !== version)
	)
		throw new Error("Artifact source/version conflicts with the checked release commit and inputs");
	const packages = assertPackageVersion(manifest.version);
	if (
		!Array.isArray(manifest.packages) ||
		manifest.packages.length !== packages.length ||
		new Set(manifest.packages.map((pkg) => pkg.name)).size !== packages.length
	)
		throw new Error("Artifact inventory must contain every public package exactly once");
	const approvedArtifacts = packages.map((pkg) => {
		const filename = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
		const artifact = manifest.packages.find((artifact) => artifact.name === pkg.name);
		if (
			!artifact ||
			artifact.version !== pkg.version ||
			artifact.filename !== filename ||
			!/^[a-f0-9]{64}$/.test(artifact.sha256) ||
			!/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.integrity) ||
			!Number.isSafeInteger(artifact.size) ||
			artifact.size <= 0
		)
			throw new Error(`Invalid approved artifact: ${pkg.name}`);
		const bytes = readRetainedFile(directory, filename, 512 * 1024 * 1024);
		const checksum = sha256(bytes);
		const sri = integrity(bytes);
		if (bytes.length !== artifact.size || checksum !== artifact.sha256 || sri !== artifact.integrity)
			throw new Error(`Retained tarball identity mismatch: ${pkg.name}`);
		// Network identities come from the checked workspace, never raw retained
		// JSON. Only measured, verified byte identities accompany them downstream.
		return { name: pkg.name, version: pkg.version, filename, size: bytes.length, sha256: checksum, integrity: sri };
	});
	if (
		manifest.snapshot?.filename !== "source.tar.gz" ||
		!/^[a-f0-9]{64}$/.test(manifest.snapshot.sha256) ||
		!Array.isArray(manifest.modelData) ||
		!manifest.modelData.length
	)
		throw new Error("Missing frozen source/model snapshot");
	if (sha256(readRetainedFile(directory, "source.tar.gz", 512 * 1024 * 1024)) !== manifest.snapshot.sha256)
		throw new Error("Frozen source snapshot integrity mismatch");
	const inputs = JSON.parse(readRetainedFile(directory, "inputs.json", 1024 * 1024, "utf8"));
	const { schemaVersion, packages: artifacts, ...recordedInputs } = manifest;
	if (!isDeepStrictEqual(inputs, recordedInputs))
		throw new Error("Approved manifest differs from the frozen build inputs");
	return {
		schemaVersion: 1,
		version: packages[0].version,
		source: identity,
		modelData: manifest.modelData,
		snapshot: manifest.snapshot,
		toolchain: manifest.toolchain,
		packages: approvedArtifacts,
	};
}

function modelSnapshot() {
	const modelRoot = "packages/ai/src/providers/data";
	return readdirSync(modelRoot)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.map((file) => ({ path: `${modelRoot}/${file}`, sha256: sha256(readFileSync(join(modelRoot, file))) }));
}

export function freezeReleaseInputs(directory) {
	directory = resolveReleaseDirectory(directory);
	if (existsSync(directory))
		throw new Error("Artifact directory already exists; verify and reuse it instead of rebuilding");
	if (git("status", "--porcelain", "--untracked-files=all"))
		throw new Error("Artifact preparation requires clean tracked source and no untracked files");
	const source = sourceIdentity();
	const version = getPublicWorkspacePackages()[0]?.version;
	assertPackageVersion(version);
	if (process.env.DIFFEX_SOURCE_COMMIT && process.env.DIFFEX_SOURCE_COMMIT !== source.commit)
		throw new Error("Build source differs from resolved release commit");
	mkdirSync(directory, { recursive: true });
	const modelData = modelSnapshot();
	execFileSync(
		"bash",
		[
			"scripts/create-source-archive.sh",
			"--version",
			version,
			"--ref",
			source.commit,
			"--out",
			resolve(directory, "source.tar.gz"),
		],
		{ stdio: "inherit" },
	);
	const inputs = {
		version,
		source,
		modelData,
		snapshot: { filename: "source.tar.gz", sha256: sha256(readRetainedFile(directory, "source.tar.gz", 512 * 1024 * 1024)) },
		toolchain: {
			node: process.version,
			npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
			platform: process.platform,
			arch: process.arch,
		},
	};
	writeRetainedFile(directory, "inputs.json", `${JSON.stringify(inputs, null, 2)}\n`);
	return inputs;
}

export function prepareReleaseArtifacts(directory) {
	directory = resolveReleaseDirectory(directory);
	if (!existsSync(directory)) freezeReleaseInputs(directory);
	if (existsSync(join(directory, "manifest.json")))
		throw new Error("Approved artifacts already exist; never repack a published version");
	const inputs = JSON.parse(readRetainedFile(directory, "inputs.json", 1024 * 1024, "utf8"));
	if (
		!isDeepStrictEqual(inputs.source, sourceIdentity()) ||
		!isDeepStrictEqual(inputs.modelData, modelSnapshot()) ||
		sha256(readRetainedFile(directory, "source.tar.gz", 512 * 1024 * 1024)) !== inputs.snapshot.sha256
	)
		throw new Error("Frozen release inputs changed during the build");
	const packages = assertPackageVersion(inputs.version);
	const artifacts = packages.map((pkg) => {
		const packed = packReviewedPackage(pkg, directory);
		const bytes = readRetainedFile(directory, basename(packed.file), 512 * 1024 * 1024);
		return {
			name: pkg.name,
			version: inputs.version,
			filename: basename(packed.file),
			size: bytes.length,
			sha256: packed.sha256,
			integrity: integrity(bytes),
		};
	});
	if (git("diff", "--name-only", "HEAD") || !isDeepStrictEqual(inputs.modelData, modelSnapshot()))
		throw new Error("Build or packing changed release inputs");
	const manifest = { schemaVersion: 1, ...inputs, packages: artifacts };
	writeRetainedFile(directory, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
	return readReleaseArtifacts(directory);
}

const artifactActions = Object.freeze({
	freeze: freezeReleaseInputs,
	prepare: prepareReleaseArtifacts,
	verify: (directory) => readReleaseArtifacts(directory, {
		sourceCommit: process.env.DIFFEX_SOURCE_COMMIT,
		version: process.env.RELEASE_TAG?.slice(1),
	}),
});

if (import.meta.main) {
	const [command, directory] = process.argv.slice(2);
	if (!directory || !Object.hasOwn(artifactActions, command))
		throw new Error("Usage: node scripts/release-artifacts.mjs <freeze|prepare|verify> DIRECTORY");
	const manifest = artifactActions[command](resolveReleaseDirectory(directory));
	console.log(`Verified ${manifest.packages?.length ?? 0} retained artifacts for ${manifest.source.commit}`);
}
