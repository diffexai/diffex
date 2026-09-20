const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const env = process.env;
const logs = env.SETUP_LOGS;
const prefix = "/opt/diffex-terminal-bench/cli";
const metadata = JSON.parse(readFileSync(join(logs, "npm-metadata.json"), "utf8"));
const tarball = `${env.NPM_REGISTRY}@diffexai/diffex/-/diffex-${env.DIFFEX_VERSION}.tgz`;
assert.equal(metadata.version, env.DIFFEX_VERSION, "Registry version mismatch");
assert.equal(metadata.dist.integrity, env.DIFFEX_INTEGRITY, "Registry integrity mismatch");
assert.equal(metadata.dist.tarball, tarball, "Registry tarball mismatch");
if (process.argv[2] === "metadata") process.exit(0);

const manifest = JSON.parse(readFileSync(join(prefix, "node_modules/@diffexai/diffex/package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
const installed = lock.packages["node_modules/@diffexai/diffex"];
assert.equal(manifest.version, env.DIFFEX_VERSION, "Installed version mismatch");
assert.equal(installed.version, env.DIFFEX_VERSION, "Lock version mismatch");
assert.equal(installed.integrity, env.DIFFEX_INTEGRITY, "Installed integrity mismatch");
assert.equal(installed.resolved, tarball, "Installed registry mismatch");
if (process.argv[2] === "installed") process.exit(0);
assert.equal(process.argv[2], "complete");
assert.equal(readFileSync(join(logs, "version.stdout.txt"), "utf8").trim(), env.DIFFEX_VERSION);
const help = readFileSync(join(logs, "help.stdout.txt"), "utf8");
for (const flag of ["--background-process-lifetime", "--background-process-ownership-dir"]) {
    assert.ok(help.includes(flag), `Pinned Diffex release lacks ${flag}; publish and pin the corrected release`);
}
assert.ok(Number(env.SETUP_ELAPSED_SEC) < Number(env.SETUP_TIMEOUT_SEC), "Setup exceeded deadline");
writeFileSync(join(logs, "installation.json"), `${JSON.stringify({
    schema_version: 1,
    verified: true,
    background_process_lifetime: "environment",
    started_at: env.SETUP_STARTED_AT,
    elapsed_sec: Number(env.SETUP_ELAPSED_SEC),
    setup_timeout_sec: Number(env.SETUP_TIMEOUT_SEC),
    harbor_version: env.HARBOR_VERSION,
    node_version: process.version,
    node_arch: env.NODE_ARCH,
    node_sha256: env.NODE_SHA256,
    npm_version: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    diffex_version: manifest.version,
    npm_registry: env.NPM_REGISTRY,
    npm_integrity: installed.integrity,
    npm_tarball: installed.resolved,
    smoke_commands: ["diffex --version", "diffex --help", "diffex --list-models"],
}, null, 2)}\n`);
