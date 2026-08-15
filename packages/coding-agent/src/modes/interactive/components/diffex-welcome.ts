import { type Component, sliceByColumn, Text, type TUI, visibleWidth } from "@earendil-works/diffex-tui";
import { theme } from "../theme/theme.ts";

export const DIFFEX_LOGO_ART = [
	"  /----\\_/----\\  ",
	" |     \\|/     | ",
	"   \\---\\ /---/   ",
	"        X        ",
	"   /---/ \\---\\   ",
	" |     /|\\     | ",
	"  \\____/^\\____/  ",
];

export const DIFFEX_WELCOME_TRAVEL_TICKS = 20;
export const DIFFEX_WELCOME_MORPH_TICKS = 8;
export const DIFFEX_WELCOME_ANIMATION_TICKS = DIFFEX_WELCOME_TRAVEL_TICKS + DIFFEX_WELCOME_MORPH_TICKS;

const BOAT_WIDTH = 18;
const BOAT_FRAMES = [
	["", "      \\ | /", "       \\|/", "    __/___\\__", " __/  o o  \\__", " \\___________/~~", "  ~~  ~~  ~~"],
	["", "       /|\\", "      / | \\", "     _/___\\_", "  __/ o   o \\__", "~~\\___________/", "   ~~  ~~  ~~"],
	["", "      / | \\", "       /|\\", "    __/___\\__", " __/  o o  \\__", "~~\\___________/", " ~~  ~~  ~~"],
	["", "       \\|/", "      \\ | /", "     _/___\\_", "  __/ o   o \\__", " \\___________/~~", "   ~~  ~~  ~~"],
];

export function diffexIntroText(text: string): string {
	return theme.fg("startupIntroText", text);
}

export function diffexIntroAccent(text: string): string {
	return theme.fg("startupIntroAccent", text);
}

export function diffexIntroTextBold(text: string): string {
	return theme.bold(diffexIntroText(text));
}

function padToWidth(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function boatFrame(tick: number, width: number, offset: number): string[] {
	const frame = BOAT_FRAMES[Math.floor(tick / 2) % BOAT_FRAMES.length];
	const placement = " ".repeat(Math.min(offset, Math.max(0, width - 1)));
	return frame.map((line) => placement + padToWidth(line, BOAT_WIDTH));
}

function morphFrame(boat: string[], phase: number): string[] {
	const artWidth = Math.max(...DIFFEX_LOGO_ART.map(visibleWidth));
	const centerColumn = Math.floor(artWidth / 2);
	const centerRow = Math.floor(DIFFEX_LOGO_ART.length / 2);
	const maxDistance = centerColumn + centerRow;
	const threshold = Math.ceil((phase * maxDistance) / DIFFEX_WELCOME_MORPH_TICKS);

	return DIFFEX_LOGO_ART.map((artLine, row) => {
		const boatLine = padToWidth(boat[row] ?? "", artWidth);
		return Array.from({ length: artWidth }, (_, column) => {
			const distance = Math.abs(column - centerColumn) + Math.abs(row - centerRow);
			return distance <= threshold ? (artLine[column] ?? " ") : (boatLine[column] ?? " ");
		}).join("");
	});
}

/** Render a Diffex boat entrance frame which settles into the Diffex mark. */
export function renderDiffexWelcomeFrame(tick: number, width: number): string[] {
	if (tick >= DIFFEX_WELCOME_ANIMATION_TICKS) {
		return [...DIFFEX_LOGO_ART];
	}

	if (tick < DIFFEX_WELCOME_TRAVEL_TICKS) {
		const startingOffset = Math.floor(Math.max(0, width - BOAT_WIDTH) / 2);
		const progress = Math.min(tick, DIFFEX_WELCOME_TRAVEL_TICKS - 1);
		const offset = startingOffset - Math.floor((startingOffset * progress) / (DIFFEX_WELCOME_TRAVEL_TICKS - 1));
		return boatFrame(tick, width, offset);
	}

	return morphFrame(boatFrame(tick, BOAT_WIDTH, 0), tick - DIFFEX_WELCOME_TRAVEL_TICKS + 1);
}

/** Expandable startup header with the Diffex entrance animation. */
export class DiffexWelcomeHeader implements Component {
	private readonly ui: TUI;
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;
	private expanded: boolean;
	private tick = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private readonly details = new Text("", 1, 0);
	private detailsText: string | undefined;

	constructor(ui: TUI, getCollapsedText: () => string, getExpandedText: () => string, expanded = false) {
		this.ui = ui;
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
		this.expanded = expanded;
		this.updateDetails();
		this.interval = setInterval(() => {
			this.tick++;
			this.ui.requestRender();
			if (this.tick >= DIFFEX_WELCOME_ANIMATION_TICKS) {
				this.dispose();
			}
		}, 90);
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDetails();
	}

	invalidate(): void {
		this.details.invalidate();
	}

	render(width: number): string[] {
		this.updateDetails();
		if (width < 4) {
			return [...renderDiffexWelcomeFrame(this.tick, width).map(diffexIntroText), ...this.details.render(width)];
		}

		const innerWidth = width - 2;
		const contentPadding = innerWidth > 2 ? 1 : 0;
		const contentWidth = Math.max(1, innerWidth - contentPadding * 2);
		const horizontal = "─".repeat(innerWidth);
		const topBorder = diffexIntroAccent(`┌${horizontal}┐`);
		const bottomBorder = diffexIntroAccent(`└${horizontal}┘`);
		const renderBoxLine = (line: string): string => {
			const clipped = sliceByColumn(line, 0, contentWidth, true);
			const visiblePadding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
			const paddedContent = " ".repeat(contentPadding) + clipped + visiblePadding + " ".repeat(contentPadding);
			const innerPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(paddedContent)));
			return diffexIntroAccent("│") + paddedContent + innerPadding + diffexIntroAccent("│");
		};

		const art = renderDiffexWelcomeFrame(this.tick, contentWidth).map((line) => {
			return diffexIntroText(padToWidth(sliceByColumn(line, 0, contentWidth, true), contentWidth));
		});
		const details = this.details.render(contentWidth);

		return [topBorder, ...art.map(renderBoxLine), renderBoxLine(""), ...details.map(renderBoxLine), bottomBorder];
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	private updateDetails(): void {
		const detailsText = this.expanded ? this.getExpandedText() : this.getCollapsedText();
		if (detailsText === this.detailsText) {
			return;
		}
		this.detailsText = detailsText;
		this.details.setText(detailsText);
	}
}
