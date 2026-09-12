#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const path = process.env.DIFFEX_PUBLICATION_STORAGE;
const state = JSON.parse(readFileSync(path, "utf8"));
const fixture = JSON.parse(readFileSync(process.env.DIFFEX_PUBLICATION_FIXTURE, "utf8"));
const args = process.argv.slice(2);
if (args[0] !== "publish" || !args.includes("--ignore-scripts") || !args.includes("--provenance"))
	throw new Error("Unmocked npm request");
const file = basename(args.at(-1));
const pkg = fixture.packages.find(
	(pkg) => file === `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
);
if (!pkg || readFileSync(args.at(-1), "utf8") !== `approved ${pkg.name}@${pkg.version}`)
	throw new Error("Publishing unexpected artifact bytes");
state.published ??= [];
if (state.published.includes(pkg.name)) throw new Error("Attempted to rewrite a published npm version");
if (fixture.failPublishAt === pkg.name) process.exit(1);
state.published.push(pkg.name);
writeFileSync(path, JSON.stringify(state));
