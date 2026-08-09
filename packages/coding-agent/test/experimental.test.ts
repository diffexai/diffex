import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.DIFFEX_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.DIFFEX_EXPERIMENTAL;
		} else {
			process.env.DIFFEX_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when DIFFEX_EXPERIMENTAL is unset", () => {
		delete process.env.DIFFEX_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when DIFFEX_EXPERIMENTAL is empty", () => {
		process.env.DIFFEX_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when DIFFEX_EXPERIMENTAL is set to 1", () => {
		process.env.DIFFEX_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when DIFFEX_EXPERIMENTAL is set to 0", () => {
		process.env.DIFFEX_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when DIFFEX_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.DIFFEX_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
