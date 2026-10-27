import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fixture from "./fixture.mjs";

const cli = fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("./fixture.mjs", import.meta.url));

function records(path) {
	return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function runCli(directory, record, args, env = {}) {
	const result = spawnSync(process.execPath, [cli, "--no-extensions", "-e", extension, ...args], {
		cwd: directory,
		env: {
			...process.env,
			DIFFEX_CODING_AGENT_DIR: join(directory, "config"),
			DIFFEX_BEHAVIOR_RECORD: record,
			DIFFEX_BEHAVIOR_TRANSPORT: "0",
			...env,
		},
		encoding: "utf8",
		timeout: 30000,
	});
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

test("installed extension drives real print, built-in tools and persisted resume", () => {
	const directory = mkdtempSync(join(tmpdir(), "behavior-fixture-"));
	try {
		const record = join(directory, "record.jsonl");
		const session = join(directory, "session.jsonl");
		writeFileSync(join(directory, "input.txt"), "behavior-input\n");
		assert.match(runCli(directory, record, ["--model", "behavior/fixture", "--no-session", "-p", "BEHAVIOR_PRINT"]), /behavior-print-ok/);
		assert.match(runCli(directory, record, ["--model", "behavior/fixture", "--session", session, "-p", "BEHAVIOR_TOOLS"]), /behavior-tools-ok/);
		assert.equal(readFileSync(join(directory, "output.txt"), "utf8"), "behavior-edited\n");
		assert.equal(readFileSync(join(directory, "bash-result.txt"), "utf8"), "behavior-edited\n");
		assert.match(runCli(directory, record, ["--model", "behavior/fixture", "--session", session, "-p", "BEHAVIOR_RESUME"]), /behavior-resumed-ok/);
		const events = records(record);
		assert.equal(events.filter((event) => event.type === "settled").length, 3);
		assert.deepEqual(events.filter((event) => event.type === "tool_result").map((event) => event.toolName), ["read", "write", "edit", "bash"]);
		assert.equal(events.filter((event) => event.type === "resume-verified").length, 1);
		assert.equal(events.some((event) => event.type === "blocked-network"), false);
		const resumed = events.find((event) => event.type === "context" && event.mode === "BEHAVIOR_RESUME");
		assert.equal(resumed.messages.filter((message) => message.role === "toolResult").length, 4);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("built-in OpenAI provider resolves fake environment credentials and consumes Responses SSE", () => {
	const directory = mkdtempSync(join(tmpdir(), "behavior-auth-"));
	try {
		const record = join(directory, "record.jsonl");
		assert.match(runCli(directory, record, ["--model", "openai/gpt-4.1-mini", "--no-session", "-p", "BEHAVIOR_AUTH"], {
			DIFFEX_BEHAVIOR_TRANSPORT: "1", OPENAI_API_KEY: "fake",
		}), /behavior-auth-ok/);
		const events = records(record);
		assert(events.some((event) => event.type === "auth-request" && event.credentialVerified));
		assert.equal(events.filter((event) => event.type === "settled").length, 1);
		assert.equal(events.some((event) => event.type === "blocked-network"), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cancellation stays pending until AbortSignal, then recovery and missing-resume checks work", async () => {
	const directory = mkdtempSync(join(tmpdir(), "behavior-cancel-"));
	const originalFetch = globalThis.fetch;
	const originalConnect = Socket.prototype.connect;
	const originalEnv = { ...process.env };
	try {
		const record = join(directory, "record.jsonl");
		process.env.DIFFEX_BEHAVIOR_RECORD = record;
		process.env.DIFFEX_BEHAVIOR_TRANSPORT = "0";
		let provider;
		fixture({ on() {}, registerProvider(_name, config) { provider = config; } });
		const model = { api: "behavior", provider: "behavior", id: "fixture" };
		const controller = new AbortController();
		const stream = provider.streamSimple(model, { messages: [{ role: "user", content: "BEHAVIOR_CANCEL", timestamp: 1 }] }, { signal: controller.signal });
		let settled = false;
		stream.result().then(() => { settled = true; });
		for await (const event of stream) {
			if (event.type === "text_delta") {
				assert.equal(event.delta, "behavior-cancel-started");
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(settled, false);
				assert.equal(records(record).some((entry) => entry.type === "abort"), false);
				controller.abort();
			}
		}
		assert.equal((await stream.result()).stopReason, "aborted");
		assert(records(record).some((entry) => entry.type === "abort" && entry.aborted));
		const recovered = await provider.streamSimple(model, { messages: [{ role: "user", content: "BEHAVIOR_RECOVER", timestamp: 2 }] }).result();
		assert.equal(recovered.content[0].text, "behavior-recovered-ok");
		const invalidResume = await provider.streamSimple(model, { messages: [{ role: "user", content: "BEHAVIOR_RESUME", timestamp: 3 }] }).result();
		assert.equal(invalidResume.stopReason, "error");
		assert.match(invalidResume.errorMessage, /missing the earlier/);
		await assert.rejects(fetch("https://example.com/"), /Network disabled/);
		assert.throws(() => new Socket().connect(443, "example.com"), /Network disabled/);
		assert.equal((await fetch("https://api.diffex.ai/api/latest-version")).status, 404);
	} finally {
		globalThis.fetch = originalFetch;
		Socket.prototype.connect = originalConnect;
		process.env = originalEnv;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("transport rejects unexpected hosts, credentials and custom headers without registering providers", async () => {
	const directory = mkdtempSync(join(tmpdir(), "behavior-network-"));
	const originalFetch = globalThis.fetch;
	const originalConnect = Socket.prototype.connect;
	const originalEnv = { ...process.env };
	try {
		process.env.DIFFEX_BEHAVIOR_RECORD = join(directory, "record.jsonl");
		process.env.DIFFEX_BEHAVIOR_TRANSPORT = "1";
		process.env.OPENAI_API_KEY = "fake";
		fixture({ on() {}, registerProvider() { assert.fail("Transport fixture must not register a provider"); } });
		const request = {
			method: "POST",
			headers: { authorization: "Bearer fake", "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-4.1-mini", stream: true, input: [] }),
		};
		await assert.rejects(fetch("https://unexpected.example/v1/responses", request), /Network disabled/);
		await assert.rejects(fetch("https://api.openai.com/v1/responses", { ...request, headers: { ...request.headers, authorization: "Bearer real-secret" } }), /Network disabled/);
		await assert.rejects(fetch("https://api.openai.com/v1/responses", { ...request, headers: { ...request.headers, "x-api-key": "unexpected" } }), /Network disabled/);
		assert.equal(records(process.env.DIFFEX_BEHAVIOR_RECORD).filter((event) => event.type === "blocked-network").length, 3);
		assert.equal(readFileSync(process.env.DIFFEX_BEHAVIOR_RECORD, "utf8").includes("real-secret"), false);
	} finally {
		globalThis.fetch = originalFetch;
		Socket.prototype.connect = originalConnect;
		process.env = originalEnv;
		rmSync(directory, { recursive: true, force: true });
	}
});
