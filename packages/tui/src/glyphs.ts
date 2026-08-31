export type GlyphMode = "unicode" | "ascii";

export interface TuiGlyphs {
	selected: string;
	start: string;
	rail: string;
	branch: string;
	end: string;
	separator: string;
	bullet: string;
	pending: string;
	running: string;
	success: string;
	warning: string;
	error: string;
	cancelled: string;
	up: string;
	down: string;
	ellipsis: string;
}

const UNICODE_GLYPHS: TuiGlyphs = {
	selected: "›",
	start: "╭",
	rail: "│",
	branch: "├",
	end: "╰",
	separator: "─",
	bullet: "·",
	pending: "…",
	running: "◌",
	success: "✓",
	warning: "!",
	error: "×",
	cancelled: "■",
	up: "↑",
	down: "↓",
	ellipsis: "…",
};

const ASCII_GLYPHS: TuiGlyphs = {
	selected: ">",
	start: "+",
	rail: "|",
	branch: "+",
	end: "\\",
	separator: "-",
	bullet: ".",
	pending: "...",
	running: "*",
	success: "+",
	warning: "!",
	error: "x",
	cancelled: "-",
	up: "^",
	down: "v",
	ellipsis: "...",
};

export function detectGlyphMode(env: Readonly<Record<string, string | undefined>> = process.env): GlyphMode {
	return env.TERM === "dumb" || env.DIFFEX_ASCII === "1" ? "ascii" : "unicode";
}

export function getGlyphs(mode?: GlyphMode): TuiGlyphs {
	const resolvedMode = mode ?? detectGlyphMode(process.env);
	return resolvedMode === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}
