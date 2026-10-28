import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { bundleCliProviders } from "./bundle-cli-providers.mjs";
import { cliDistribution } from "./cli-distribution.mjs";

const prefix = "dist/node_modules/@diffexai/diffex-ai";
const entry = `${prefix}/dist/api/mistral-conversations.js`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "diffex-provider-bundle-"));
	const root = join(directory, "source");
	const stage = join(directory, "stage");
	const copy = (file) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		cpSync(file, join(root, file), { recursive: true });
	};
	for (const file of ["package-lock.json", "docs/release/distribution-policy.json", "packages/coding-agent/package.json", "packages/evolution/package.json", "packages/harness-trace/package.json", ...cliDistribution().bundled.map((pkg) => `${pkg.directory}/package.json`)]) copy(file);
	copy("packages/ai/dist");
	symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
	mkdirSync(join(root, "packages/ai/node_modules/@mistralai"), { recursive: true });
	for (const name of readdirSync("packages/ai/node_modules")) {
		if (name === "@mistralai") continue;
		symlinkSync(resolve("packages/ai/node_modules", name), join(root, "packages/ai/node_modules", name), "dir");
	}
	symlinkSync(resolve("packages/ai/node_modules/@mistralai/mistralai"), join(root, "packages/ai/node_modules/@mistralai/mistralai"), "dir");
	mkdirSync(join(stage, prefix), { recursive: true });
	cpSync(join(root, "packages/ai/dist"), join(stage, prefix, "dist"), { recursive: true });
	writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "module" }));
	mkdirSync(join(stage, "node_modules/@opentelemetry"), { recursive: true });
	for (const name of ["partial-json", "typebox", "@opentelemetry/api"])
		symlinkSync(resolve("node_modules", name), join(stage, "node_modules", name), "dir");
	return { directory, root, stage };
}

test("bundles real Mistral SDK with deterministic legal/input inventory and mock-fetch streaming", async () => {
	const { directory, root, stage } = fixture();
	try {
		const declaration = readFileSync(join(stage, prefix, "dist/api/mistral-conversations.d.ts"));
		const untouched = readFileSync(join(stage, prefix, "dist/api/mistral-conversations.lazy.js"));
		const [result] = await bundleCliProviders(root, stage);
		const bytes = readFileSync(join(stage, entry));
		assert.deepEqual(result.components.map((component) => component.name), ["@mistralai/mistralai", "@opentelemetry/semantic-conventions", "zod", "zod-to-json-schema"]);
		assert.match(result.notices, /Copyright 2024 Mistral AI/);
		assert.match(result.notices, /Copyright \(c\) 2025 Colin McDonnell/);
		assert.match(result.notices, /Copyright \(c\) 2020, Stefan Terdell/);
		assert.match(result.notices, /Apache License/);
		for (const component of result.components) {
			assert.match(component.integrity, /^sha512-/);
			assert(component.legalDocuments.length > 0);
			assert(component.inputs.length > 0);
			for (const input of component.inputs) assert.match(input.sha256, /^[a-f0-9]{64}$/);
		}
		assert.deepEqual(readFileSync(join(stage, prefix, "dist/api/mistral-conversations.d.ts")), declaration);
		assert.deepEqual(readFileSync(join(stage, prefix, "dist/api/mistral-conversations.lazy.js")), untouched);
		assert(!/sourceMappingURL|sourcesContent|sourceMappingURL=data:/.test(bytes.toString()));
		assert(!bytes.includes(Buffer.from(root)), bytes.toString().split("\n").filter((line) => line.includes(root)).join("\n"));
		assert(!bytes.includes(Buffer.from(stage)));
		assert(!existsSync(join(stage, entry + ".map")));
		assert(!existsSync(join(stage, "node_modules/@mistralai")));
		// Re-stage the unchanged input to prove byte-for-byte reproducibility.
		cpSync(join(root, "packages/ai/dist/api/mistral-conversations.js"), join(stage, entry));
		assert.deepEqual(await bundleCliProviders(root, stage), [result]);
		assert.equal(hash(readFileSync(join(stage, entry))), hash(bytes));
		const script = join(stage, "provider-probe.mjs");
		writeFileSync(script, `import assert from "node:assert/strict";
import * as provider from ${JSON.stringify(pathToFileURL(join(stage, entry)).href)};
assert.deepEqual(Object.keys(provider), ["stream", "streamSimple"]);
const model = { id: "mistral-small-latest", name: "Mistral", api: "mistral-conversations", provider: "mistral", baseUrl: "https://fixture.invalid", reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 1024, cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0} };
const context = { messages: [{role: "user", content: "Hello", timestamp: 1}], tools: [{name: "lookup", description: "Lookup", parameters: {type: "object", properties: {q: {type: "string"}}, required: ["q"]}}] };
const requests = [];
const fetch = async (request) => {
 requests.push({url: request.url, headers: Object.fromEntries(request.headers), body: await request.json()});
 const chunks = [
 {id: "fixture-response", model: model.id, choices: [{index: 0, delta: {content: "hello "}, finish_reason: null}]},
 {id: "fixture-response", model: model.id, choices: [{index: 0, delta: {content: "world"}, finish_reason: "stop"}], usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5}}
 ];
 return new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\\n\\n").join("") + "data: [DONE]\\n\\n", {headers: {"content-type": "text/event-stream"}});
};
const stream = provider.streamSimple(model, context, {apiKey: "fixture-key", fetch, reasoning: "high", sessionId: "fixture-session", headers: {"x-test": "preserved"}});
const events = [];
for await (const event of stream) events.push(event.type);
const response = await stream.result();
assert.equal(response.stopReason, "stop", response.errorMessage);
assert.equal(response.responseId, "fixture-response");
assert.equal(response.content[0].text, "hello world");
assert.equal(response.usage.totalTokens, 5);
assert(events.includes("text_delta"));
assert.equal(requests.length, 1);
assert.equal(requests[0].url, "https://fixture.invalid/v1/chat/completions");
assert.equal(requests[0].headers.authorization, "Bearer fixture-key");
assert.equal(requests[0].headers["x-test"], "preserved");
assert.equal(requests[0].headers["x-affinity"], "fixture-session");
assert.equal(requests[0].body.reasoning_effort, "high");
assert.equal(requests[0].body.tools[0].function.name, "lookup");
const failure = await provider.stream(model, context, {apiKey: "fixture-key", fetch: async () => new Response("fixture denied", {status: 403})}).result();
assert.equal(failure.stopReason, "error");
assert.match(failure.errorMessage, /403.*fixture denied/);
const abort = new AbortController(); abort.abort();
const cancelled = await provider.stream(model, context, {apiKey: "fixture-key", signal: abort.signal, fetch: async () => {throw new Error("must not fetch");}}).result();
assert.equal(cancelled.stopReason, "aborted");
console.log("mock-fetch Mistral provider passed");
`);
		assert.match(execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000, env: { SystemRoot: process.env.SystemRoot, MISTRAL_SDK_TELEMETRY: "false" } }), /mock-fetch Mistral provider passed/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects new runtime/declaration references before dropping the registry dependency", async () => {
	for (const extension of ["js", "d.ts"]) {
		const { directory, root, stage } = fixture();
		try {
			writeFileSync(join(stage, prefix, `dist/new-reference.${extension}`), 'export { Chat } from "@mistralai/mistralai/sdk/chat.js";');
			await assert.rejects(bundleCliProviders(root, stage), /Unbundled provider dependency reference/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});

test("rejects missing licenses and unexpected npm metadata without writing a bundle", async () => {
	for (const invalid of ["license", "version", "input"]) {
		const { directory, root, stage } = fixture();
		try {
			const sdk = join(root, "packages/ai/node_modules/@mistralai/mistralai");
			rmSync(sdk);
			mkdirSync(sdk);
			cpSync("packages/ai/node_modules/@mistralai/mistralai/esm", join(sdk, "esm"), { recursive: true });
			const metadata = JSON.parse(readFileSync("packages/ai/node_modules/@mistralai/mistralai/package.json", "utf8"));
			if (invalid === "version") metadata.version = "0.0.0";
			writeFileSync(join(sdk, "package.json"), JSON.stringify(metadata));
			if (invalid !== "license") cpSync("packages/ai/node_modules/@mistralai/mistralai/LICENSE", join(sdk, "LICENSE"));
			if (invalid === "input") writeFileSync(join(sdk, "esm/sdk/chat.js"), 'import "missing-provider-dependency"; export class Chat {}');
			const before = readFileSync(join(stage, entry));
			await assert.rejects(bundleCliProviders(root, stage), /Missing provider license text|Unreviewed provider bundle input|Missing external provider dependency/);
			assert.deepEqual(readFileSync(join(stage, entry)), before);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
});
