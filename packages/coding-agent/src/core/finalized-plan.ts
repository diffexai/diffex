import type { AssistantMessage } from "@diffexai/diffex-ai/compat";

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

interface TextLine {
	readonly text: string;
	readonly start: number;
	readonly end: number;
	readonly endWithLineBreak: number;
}

interface TagLine {
	readonly contentIndex: number;
	readonly line: TextLine;
}

export interface FinalizedPlanResponse {
	readonly message: AssistantMessage;
	readonly plan: string;
}

function splitTextLines(text: string): TextLine[] {
	const lines: TextLine[] = [];
	let start = 0;
	while (start < text.length) {
		const lineFeed = text.indexOf("\n", start);
		if (lineFeed === -1) {
			lines.push({ text: text.slice(start), start, end: text.length, endWithLineBreak: text.length });
			return lines;
		}
		const end = lineFeed > start && text[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed;
		lines.push({ text: text.slice(start, end), start, end, endWithLineBreak: lineFeed + 1 });
		start = lineFeed + 1;
	}
	if (text.endsWith("\n")) {
		lines.push({ text: "", start: text.length, end: text.length, endWithLineBreak: text.length });
	}
	return lines;
}

function scanTextItem(text: string, contentIndex: number): { opening?: TagLine; closing?: TagLine; invalid: boolean } {
	let opening: TagLine | undefined;
	let closing: TagLine | undefined;
	let fence: { character: "`" | "~"; length: number } | undefined;
	let invalid = false;

	for (const line of splitTextLines(text)) {
		if (fence) {
			const escapedCharacter = fence.character === "`" ? "`" : "~";
			const closingFence = new RegExp(`^ {0,3}${escapedCharacter}{${fence.length},}[ \\t]*$`);
			if (closingFence.test(line.text)) fence = undefined;
			continue;
		}

		const openingFence = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (openingFence) {
			const marker = openingFence[1];
			const character = marker[0] as "`" | "~";
			if (character === "~" || !openingFence[2].includes("`")) {
				fence = { character, length: marker.length };
				continue;
			}
		}

		const containsOpening = line.text.includes(OPEN_TAG);
		const containsClosing = line.text.includes(CLOSE_TAG);
		if (!containsOpening && !containsClosing) continue;

		if (line.text === OPEN_TAG && opening === undefined && !containsClosing) {
			opening = { contentIndex, line };
		} else if (line.text === CLOSE_TAG && closing === undefined && !containsOpening) {
			closing = { contentIndex, line };
		} else {
			invalid = true;
		}
	}

	return { opening, closing, invalid };
}

/** Parse one strict finalized Plan response without mutating the supplied message. */
export function parseFinalizedPlanResponse(message: AssistantMessage): FinalizedPlanResponse | undefined {
	if (message.stopReason !== "stop") return undefined;

	let opening: TagLine | undefined;
	let closing: TagLine | undefined;
	let invalid = false;
	for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
		const content = message.content[contentIndex];
		if (content.type !== "text") continue;
		const scanned = scanTextItem(content.text, contentIndex);
		invalid ||= scanned.invalid;
		if (scanned.opening) {
			if (opening) invalid = true;
			else opening = scanned.opening;
		}
		if (scanned.closing) {
			if (closing) invalid = true;
			else closing = scanned.closing;
		}
	}

	if (
		invalid ||
		!opening ||
		!closing ||
		opening.contentIndex !== closing.contentIndex ||
		opening.line.start >= closing.line.start
	) {
		return undefined;
	}

	const content = message.content[opening.contentIndex];
	if (content.type !== "text") return undefined;
	const plan = content.text.slice(opening.line.endWithLineBreak, closing.line.start);
	if (plan.trim().length === 0) return undefined;

	const cleanText =
		content.text.slice(0, opening.line.start) +
		content.text.slice(opening.line.endWithLineBreak, closing.line.start) +
		content.text.slice(closing.line.endWithLineBreak);
	const cleanContent = message.content.slice();
	cleanContent[opening.contentIndex] = { ...content, text: cleanText };
	return { message: { ...message, content: cleanContent }, plan };
}
