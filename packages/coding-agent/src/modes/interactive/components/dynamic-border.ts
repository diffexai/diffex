import { type Component, getGlyphs } from "@diffexai/diffex-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const inset = width >= 4 ? 1 : 0;
		const margin = " ".repeat(inset);
		const separator = getGlyphs().separator.repeat(Math.max(1, width - inset * 2));
		return [`${margin}${this.color(separator)}${margin}`];
	}
}
