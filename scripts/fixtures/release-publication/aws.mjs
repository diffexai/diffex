#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const path = process.env.DIFFEX_PUBLICATION_STORAGE;
const state = JSON.parse(readFileSync(path, "utf8"));
const key = value("--key");
const object = state.objects[key];
if (state.failure) {
	console.error(`An error occurred (${state.failure}) when calling the fixture operation: fixture-secret`);
	process.exit(1);
}
function fail(code) {
	console.error(`An error occurred (${code}) when calling the fixture operation`);
	process.exit(1);
}
if (
	args[0] !== "s3api" ||
	value("--bucket") !== "fixture-releases" ||
	value("--endpoint-url") !== "https://storage.example.invalid"
)
	fail("AccessDenied");
state.calls.push(args.slice(0, 2).concat(key));
writeFileSync(path, JSON.stringify(state));
const etag = (body) => `"${createHash("sha256").update(body).digest("hex")}"`;
if (args[1] === "head-object" || args[1] === "get-object") {
	if (!object) fail("NoSuchKey");
	if (args[1] === "get-object") writeFileSync(args.at(-1), object);
	console.log(JSON.stringify({ ETag: etag(object) }));
} else if (args[1] === "put-object") {
	if (args.includes("--if-none-match") && object) fail("PreconditionFailed");
	if (args.includes("--if-match") && (!object || etag(object) !== value("--if-match"))) fail("PreconditionFailed");
	if (!existsSync(value("--body"))) fail("MissingBody");
	state.objects[key] = readFileSync(value("--body"), "utf8");
	writeFileSync(path, JSON.stringify(state));
	console.log(JSON.stringify({ ETag: etag(state.objects[key]) }));
} else fail("UnmockedOperation");
