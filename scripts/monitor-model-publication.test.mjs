import assert from "node:assert/strict";
import test from "node:test";
import { checkPublicationRuns, expectedPublication } from "./monitor-model-publication.mjs";

test("monitors successful generation and publication separately, including unchanged catalogs", () => {
	const now = new Date("2026-10-26T11:30:00Z");
	const completed_at = "2026-10-26T09:30:00Z";
	const generated = { name: "generate", conclusion: "success", completed_at };
	const published = { name: "publish", steps: [{ name: "Publish model catalog to R2", conclusion: "success", completed_at }] };
	assert.doesNotThrow(() => checkPublicationRuns([generated, published], now));
	assert.throws(() => checkPublicationRuns([generated], now), /publication/);
	assert.throws(() => checkPublicationRuns([published], now), /generation/);
	assert.throws(() => checkPublicationRuns([], now), /Missed/);
});

test("allows runner delay and handles weekends and DST", () => {
	assert.equal(new Date(expectedPublication(new Date("2026-10-26T10:00:00Z"))).toISOString(), "2026-10-23T12:17:00.000Z");
	assert.equal(new Date(expectedPublication(new Date("2026-10-26T10:18:00Z"))).toISOString(), "2026-10-26T09:17:00.000Z");
	assert.equal(new Date(expectedPublication(new Date("2026-03-30T09:18:00Z"))).toISOString(), "2026-03-30T08:17:00.000Z");
});
