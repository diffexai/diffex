#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicationFixture } from "./fixtures/release-publication/harness.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--staging") {
	throw new Error("Use --staging with staging-scoped AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
}
if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
	throw new Error("Staging verification requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
}
const fixture = createPublicationFixture({ staging: true });
const commit = randomBytes(20).toString("hex");
const version = `0.${Date.now()}.0`;
const newer = version.replace(/\.0$/, ".1");
const latestKey = "releases/v1/latest.json";
const lockKey = "verification/release-publication.lock";
const keys = [latestKey, `releases/v1/releases/${version}.json`, `releases/v1/releases/${newer}.json`];
let locked = false;
let ready = false;
const failures = [];

function aws(operation, args, { allowMissing = false } = {}) {
	const result = spawnSync(
		"aws",
		["s3api", operation, "--bucket", fixture.bucket, "--endpoint-url", fixture.endpoint, ...args],
		{
			encoding: "utf8",
			timeout: 60000,
			env: { ...process.env, AWS_DEFAULT_REGION: "auto", AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "" },
		},
	);
	const code = /An error occurred \(([^)]+)\)/.exec(result.stderr ?? "")?.[1];
	if (allowMissing && ["NoSuchKey", "404", "NotFound"].includes(code)) return undefined;
	if (result.error || result.status !== 0)
		throw new Error(
			`Staging ${operation} failed; check credentials, concurrency lock, and conditional-write support.`,
		);
	return JSON.parse(result.stdout || "{}");
}
function read(key) {
	const file = join(fixture.directory, "readback.json");
	const metadata = aws("get-object", ["--key", key, file], { allowMissing: true });
	if (!metadata) return undefined;
	return { body: readFileSync(file, "utf8"), metadata };
}
function publish(value, options = {}) {
	const result = fixture.run(value, { commit, ...options });
	assert.equal(
		result.status,
		options.failure ? 1 : 0,
		"Unexpected publisher exit status; provider output is withheld.",
	);
}
function removeOwned(key) {
	const object = read(key);
	if (!object) return;
	assert.ok(JSON.parse(object.body).sourceCommit === commit, "Refusing cleanup of an object owned by another writer.");
	aws("delete-object", ["--key", key]);
	assert.equal(read(key), undefined, "Staging object remains after cleanup.");
}

try {
	const lockFile = join(fixture.directory, "lock.json");
	writeFileSync(lockFile, JSON.stringify({ sourceCommit: commit, keys }));
	aws("put-object", ["--key", lockKey, "--body", lockFile, "--if-none-match", "*"]);
	locked = true;
	for (const key of keys)
		assert.ok(read(key) === undefined, "Staging release keys must be absent before verification.");
	ready = true;
	console.log(`Staging publication fixture: ${version}, ${newer}`);

	for (const failure of ["package", "tarball"]) {
		publish(version, { failure });
		for (const key of keys) assert.equal(read(key), undefined);
	}
	console.log("Missing packages and unavailable tarballs leave absent records unchanged.");
	publish(version);
	const initial = read(latestKey);
	assert.equal(initial.body, read(keys[1]).body);
	assert.equal(initial.metadata.CacheControl, "no-store");
	assert.match(initial.metadata.ContentType, /^application\/json/);
	assert.equal(JSON.parse(initial.body).packages.length, fixture.packageCount);
	console.log("First verified publication creates matching versioned and latest records.");
	publish(version);
	assert.equal(read(latestKey).body, initial.body);
	assert.equal(read(keys[1]).body, initial.body);
	for (const failure of ["package", "tarball"]) {
		publish(newer, { failure });
		assert.equal(read(latestKey).body, initial.body);
		assert.equal(read(keys[2]), undefined);
	}
	console.log("Repeated publication and failed verification preserve existing record bytes.");
	publish(newer);
	const advanced = read(latestKey).body;
	assert.equal(advanced, read(keys[2]).body);
	assert.equal(JSON.parse(advanced).version, newer);
	publish(version);
	assert.equal(read(latestKey).body, advanced);
	console.log("Conditional advancement succeeds and older announcements cannot regress latest.");
	removeOwned(latestKey);
	publish(newer);
	assert.equal(read(latestKey).body, advanced);
	console.log("Interrupted publication recovery reuses the immutable record exactly.");
} catch (error) {
	failures.push(error);
} finally {
	try {
		if (locked) {
			let cleanupFailed = false;
			for (const key of ready ? keys : []) {
				try {
					removeOwned(key);
				} catch (error) {
					cleanupFailed = true;
					failures.push(error);
				}
			}
			if (cleanupFailed) {
				console.error("Staging cleanup failed; retain the lock and inspect this run's keys.");
			} else {
				removeOwned(lockKey);
				console.log("Cleanup verified: fixture keys are absent and the staging lock was removed.");
			}
		}
	} catch (error) {
		failures.push(error);
	} finally {
		fixture.cleanup();
	}
}
if (failures.length) throw new AggregateError(failures, "Staging publication verification failed.");
