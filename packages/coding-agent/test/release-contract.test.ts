import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isLatestVersion } from "../src/utils/release-contract.ts";

const fixtures = JSON.parse(
	readFileSync(new URL("../../../scripts/fixtures/release-contract.json", import.meta.url), "utf8"),
) as { responses: { name: string; status: number; body: unknown; valid: boolean }[] };

describe("Diffex latest-version consumer contract", () => {
	it.each(fixtures.responses)("validates $name", (fixture) => {
		expect(fixture.status === 200 && isLatestVersion(fixture.body)).toBe(fixture.valid);
	});
});
