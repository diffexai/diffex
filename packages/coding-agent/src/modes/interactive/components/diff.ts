import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/** Replace tabs with spaces for consistent rendering. */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function highlightDiffContent(content: string, lang: string | undefined): string {
	const normalized = replaceTabs(content);
	if (!lang) return normalized;
	return highlightCode(normalized, lang)[0] ?? normalized;
}

function renderDiffLine(
	prefix: string,
	lineNum: string,
	content: string,
	color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext",
	lang: string | undefined,
): string {
	if (!lang) {
		return theme.fg(color, `${prefix}${lineNum} ${replaceTabs(content)}`);
	}
	return `${theme.fg(color, `${prefix}${lineNum} `)}${highlightDiffContent(content, lang)}`;
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	lang: string | undefined,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(highlightDiffContent(value, lang));
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(highlightDiffContent(value, lang));
			}
		} else {
			const highlighted = highlightDiffContent(part.value, lang);
			removedLine += highlighted;
			addedLine += highlighted;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path used to determine the syntax highlighting language */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	const lang = options.filePath ? getLanguageFromPath(options.filePath) : undefined;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
					lang,
				);

				if (lang) {
					result.push(`${theme.fg("toolDiffRemoved", `-${removed.lineNum} `)}${removedLine}`);
					result.push(`${theme.fg("toolDiffAdded", `+${added.lineNum} `)}${addedLine}`);
				} else {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
				}
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(renderDiffLine("-", removed.lineNum, removed.content, "toolDiffRemoved", lang));
				}
				for (const added of addedLines) {
					result.push(renderDiffLine("+", added.lineNum, added.content, "toolDiffAdded", lang));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(renderDiffLine("+", parsed.lineNum, parsed.content, "toolDiffAdded", lang));
			i++;
		} else {
			// Context line
			result.push(renderDiffLine(" ", parsed.lineNum, parsed.content, "toolDiffContext", lang));
			i++;
		}
	}

	return result.join("\n");
}
