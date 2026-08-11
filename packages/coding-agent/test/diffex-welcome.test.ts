import { describe, expect, test } from "vitest";
import {
	DIFFEX_LOGO_ART,
	DIFFEX_WELCOME_ANIMATION_TICKS,
	renderDiffexWelcomeFrame,
} from "../src/modes/interactive/components/diffex-welcome.ts";

describe("renderDiffexWelcomeFrame", () => {
	test("settles into the Diffex logo", () => {
		expect(renderDiffexWelcomeFrame(DIFFEX_WELCOME_ANIMATION_TICKS, 76)).toEqual(DIFFEX_LOGO_ART);
	});

	test("moves the boat from the center toward the logo position", () => {
		const firstFrame = renderDiffexWelcomeFrame(0, 76);
		const finalBoatFrame = renderDiffexWelcomeFrame(19, 76);
		const firstBoatColumn = Math.min(...firstFrame.map((line) => line.search(/\S/)).filter((column) => column >= 0));
		const finalBoatColumn = Math.min(
			...finalBoatFrame.map((line) => line.search(/\S/)).filter((column) => column >= 0),
		);

		expect(firstBoatColumn).toBeGreaterThan(finalBoatColumn);
		expect(finalBoatColumn).toBe(0);
	});
});
