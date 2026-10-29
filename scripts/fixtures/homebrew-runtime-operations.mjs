// Executed by the retained bundled Node from an external fixture directory.
// Native desktop bindings are loaded/shape-checked only; no clipboard/keyring reads or writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager } from "@diffexai/diffex";
import { Text } from "@diffexai/diffex-tui";

// This script is copied to <isolated root>/external-fixture, beside the private
// cellar and fresh user state. Arguments/environment may confirm that contract,
// but must never select arbitrary SDK credential, session or executable paths.
const fixtureDirectory = realpathSync(dirname(fileURLToPath(import.meta.url)));
assert.equal(fixtureDirectory, dirname(fileURLToPath(import.meta.url)), "Fixture directory must be physical");
const root = dirname(fixtureDirectory);
const payload = join(root, "cellar/libexec/diffex");
assert.equal(process.argv.length, 3, "Expected only the retained payload argument");
assert.equal(resolve(process.argv[2]), payload, "Payload argument must name the isolated cellar");
const agentDir = join(root, "agent");
const project = join(root, "project");
assert.equal(process.env.DIFFEX_CODING_AGENT_DIR, agentDir, "Agent directory must be isolated");
assert.equal(realpathSync(process.cwd()), project, "Working directory must be the isolated project");
assert.equal(process.env.DIFFEX_OFFLINE, "1");
assert.equal(process.env.DIFFEX_NO_LOCAL_LLM, "1");
for (const directory of [payload, agentDir, project]) {
	assert(directory.startsWith(root + sep), "Fixture directory escapes its root");
	assert.equal(realpathSync(directory), directory, "Fixture directories must not traverse links");
	assert(statSync(directory).isDirectory());
}
// Earlier CLI listing checks may already have created isolated cache state.
// An exclusive private directory gives these SDK operations fresh state without
// reading any previous credentials/models or accepting a pre-existing link.
const stateDirectory = join(agentDir, "runtime-fixture");
mkdirSync(stateDirectory, { mode: 0o700 });
const packageRoot = join(payload, "app/node_modules/@diffexai/diffex");
assert.equal(realpathSync(packageRoot), packageRoot, "CLI package must remain inside the payload");
const cliRequire = createRequire(join(packageRoot, "package.json"));
const fixtureRequire = createRequire(import.meta.url);
const runtime = await ModelRuntime.create({
	authPath: join(stateDirectory, "auth.json"),
	modelsPath: join(stateDirectory, "models.json"),
	refreshOnCreate: false,
});
assert(runtime);

const clipboard = cliRequire("@mariozechner/clipboard");
assert.equal(typeof clipboard.getText, "function");
assert.equal(typeof clipboard.setText, "function");
const keyring = cliRequire("@napi-rs/keyring");
assert.equal(typeof keyring.Entry, "function");
assert.equal(typeof keyring.Entry.prototype.getPassword, "function");
assert.equal(typeof keyring.Entry.prototype.setPassword, "function");
assert.equal(typeof keyring.AsyncEntry.prototype.getSecret, "function");
assert.equal(typeof keyring.findCredentialsAsync, "function");

const photon = cliRequire("@silvia-odwyer/photon-node");
const image = new photon.PhotonImage(new Uint8Array([0, 0, 0, 255]), 1, 1);
try {
	assert.equal(image.get_width(), 1);
	assert.equal(image.get_height(), 1);
} finally { image.free(); }
assert(new Text("homebrew native acceptance", 0, 0).render(40).join("\n").includes("homebrew native acceptance"));
if (process.platform === "darwin") {
	const tuiRoot = dirname(dirname(fixtureRequire.resolve("@diffexai/diffex-tui")));
	const helper = fixtureRequire(join(tuiRoot, "native/darwin/prebuilds", `darwin-${process.arch}`, "darwin-modifiers.node"));
	assert.equal(typeof helper.isModifierPressed, "function");
}

const session = SessionManager.create(project, join(stateDirectory, "export-session"));
session.appendMessage({ role: "user", content: "homebrew export", timestamp: Date.now() });
session.appendMessage({
	role: "assistant", content: [{ type: "text", text: "homebrew exported reply" }],
	api: "openai-completions", provider: "fixture", model: "fixture",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: Date.now(),
});
const html = join(project, "homebrew export.html");
execFileSync(process.execPath, [join(packageRoot, "dist/cli.js"), "--export", session.getSessionFile(), html], {
	env: process.env, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
});
const exported = readFileSync(html, "utf8");
const embedded = exported.match(/<script id="session-data"[^>]*>([^<]+)/);
assert(embedded, "Missing embedded session data");
const data = JSON.parse(Buffer.from(embedded[1], "base64").toString("utf8"));
assert(data.entries.some((entry) => entry.message?.content?.some?.((part) => part.text === "homebrew exported reply")));
assert(exported.includes("<style>"), "Missing bundled export styling");
console.log("homebrew-runtime-operations-ok");
