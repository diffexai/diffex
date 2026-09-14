import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isLatestVersion, isReleaseRecord } from "../packages/coding-agent/src/utils/release-contract.ts";
import { createPublicationFixture } from "./fixtures/release-publication/harness.mjs";
import { advanceLatestRelease, parseStoredRelease } from "./publish-release-announcement.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/release-contract.json", import.meta.url), "utf8"));
for (const { name, value } of fixtures.valid) {
	test(`accepts ${name}`, () => assert.equal(isReleaseRecord(value), true));
	test(`parses stored ${name} without changing its data`, () => {
		assert.deepEqual(parseStoredRelease(JSON.stringify(value)), value);
	});
}

test("stored release parser redacts malformed JSON", () => {
	assert.throws(() => parseStoredRelease("malformed fixture-secret"), {
		name: "Error",
		message: "Diffex release record is not valid JSON.",
	});
});
for (const { name, value } of fixtures.invalid) {
	test(`rejects ${name}`, () => assert.equal(isReleaseRecord(value), false));
	test(`latest advancement rejects stored ${name} without writing`, async () => {
		const body = JSON.stringify(value);
		let storedBody = body;
		let writeCount = 0;
		await assert.rejects(
			advanceLatestRelease(
				"1.2.3",
				() => {
					const release = parseStoredRelease(storedBody);
					return { etag: '"current"', version: release.version, release, body: storedBody };
				},
				() => {
					writeCount++;
					storedBody = JSON.stringify(fixtures.valid[0].value);
					return true;
				},
			),
			{ name: "Error", message: "Invalid release record in storage." },
		);
		assert.equal(writeCount, 0);
		assert.equal(storedBody, body);
	});
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
for (const { name, key } of [
	{ name: "missing schemaVersion", key: "releases/v1/latest.json" },
	{ name: "unknown package field", key: "releases/v1/latest.json" },
	{ name: "missing schemaVersion", key: "releases/v1/releases/1.2.3.json" },
]) {
	test(`publisher rejects stored ${name} in ${key} without writing latest`, () => {
		const fixture = createPublicationFixture();
		try {
			const invalid = fixtures.invalid.find((record) => record.name === name);
			assert.ok(invalid, `Missing invalid fixture: ${name}`);
			const body = JSON.stringify(invalid.value);
			fixture.seed({ [key]: body });
			const result = fixture.run("1.2.3");
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /Invalid release record in storage/);
			assert.match(result.stdout, /All \d+ Diffex packages are available from npm/);
			const state = fixture.state();
			assert.equal(state.objects[key], body);
			assert.equal(
				state.calls.some(([, operation, objectKey]) => operation === "put-object" && objectKey === "releases/v1/latest.json"),
				false,
			);
			assert.equal(state.objects["releases/v1/latest.json"], key === "releases/v1/latest.json" ? body : undefined);
			assert.ok(state.objects["releases/v1/releases/1.2.3.json"]);
		} finally {
			fixture.cleanup();
		}
	});
}
