import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isLatestVersion, isReleaseRecord } from "../packages/coding-agent/src/utils/release-contract.ts";
import { createPublicationFixture } from "./fixtures/release-publication/harness.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/release-contract.json", import.meta.url), "utf8"));
for (const { name, value } of fixtures.valid) {
	test(`accepts ${name}`, () => assert.equal(isReleaseRecord(value), true));
}
for (const { name, value } of fixtures.invalid) {
	test(`rejects ${name}`, () => assert.equal(isReleaseRecord(value), false));
}
for (const fixture of fixtures.responses) {
	test(`response ${fixture.name}`, () => {
		assert.equal(fixture.status === 200 && isLatestVersion(fixture.body), fixture.valid);
	});
}
test("real publisher output conforms to the shared Worker record contract", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("1.2.3");
		assert.equal(result.status, 0, result.stderr);
		for (const body of Object.values(fixture.state().objects)) {
			const record = JSON.parse(body);
			assert.equal(isReleaseRecord(record), true);
			assert.equal(record.packages.length, fixture.packageCount);
			assert.deepEqual(
				{
					version: record.version,
					packageName: record.packages.find((pkg) => pkg.name === "@diffexai/diffex").name,
				},
				fixtures.http[0].body,
			);
		}
	} finally {
		fixture.cleanup();
	}
});
test("publisher rejects every invalid stored latest record without replacing its bytes", () => {
	const fixture = createPublicationFixture();
	try {
		for (const { name, value } of fixtures.invalid) {
			const body = JSON.stringify(value);
			fixture.seed({ "releases/v1/latest.json": body });
			const result = fixture.run("1.2.3");
			assert.equal(result.status, 1, name);
			assert.match(result.stderr, /Invalid release record/, name);
			assert.equal(fixture.state().objects["releases/v1/latest.json"], body, name);
		}
	} finally {
		fixture.cleanup();
	}
});
