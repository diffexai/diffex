import path from "node:path";
import { visibleWidth } from "@earendil-works/diffex-tui";
import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

const GITHUB_REPO = "diffexai/diffex";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;
const STARTUP_PREVIEW_BULLET_RE = /^\s*-\s+(.+?)\s*$/;
const STARTUP_PREVIEW_CODE_FENCE_RE = /^\s*```/;
const STARTUP_PREVIEW_LINK_RE = /!?\[([^\]\n]+)\]\([^\n)]*\)/g;
const DEFAULT_STARTUP_PREVIEW_LINES = 4;
const DEFAULT_STARTUP_PREVIEW_WIDTH = 76;
const startupPreviewSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface StartupChangelogPreviewOptions {
	maxLines?: number;
	maxWidth?: number;
}

function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

function normalizeStartupPreviewText(text: string): string {
	return text
		.replace(STARTUP_PREVIEW_LINK_RE, "$1")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\\([[\]()_*`])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateStartupPreviewLine(line: string, maxWidth: number): string {
	if (visibleWidth(line) <= maxWidth) {
		return line;
	}

	const ellipsis = "...";
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		return ellipsis.slice(0, maxWidth);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let truncated = "";
	let width = 0;
	for (const { segment } of startupPreviewSegmenter.segment(line)) {
		const nextWidth = visibleWidth(segment);
		if (width + nextWidth > targetWidth) {
			break;
		}
		truncated += segment;
		width += nextWidth;
	}

	return `${truncated}${ellipsis}`;
}

export function formatStartupChangelogPreviewLines(
	markdown: string,
	options: StartupChangelogPreviewOptions = {},
): string[] {
	const maxLines = Math.max(0, Math.floor(options.maxLines ?? DEFAULT_STARTUP_PREVIEW_LINES));
	const maxWidth = Math.max(0, Math.floor(options.maxWidth ?? DEFAULT_STARTUP_PREVIEW_WIDTH));
	if (maxLines === 0 || maxWidth === 0) {
		return [];
	}

	const previewLines: string[] = [];
	let inCodeFence = false;

	for (const line of markdown.split("\n")) {
		if (STARTUP_PREVIEW_CODE_FENCE_RE.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) {
			continue;
		}

		const match = STARTUP_PREVIEW_BULLET_RE.exec(line);
		if (!match) {
			continue;
		}

		const normalizedText = normalizeStartupPreviewText(match[1]);
		if (!normalizedText) {
			continue;
		}

		previewLines.push(truncateStartupPreviewLine(`- ${normalizedText}`, maxWidth));
		if (previewLines.length >= maxLines) {
			break;
		}
	}

	return previewLines;
}

export function getStartupChangelogPreviewLines(
	changelogPath: string,
	options: StartupChangelogPreviewOptions = {},
): string[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		return formatStartupChangelogPreviewLines(readFileSync(changelogPath, "utf-8"), options);
	} catch (error) {
		console.error(`Warning: Could not parse startup changelog preview: ${error}`);
		return [];
	}
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// Parse lastVersion
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.ts";
