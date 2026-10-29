#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isReleaseRecord, isStableVersion } from "../packages/coding-agent/src/utils/release-contract.ts";
import { readReleaseArtifacts } from "./release-artifacts.mjs";
import { verifyNpmArtifact } from "./release-registry.mjs";
import { verifyPublicHomebrewRelease } from "./homebrew-release.mjs";

const RELEASES_PREFIX = "releases/v1";
const RETRY_DELAY_MS = 5000;
const RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_POINTER_UPDATE_ATTEMPTS = 5;
const STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseArgs(args) {
	const options = {
		artifacts: undefined,
		homebrewArtifacts: undefined,
		bucket: undefined,
		endpoint: undefined,
		sourceCommit: undefined,
		version: undefined,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (
			arg !== "--artifacts" &&
			arg !== "--homebrew-artifacts" &&
			arg !== "--bucket" &&
			arg !== "--endpoint" &&
			arg !== "--source-commit" &&
			arg !== "--version"
		) {
			throw new Error(`Unknown argument: ${arg}`);
		}
		const value = args[++index];
		if (!value) throw new Error(`${arg} requires a value`);
		options[
			{
				"--artifacts": "artifacts",
				"--homebrew-artifacts": "homebrewArtifacts",
				"--bucket": "bucket",
				"--endpoint": "endpoint",
				"--source-commit": "sourceCommit",
				"--version": "version",
			}[arg]
		] = value;
	}

	if (!options.artifacts) throw new Error("--artifacts is required");
	if (!options.bucket) throw new Error("--bucket is required");
	if (!options.endpoint) throw new Error("--endpoint is required");
	if (!isStableVersion(options.version)) {
		throw new Error("--version must be a stable semver version");
	}
	return options;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyPackagesAreAvailable(packages) {
	const deadline = Date.now() + RETRY_TIMEOUT_MS;
	let attempt = 0;
	let failures = [];

	do {
		attempt++;
		const results = await Promise.allSettled(packages.map((pkg) => verifyNpmArtifact(pkg)));
		failures = results.flatMap((result, index) =>
			result.status === "rejected" ? [`${packages[index].name}: ${result.reason}`] : [],
		);
		if (failures.length === 0) {
			console.log(`All ${packages.length} Diffex packages are available from npm (attempt ${attempt}).`);
			return results.map((result) => result.value);
		}

		console.log(
			`Waiting for ${failures.length} Diffex package${failures.length === 1 ? "" : "s"} on npm (attempt ${attempt}):`,
		);
		for (const failure of failures) console.log(`  ${failure}`);
		if (Date.now() < deadline) await sleep(RETRY_DELAY_MS);
	} while (Date.now() < deadline);

	throw new Error(
		`Timed out waiting for Diffex packages to become available from npm:\n${failures.map((failure) => `  ${failure}`).join("\n")}`,
	);
}

function gitSourceCommit() {
	return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function runAws(args, { allowNotFound = false, allowPreconditionFailure = false } = {}) {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
			AWS_PAGER: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
	});
	if (result.error) throw new Error("AWS CLI could not run or timed out; verify installation and connectivity.");
	if (result.status === 0) return result.stdout;

	// Never echo provider output: it can contain credentials, signed URLs, or headers.
	const code = /An error occurred \(([^)]+)\)/.exec(result.stderr)?.[1];
	if (allowNotFound && ["404", "NoSuchKey", "NotFound"].includes(code)) return undefined;
	if (allowPreconditionFailure && ["412", "PreconditionFailed", "ConditionalRequestConflict"].includes(code))
		return undefined;
	if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken"].includes(code)) {
		throw new Error("R2 rejected publication credentials; verify account, bucket scope, and credential validity.");
	}
	throw new Error(
		`AWS CLI ${args.slice(0, 2).join(" ")} failed; check storage availability and AWS CLI conditional-write support.`,
	);
}

function readRelease(bucket, endpoint, key, outputPath) {
	// Get the ETag and body from one response so conditional writes use one snapshot.
	const result = runAws(
		["s3api", "get-object", "--bucket", bucket, "--key", key, "--endpoint-url", endpoint, outputPath],
		{ allowNotFound: true },
	);
	if (result === undefined) return undefined;
	const metadata = JSON.parse(result);
	if (typeof metadata.ETag !== "string") throw new Error("Diffex release record has no ETag.");
	const body = readFileSync(outputPath, "utf8");
	const release = parseStoredRelease(body);
	return { etag: metadata.ETag, version: release.version, release, body };
}

export function parseStoredRelease(body) {
	let release;
	try {
		release = JSON.parse(body);
	} catch {
		throw new Error("Diffex release record is not valid JSON.");
	}
	if (!isReleaseRecord(release)) {
		throw new Error("Invalid release record in storage.");
	}
	return release;
}

function putJson(bucket, endpoint, path, key, cacheControl, condition) {
	const args = [
		"s3api",
		"put-object",
		"--bucket",
		bucket,
		"--key",
		key,
		"--body",
		path,
		"--endpoint-url",
		endpoint,
		"--content-type",
		"application/json; charset=utf-8",
		"--cache-control",
		cacheControl,
	];
	if (condition?.etag) args.push("--if-match", condition.etag);
	if (condition?.missing) args.push("--if-none-match", "*");
	return runAws(args, { allowPreconditionFailure: Boolean(condition) }) !== undefined;
}

export function compareReleaseVersions(left, right) {
	const leftMatch = STABLE_SEMVER_RE.exec(left);
	const rightMatch = STABLE_SEMVER_RE.exec(right);
	if (!isStableVersion(left) || !isStableVersion(right) || !leftMatch || !rightMatch) {
		throw new Error("Release versions must be stable semver versions.");
	}

	for (const index of [1, 2, 3]) {
		const leftPart = BigInt(leftMatch[index]);
		const rightPart = BigInt(rightMatch[index]);
		if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
	}
	return 0;
}

export async function advanceLatestRelease(version, readLatest, writeLatest) {
	for (let attempt = 0; attempt < MAX_POINTER_UPDATE_ATTEMPTS; attempt++) {
		const current = await readLatest();
		if (current && compareReleaseVersions(version, current.version) <= 0) {
			return { advanced: false, version: current.version };
		}

		const updated = await writeLatest(current ? { etag: current.etag } : { missing: true });
		if (updated) {
			return { advanced: true, version };
		}
	}
	throw new Error(
		`Could not advance the Diffex release marker to ${version} after ${MAX_POINTER_UPDATE_ATTEMPTS} attempts.`,
	);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!process.env.AWS_ACCESS_KEY_ID?.trim() || !process.env.AWS_SECRET_ACCESS_KEY?.trim()) {
		throw new Error(
			"Release publication requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the protected release environment.",
		);
	}
	const sourceCommit = options.sourceCommit ?? gitSourceCommit();
	const manifest = readReleaseArtifacts(options.artifacts, { version: options.version, sourceCommit });
	const packages = manifest.packages;

	const policy = JSON.parse(readFileSync("docs/release/distribution-policy.json", "utf8"));
	if (policy.channels.homebrew === "enable") {
		if (!options.homebrewArtifacts) throw new Error("Enabled Homebrew releases require retained archive verification before announcement");
		await verifyPublicHomebrewRelease(options.homebrewArtifacts, { version: options.version, sourceCommit });
	}
	const publishedPackages = await verifyPackagesAreAvailable(packages);
	const release = {
		schemaVersion: 1,
		version: options.version,
		sourceCommit,
		publishedAt: new Date().toISOString(),
		packages: publishedPackages,
	};
	if (!isReleaseRecord(release)) throw new Error("Invalid release record; publication refused.");
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "diffex-release-announcement-"));
	try {
		const releasePath = join(temporaryDirectory, "release.json");
		writeFileSync(releasePath, `${JSON.stringify(release, null, "\t")}\n`);
		if (
			!putJson(
				options.bucket,
				options.endpoint,
				releasePath,
				`${RELEASES_PREFIX}/releases/${options.version}.json`,
				"public, max-age=31536000, immutable",
				{ missing: true },
			)
		) {
			const existing = readRelease(
				options.bucket,
				options.endpoint,
				`${RELEASES_PREFIX}/releases/${options.version}.json`,
				join(temporaryDirectory, "existing.json"),
			);
			const identity = ({ schemaVersion, version, sourceCommit, packages }) => ({
				schemaVersion,
				version,
				sourceCommit,
				packages:
					Array.isArray(packages) && packages.every((pkg) => pkg && typeof pkg.name === "string")
						? [...packages].sort((a, b) => a.name.localeCompare(b.name))
						: undefined,
			});
			if (
				!existing ||
				!isDeepStrictEqual(identity(existing.release), identity(release)) ||
				typeof existing.release.publishedAt !== "string" ||
				!Number.isFinite(Date.parse(existing.release.publishedAt))
			) {
				throw new Error("Existing immutable release record conflicts with the verified announcement.");
			}
			writeFileSync(releasePath, existing.body);
			console.log(`Release record ${options.version} already exists and matches verified publication.`);
		}

		const result = await advanceLatestRelease(
			options.version,
			() =>
				readRelease(
					options.bucket,
					options.endpoint,
					`${RELEASES_PREFIX}/latest.json`,
					join(temporaryDirectory, "latest-current.json"),
				),
			(condition) =>
				putJson(options.bucket, options.endpoint, releasePath, `${RELEASES_PREFIX}/latest.json`, "no-store", condition),
		);
		console.log(
			result.advanced
				? `Announced Diffex ${options.version} through s3://${options.bucket}/${RELEASES_PREFIX}/latest.json`
				: `Diffex ${result.version} is already the latest announced release.`,
		);
	} finally {
		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
