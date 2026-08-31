import { type Component, getGlyphs, sliceByColumn, Text, type TUI, visibleWidth } from "@earendil-works/diffex-tui";
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

export const DIFFEX_WELCOME_BOOT_TICKS = 4;
export const DIFFEX_WELCOME_TRAVEL_TICKS = 16;
export const DIFFEX_WELCOME_MORPH_TICKS = 6;
export const DIFFEX_WELCOME_ANIMATION_TICKS =
	DIFFEX_WELCOME_BOOT_TICKS + DIFFEX_WELCOME_TRAVEL_TICKS + DIFFEX_WELCOME_MORPH_TICKS;
export const DIFFEX_WELCOME_MIN_ROWS = 22;

const BOAT_WIDTH = 18;
const WIDE_LAYOUT_MIN_WIDTH = 46;
const LOGO_ART_WIDTH = Math.max(...DIFFEX_LOGO_ART.map(visibleWidth));
const ART_COLUMN_WIDTH = LOGO_ART_WIDTH + 2;
const ART_DETAILS_GAP = "   ";
const COMPACT_ART_ROWS = [2, 3, 4];
const FRAME_INTERVAL_MS = 70;
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
	const frame = BOAT_FRAMES[tick % BOAT_FRAMES.length];
	const placement = " ".repeat(Math.min(offset, Math.max(0, width - 1)));
	return frame.map((line) => placement + padToWidth(line, BOAT_WIDTH));
}

function boatOffset(tick: number, width: number): number {
	const startingOffset = Math.max(0, width - BOAT_WIDTH);
	if (tick < DIFFEX_WELCOME_BOOT_TICKS) {
		return startingOffset;
	}

	const travelTick = Math.min(Math.max(0, tick - DIFFEX_WELCOME_BOOT_TICKS), DIFFEX_WELCOME_TRAVEL_TICKS - 1);
	return startingOffset - Math.floor((startingOffset * travelTick) / Math.max(1, DIFFEX_WELCOME_TRAVEL_TICKS - 1));
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

	const motionTick = tick - DIFFEX_WELCOME_BOOT_TICKS;
	if (motionTick < DIFFEX_WELCOME_TRAVEL_TICKS) {
		return boatFrame(tick, width, boatOffset(tick, width));
	}

	return morphFrame(boatFrame(tick, BOAT_WIDTH, 0), motionTick - DIFFEX_WELCOME_TRAVEL_TICKS + 1);
}

/** Render the wake that settles into the boundary below the welcome region. */
export function renderDiffexWelcomeBoundary(tick: number, width: number): string {
	const renderWidth = Math.max(0, Math.floor(width));
	if (renderWidth === 0 || tick < DIFFEX_WELCOME_BOOT_TICKS) {
		return "";
	}

	const effectiveBoatWidth = Math.min(BOAT_WIDTH, renderWidth);
	let trailStart: number;
	if (tick < DIFFEX_WELCOME_BOOT_TICKS + DIFFEX_WELCOME_TRAVEL_TICKS) {
		trailStart = Math.min(renderWidth, boatOffset(tick, renderWidth) + effectiveBoatWidth);
	} else if (tick < DIFFEX_WELCOME_ANIMATION_TICKS) {
		const morphTick = tick - DIFFEX_WELCOME_BOOT_TICKS - DIFFEX_WELCOME_TRAVEL_TICKS + 1;
		trailStart = Math.max(
			0,
			effectiveBoatWidth - Math.ceil((effectiveBoatWidth * morphTick) / DIFFEX_WELCOME_MORPH_TICKS),
		);
	} else {
		trailStart = 0;
	}

	return `${" ".repeat(trailStart)}${getGlyphs().separator.repeat(renderWidth - trailStart)}`;
}

/** Expandable startup header with the Diffex entrance animation. */
export class DiffexWelcomeHeader implements Component {
	private readonly ui: TUI;
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;
	private expanded: boolean;
	private tick = 0;
	private interval: ReturnType<typeof setInterval> | undefined;
	private readonly details = new Text("", 0, 0);
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
		}, FRAME_INTERVAL_MS);
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
		if (width <= 0 || this.ui.terminal.rows < DIFFEX_WELCOME_MIN_ROWS) {
			return [];
		}

		const boundary = renderDiffexWelcomeBoundary(this.tick, width);
		const styledBoundary =
			boundary.length === 0
				? ""
				: this.tick < DIFFEX_WELCOME_ANIMATION_TICKS
					? diffexIntroAccent(boundary)
					: theme.fg("borderMuted", boundary);
		const isTraveling = this.tick < DIFFEX_WELCOME_BOOT_TICKS + DIFFEX_WELCOME_TRAVEL_TICKS;
		const bootMessage = sliceByColumn(
			`${diffexIntroText("  Booting ")}${diffexIntroAccent("Diffex")}${diffexIntroText(getGlyphs().ellipsis)}`,
			0,
			width,
			true,
		);

		if (width < WIDE_LAYOUT_MIN_WIDTH) {
			const frame = renderDiffexWelcomeFrame(this.tick, width);
			const compactArt = COMPACT_ART_ROWS.map((row) => {
				const line = sliceByColumn(frame[row] ?? "", 0, width, true);
				return diffexIntroAccent(line);
			});
			return isTraveling
				? [bootMessage, ...compactArt, "", styledBoundary]
				: [...compactArt, ...this.details.render(width), styledBoundary];
		}

		if (isTraveling) {
			const scene = renderDiffexWelcomeFrame(this.tick, width).map((line) =>
				diffexIntroAccent(sliceByColumn(line, 0, width, true)),
			);
			scene[0] = bootMessage;
			return [...scene, styledBoundary];
		}

		const artWidth = Math.min(ART_COLUMN_WIDTH, width);
		const detailsWidth = Math.max(1, width - artWidth - visibleWidth(ART_DETAILS_GAP));
		const art = renderDiffexWelcomeFrame(this.tick, artWidth).map((line) =>
			diffexIntroAccent(padToWidth(sliceByColumn(line, 0, artWidth, true), artWidth)),
		);
		const details = this.details.render(detailsWidth);
		const rowCount = Math.max(art.length, details.length);
		const artOffset = Math.floor((rowCount - art.length) / 2);
		const detailsOffset = Math.floor((rowCount - details.length) / 2);

		const content = Array.from({ length: rowCount }, (_, row) => {
			const artLine = art[row - artOffset] ?? " ".repeat(artWidth);
			const detailsLine = details[row - detailsOffset] ?? "";
			return `${artLine}${ART_DETAILS_GAP}${detailsLine}`;
		});
		return [...content, styledBoundary];
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
