// Executed by the retained bundled Node from an external fixture directory.
// Native desktop bindings are loaded/shape-checked only; no clipboard/keyring reads or writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ModelRuntime, SessionManager } from "@diffexai/diffex";
import { Text } from "@diffexai/diffex-tui";

const payload = resolve(process.argv[2]);
const packageRoot = join(payload, "app/node_modules/@diffexai/diffex");
const cliRequire = createRequire(join(packageRoot, "package.json"));
const fixtureRequire = createRequire(import.meta.url);
const runtime = await ModelRuntime.create({
	authPath: join(process.env.DIFFEX_CODING_AGENT_DIR, "auth.json"),
	modelsPath: join(process.env.DIFFEX_CODING_AGENT_DIR, "models.json"),
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

const session = SessionManager.create(process.cwd(), join(process.env.DIFFEX_CODING_AGENT_DIR, "export-session"));
session.appendMessage({ role: "user", content: "homebrew export", timestamp: Date.now() });
session.appendMessage({
	role: "assistant", content: [{ type: "text", text: "homebrew exported reply" }],
	api: "openai-completions", provider: "fixture", model: "fixture",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop", timestamp: Date.now(),
});
const html = join(process.cwd(), "homebrew export.html");
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
