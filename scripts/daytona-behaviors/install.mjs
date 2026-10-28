import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installConsumer, resolveArtifactDirectory, verifyTarballs } from "../artifact-installation.mjs";

const [artifacts, consumer, manager, commit] = process.argv.slice(2);
assert(artifacts && consumer && ["npm", "bun"].includes(manager) && /^[a-f0-9]{40}$/.test(commit),
	"Usage: node install.mjs ARTIFACTS CONSUMER npm|bun COMMIT");
const artifactDirectory = resolveArtifactDirectory(artifacts);
const consumerDirectory = resolveArtifactDirectory(consumer);
const manifest = JSON.parse(readFileSync(join(artifactDirectory, "manifest.json"), "utf8"));
assert.equal(manifest.source.commit, commit, "Retained source does not match triggering commit");
assert.equal(manifest.schemaVersion, 1);
const packages = manifest.packages;
assert.equal(packages.length, 1, "Expected the standalone CLI distribution");
assert.equal(packages[0].name, "@diffexai/diffex");
verifyTarballs(artifactDirectory, packages, packages);
const lifecycleScripts = manager === "npm" ? "enabled" : "disabled";
installConsumer(consumerDirectory, manager, packages, packages, artifactDirectory,
	join(consumerDirectory, "cache"), { lifecycleScripts });
const executable = join(consumerDirectory, "node_modules/.bin/diffex");
assert(realpathSync(executable).startsWith(`${consumerDirectory}/node_modules/`));
writeFileSync(join(consumerDirectory, "installation.json"), `${JSON.stringify({
	manager, lifecycleScripts, executable, resolved: realpathSync(executable), commit,
	artifacts: packages.map(({ name, sha256 }) => ({ name, sha256 })), integrity: "passed",
}, null, 2)}\n`);
