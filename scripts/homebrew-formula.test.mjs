import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { homebrewFixture } from "./fixtures/homebrew.mjs";
import { generateHomebrewFormula, HOMEBREW_PLATFORMS, homebrewAssetUrl, validateHomebrewManifest } from "./homebrew-formula.mjs";

test("strict manifest accepts exactly the approved four-target contract", () => {
	const { manifest } = homebrewFixture();
	assert.equal(validateHomebrewManifest(manifest), manifest);
	assert.deepEqual(manifest.platforms.map((entry) => entry.platform), HOMEBREW_PLATFORMS);
	for (const mutate of [
		(value) => { value.schemaVersion = 2; },
		(value) => { value.product = "@foreign/package"; },
		(value) => { value.version = "1.2.3-beta.1"; },
		(value) => { value.version = "01.2.3"; },
		(value) => { value.version = "1.2.3\n"; },
		(value) => { value.sourceCommit = "main"; },
		(value) => { value.nodeVersion = ">=22.19.0"; },
		(value) => { value.npmVersion = "v10.8.2"; },
		(value) => { value.platforms.pop(); },
		(value) => { value.platforms[1] = value.platforms[0]; },
		(value) => { value.platforms[0].platform = "linux-arm64-musl"; },
		(value) => { value.platforms[0].filename = "../diffex.tar.gz"; },
		(value) => { value.platforms[0].filename = "https://evil.invalid/payload"; },
		(value) => { value.platforms[0].sha256 = "A".repeat(64); },
		(value) => { value.platforms[0].inventorySha256 = "invalid"; },
		(value) => { value.platforms[0].size = 0; },
		(value) => { value.platforms[0].size = 0.5; },
		(value) => { value.platforms[0].size = 512 * 1024 * 1024 + 1; },
		(value) => { value.platforms[0].osBaseline = "macos-14"; },
		(value) => { value.platforms[2].osBaseline = "alpine-3"; },
		(value) => { value.platforms[0].url = "https://evil.invalid"; },
		(value) => { value.extra = true; },
	]) {
		const candidate = structuredClone(manifest);
		mutate(candidate);
		assert.throws(() => validateHomebrewManifest(candidate));
		assert.throws(() => generateHomebrewFormula(candidate));
	}
});

test("canonical formula pins fixed assets and preserves the whole bundled runtime outside its ownership marker", () => {
	const { manifest } = homebrewFixture();
	const formula = generateHomebrewFormula(manifest);
	assert.equal(generateHomebrewFormula({ ...manifest, platforms: manifest.platforms.toReversed() }), formula);
	for (const entry of manifest.platforms) {
		assert(formula.includes(`url "${homebrewAssetUrl(manifest, entry.platform)}"`));
		assert(formula.includes(`sha256 "${entry.sha256}"`));
	}
	assert.equal((formula.match(/\burl "/g) ?? []).length, 4);
	assert.match(formula, /libexec\.install buildpath => "diffex"/);
	assert.match(formula, /\(libexec\/"\.diffex-homebrew\.json"\)\.write/);
	assert.match(formula, /bin\.install_symlink libexec\/"diffex\/bin\/diffex"/);
	assert.match(formula, /formula: "diffexai\/tap\/diffex"/);
	for (const dependency of ["fd", "ripgrep", "git"]) assert(formula.includes(`depends_on "${dependency}"`));
	assert.doesNotMatch(formula, /depends_on "node|npm install|curl|install\.sh|@@/);
	assert.equal((formula.match(/depends_on macos: :sequoia/g) ?? []).length, 1);
	assert(formula.slice(formula.indexOf("  on_macos do"), formula.indexOf("  on_linux do")).includes("depends_on macos: :sequoia"), "macOS requirement must not exclude Linux installations");
	assert.match(formula, /not musl/);
	assert.match(formula, /glibc 2\.39/);
	for (const command of ["--version", "--help", "--list-models", "update --self"]) assert(formula.includes(command));
	assert.match(formula, /brew upgrade diffexai\/tap\/diffex/);
	assert.match(formula, /assert_equal before, snapshot\.call/);
	assert(formula.indexOf("before = snapshot.call") > formula.indexOf("shell_output(\"#{bin}/diffex --list-models\")"));
	assert(formula.indexOf("before = snapshot.call") < formula.indexOf("shell_output(\"#{bin}/diffex update --self\")"));
	const ruby = spawnSync("ruby", ["-c"], { input: formula, encoding: "utf8" });
	if (!ruby.error) assert.equal(ruby.status, 0, ruby.stderr);
});

test("tap CI template exercises four native targets without executing PR-controlled workflows with credentials", () => {
	const ci = readFileSync(new URL("../homebrew/tap/.github/workflows/test.yml", import.meta.url), "utf8");
	for (const runner of ["macos-15", "macos-15-intel", "ubuntu-24.04", "ubuntu-24.04-arm"]) assert(ci.includes(runner));
	assert.match(ci, /brew style/);
	assert.match(ci, /brew audit/);
	assert.match(ci, /brew install/);
	assert.match(ci, /brew test/);
	assert.match(ci, /brew uninstall/);
	assert.match(ci, /lifecycle\.rb/);
	assert.doesNotMatch(ci, /pull_request_target|secrets\.|write-all|contents: write/);
});
