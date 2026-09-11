import { compare, valid } from "semver";
import type { RequestInit as UndiciRequestInit } from "undici";
import { getDiffexUserAgent } from "./diffex-user-agent.ts";
import { fetchWithRetry } from "./management-http.ts";
import { isLatestVersion, type LatestVersion } from "./release-contract.ts";

const LATEST_VERSION_URL = "https://api.diffex.ai/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestDiffexRelease extends LatestVersion {
	// Retain note rendering for a future coordinated contract extension.
	// The current HTTP contract has no note field and cannot populate this.
	note?: string;
}

export class VersionCheckError extends Error {
	readonly reason: "no-release" | "unavailable" | "invalid-release";

	constructor(reason: VersionCheckError["reason"]) {
		const messages = {
			"no-release": "No published Diffex release is available yet.",
			unavailable: "Diffex update service is unavailable. Try again later.",
			"invalid-release": "Refusing self-update: expected a stable @diffexai/diffex release.",
		};
		super(messages[reason]);
		this.name = "VersionCheckError";
		this.reason = reason;
	}
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestDiffexRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestDiffexRelease | undefined> {
	if (process.env.DIFFEX_OFFLINE) return undefined;

	const requestOptions = {
		// Never forward a version request to a redirected authority or path.
		redirect: "manual",
		credentials: "omit",
		cache: "no-store",
		headers: {
			"User-Agent": getDiffexUserAgent(currentVersion),
			accept: "application/json",
		},
	} satisfies UndiciRequestInit;
	const response = await fetchWithRetry(LATEST_VERSION_URL, requestOptions, {
		maxRetries: options.retry ? 2 : 0,
		timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
	});
	if (
		(response.status !== 200 && response.status !== 404) ||
		response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
	) {
		await response.body?.cancel().catch(() => {});
		throw new VersionCheckError("unavailable");
	}

	const data: unknown = await response.json().catch(() => {
		throw new VersionCheckError("unavailable");
	});
	if (response.status === 404) {
		if (
			typeof data === "object" &&
			data !== null &&
			!Array.isArray(data) &&
			Object.keys(data).length === 1 &&
			"error" in data &&
			data.error === "no_published_release"
		) {
			throw new VersionCheckError("no-release");
		}
		throw new VersionCheckError("unavailable");
	}
	// The shared contract permits arbitrary integer components; npm's semver
	// implementation cannot safely install values outside its supported range.
	if (!isLatestVersion(data) || valid(data.version) !== data.version) {
		throw new VersionCheckError("invalid-release");
	}
	return { version: data.version, packageName: data.packageName };
}

export async function getLatestDiffexVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestDiffexRelease(currentVersion, options))?.version;
}

export async function checkForNewDiffexVersion(currentVersion: string): Promise<LatestDiffexRelease | undefined> {
	if (process.env.DIFFEX_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestDiffexRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
