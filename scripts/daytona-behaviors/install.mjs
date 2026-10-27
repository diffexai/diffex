import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installConsumer, verifyTarballs } from "../artifact-installation.mjs";

const [artifacts, consumer, manager, commit] = process.argv.slice(2);
assert(artifacts && consumer && ["npm", "bun"].includes(manager) && /^[a-f0-9]{40}$/.test(commit),
	"Usage: node install.mjs ARTIFACTS CONSUMER npm|bun COMMIT");
const manifest = JSON.parse(readFileSync(join(artifacts, "manifest.json"), "utf8"));
assert.equal(manifest.source.commit, commit, "Retained source does not match triggering commit");
assert.equal(manifest.schemaVersion, 1);
const packages = manifest.packages;
assert.equal(packages.length, 1, "Expected the standalone CLI distribution");
assert.equal(packages[0].name, "@diffexai/diffex");
verifyTarballs(artifacts, packages, packages);
installConsumer(resolve(consumer), manager, packages, packages, resolve(artifacts));
const executable = join(resolve(consumer), "node_modules/.bin/diffex");
assert(realpathSync(executable).startsWith(`${resolve(consumer)}/node_modules/`));
writeFileSync(join(consumer, "installation.json"), `${JSON.stringify({
	manager, executable, resolved: realpathSync(executable), commit,
	artifacts: packages.map(({ name, sha256 }) => ({ name, sha256 })), integrity: "passed",
}, null, 2)}\n`);
