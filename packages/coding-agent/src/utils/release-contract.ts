// Kept in agreement with the CLI publisher through the shared contract fixtures.
export const RELEASE_PACKAGE_NAME = "@diffexai/diffex";

export interface ReleasePackage {
	name: string;
	version: string;
	tarball: string;
	integrity: string;
}

export interface ReleaseRecord {
	schemaVersion: 1;
	version: string;
	sourceCommit: string;
	publishedAt: string;
	packages: ReleasePackage[];
}

export interface LatestVersion {
	version: string;
	packageName: typeof RELEASE_PACKAGE_NAME;
}

function matches(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

export function isStableVersion(value: unknown): value is string {
	return matches(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
}

function hasFields(value: unknown, fields: string[]): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === fields.length &&
		fields.every((field) => Object.hasOwn(value, field))
	);
}

function isTarball(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() !== value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.href === value && !url.username && !url.password && !url.hash;
	} catch {
		return false;
	}
}

function isIntegrity(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
	if (!match || match[0] !== value) return false;
	try {
		const decoded = atob(match[2]);
		return decoded.length === Number(match[1].slice(3)) / 8 && btoa(decoded) === match[2];
	} catch {
		return false;
	}
}

export function isReleaseRecord(value: unknown): value is ReleaseRecord {
	if (
		!hasFields(value, ["schemaVersion", "version", "sourceCommit", "publishedAt", "packages"]) ||
		value.schemaVersion !== 1 ||
		!isStableVersion(value.version) ||
		!matches(value.sourceCommit, /^[a-f0-9]{40}$/) ||
		!matches(value.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) ||
		!Number.isFinite(Date.parse(value.publishedAt)) ||
		new Date(value.publishedAt).toISOString() !== value.publishedAt ||
		!Array.isArray(value.packages) ||
		value.packages.length === 0
	) {
		return false;
	}

	const names = new Set<string>();
	for (const pkg of value.packages) {
		if (
			!hasFields(pkg, ["name", "version", "tarball", "integrity"]) ||
			!matches(pkg.name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/) ||
			pkg.name.length > 214 ||
			names.has(pkg.name) ||
			pkg.version !== value.version ||
			!isTarball(pkg.tarball) ||
			!isIntegrity(pkg.integrity)
		) {
			return false;
		}
		names.add(pkg.name);
	}
	return names.has(RELEASE_PACKAGE_NAME);
}

export function isLatestVersion(value: unknown): value is LatestVersion {
	return (
		hasFields(value, ["version", "packageName"]) &&
		isStableVersion(value.version) &&
		value.packageName === RELEASE_PACKAGE_NAME
	);
}
