import { getGlyphs } from "@diffexai/diffex-tui";
import { describe, expect, it } from "vitest";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.ts";

describe("DynamicBorder", () => {
	it("renders a softer inset separator at normal widths", () => {
		const border = new DynamicBorder((text) => text);

		expect(border.render(8)).toEqual([` ${getGlyphs().separator.repeat(6)} `]);
	});

	it("retains a visible separator at tiny widths", () => {
		const border = new DynamicBorder((text) => text);

		expect(border.render(1)).toEqual([getGlyphs().separator]);
	});
});
