import { type Component, getGlyphs, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/diffex-tui";
import { theme } from "../theme/theme.ts";

const EXTENDED_HINGE_MIN_COLUMNS = 80;

export type DiffexPathMarker = "start" | "branch" | "end";
export type DiffexPathOrigin = "standalone" | "user-dock" | "continued";

export interface DiffexPathLabelOptions {
	marker: DiffexPathMarker;
	padding?: number;
	fill?: boolean;
	minimumFillWidth?: number;
	markerColor?: (text: string) => string;
	labelColor?: (text: string) => string;
	ruleColor?: (text: string) => string;
}

function resolveMarker(marker: DiffexPathMarker): string {
	const glyphs = getGlyphs();
	if (marker === "start") {
		return glyphs.start;
	}
	if (marker === "branch") {
		return glyphs.branch;
	}
	return glyphs.end;
}

export function formatDiffexPathPrefix(
	marker: DiffexPathMarker,
	color: (text: string) => string = (text) => theme.fg("borderAccent", text),
): string {
	return `${color(resolveMarker(marker))} `;
}

export class DiffexPathLabel implements Component {
	private readonly label: string;
	private readonly marker: DiffexPathMarker;
	private padding: number;
	private readonly fill: boolean;
	private readonly minimumFillWidth: number;
	private readonly markerColor: (text: string) => string;
	private readonly labelColor: (text: string) => string;
	private readonly ruleColor: (text: string) => string;

	constructor(label: string, options: DiffexPathLabelOptions) {
		this.label = label;
		this.marker = options.marker;
		this.padding = options.padding ?? 1;
		this.fill = options.fill ?? false;
		this.minimumFillWidth = options.minimumFillWidth ?? 72;
		this.markerColor = options.markerColor ?? ((text) => theme.fg("borderAccent", text));
		this.labelColor = options.labelColor ?? ((text) => theme.fg("muted", text));
		this.ruleColor = options.ruleColor ?? ((text) => theme.fg("borderMuted", text));
	}

	setPadding(padding: number): void {
		this.padding = padding;
	}

	invalidate(): void {
		// Styling is resolved during render so theme changes do not require cached state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const padding = Math.min(Math.max(0, this.padding), Math.max(0, safeWidth - 1));
		const leftPad = " ".repeat(padding);
		const glyphs = getGlyphs();
		const marker = resolveMarker(this.marker);
		const connector = this.fill ? `${marker}${glyphs.separator}` : marker;
		let line = `${leftPad}${this.markerColor(connector)} ${this.labelColor(this.label)}`;

		if (this.fill && safeWidth >= this.minimumFillWidth) {
			const remaining = safeWidth - visibleWidth(line);
			if (remaining >= 2) {
				line += ` ${this.ruleColor(glyphs.separator.repeat(remaining - 1))}`;
			}
		}

		return [visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line];
	}
}

export class DiffexPathRail implements Component {
	private padding: number;
	private readonly color: (text: string) => string;

	constructor(padding = 1, color: (text: string) => string = (text) => theme.fg("borderMuted", text)) {
		this.padding = padding;
		this.color = color;
	}

	setPadding(padding: number): void {
		this.padding = padding;
	}

	invalidate(): void {
		// Styling is resolved during render so theme changes do not require cached state.
	}

	protected resolveGlyph(): string {
		return getGlyphs().rail;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const padding = Math.min(Math.max(0, this.padding), Math.max(0, safeWidth - 1));
		const line = `${" ".repeat(padding)}${this.color(this.resolveGlyph())}`;
		return [visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line];
	}
}

/** A blank row owned by an adjacent response path transition. */
export class DiffexPathSpacer extends Spacer {
	constructor() {
		super(1);
	}
}

/** Close an otherwise unlabeled response path after its final content block. */
export class DiffexPathTerminus extends DiffexPathRail {
	protected override resolveGlyph(): string {
		return getGlyphs().end;
	}
}

/** Draw the transmitter socket below the user surface. */
export class DiffexPathHinge implements Component {
	private extended = false;
	private padding: number;

	constructor(padding = 0) {
		this.padding = padding;
	}

	setExtended(extended: boolean): void {
		this.extended = extended;
	}

	setPadding(padding: number): void {
		this.padding = padding;
	}

	invalidate(): void {
		// Styling and glyph mode are resolved during render.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const padding = Math.min(Math.max(0, this.padding), Math.max(0, safeWidth - 1));
		const glyphs = getGlyphs();
		const corner = theme.fg("borderAccent", resolveMarker("start"));
		const lip = this.extended ? theme.fg("borderMuted", glyphs.separator.repeat(2)) : "";
		const line = `${" ".repeat(padding)}${corner}${lip}`;
		return [visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line];
	}
}

/** Join a docked user surface to the first response node. */
export class DiffexPathDockHinge implements Component {
	private readonly hinge: DiffexPathHinge;

	constructor(padding = 1) {
		this.hinge = new DiffexPathHinge(padding);
	}

	setOutputPad(padding: number): void {
		this.hinge.setPadding(padding);
	}

	invalidate(): void {
		this.hinge.invalidate();
	}

	render(width: number): string[] {
		this.hinge.setExtended(shouldExtendDiffexPathHinge(width));
		return ["", ...this.hinge.render(width)];
	}
}

export function shouldExtendDiffexPathHinge(width: number): boolean {
	return width >= EXTENDED_HINGE_MIN_COLUMNS;
}
