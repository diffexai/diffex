import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fixture from "./fixture.mjs";
import guard from "./live-guard.mjs";

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

for (const [name, extension] of [["fixture", fixture], ["live guard", guard]]) {
	test(`${name} rejects traversal, unauthorized paths, symlinks, hardlinks and nonregular recordings`, () => {
		const directory = mkdtempSync(join(tmpdir(), "behavior-record-boundary-"));
		const outside = mkdtempSync("/var/tmp/behavior-record-outside-");
		const originalEnv = { ...process.env };
		try {
			const target = join(directory, "untouched.jsonl");
			writeFileSync(target, "fixture-owned marker\n");
			const symlink = join(directory, "symlink.jsonl");
			symlinkSync(target, symlink);
			const hardlink = join(directory, "hardlink.jsonl");
			linkSync(target, hardlink);
			const nonregular = join(directory, "directory.jsonl");
			mkdirSync(nonregular);
			const fifo = join(directory, "fifo.jsonl");
			assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
			const escaped = join(directory, "escaped");
			symlinkSync(outside, escaped);
			writeFileSync(join(outside, "events.jsonl"), "fixture-owned marker\n");
			const shared = join(directory, "shared");
			mkdirSync(shared);
			chmodSync(shared, 0o777);
			const writable = join(directory, "shared.jsonl");
			writeFileSync(writable, "fixture-owned marker\n");
			chmodSync(writable, 0o666);
			for (const path of [
				`${directory}/../escape.jsonl`,
				"/not-a-behavior-record-root/events.jsonl",
				`${process.cwd()}-not-the-workspace/events.jsonl`,
				`${directory}/nul\0.jsonl`,
				symlink, hardlink, nonregular, fifo, writable, join(shared, "events.jsonl"), join(escaped, "events.jsonl"),
			]) {
				process.env.DIFFEX_BEHAVIOR_RECORD = path;
				// Neither TMPDIR nor isolated config vars may grant arbitrary filesystem access.
				process.env.TMPDIR = "/not-a-behavior-record-root";
				process.env.DIFFEX_CODING_AGENT_DIR = "/not-a-behavior-record-root/agent";
				assert.throws(() => extension({ on() { assert.fail("Unsafe recording accepted"); } }), /recording (path|destination|directory|must|changed)|ELOOP|EISDIR/);
			}
			delete process.env.DIFFEX_BEHAVIOR_RECORD;
			assert.throws(() => extension({}), /DIFFEX_BEHAVIOR_RECORD is required/);
			assert.equal(readFileSync(target, "utf8"), "fixture-owned marker\n");
			assert.equal(readFileSync(join(outside, "events.jsonl"), "utf8"), "fixture-owned marker\n");
		} finally {
			process.env = originalEnv;
			rmSync(directory, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test(`${name} pins the validated file descriptor across path and environment replacement`, () => {
		const directory = mkdtempSync(join(tmpdir(), "behavior-record-fd-"));
		const originalEnv = { ...process.env };
		const originalFetch = globalThis.fetch;
		const originalConnect = Socket.prototype.connect;
		const callbacks = new Map();
		try {
			const path = join(directory, "events.jsonl");
			const pinned = join(directory, "pinned.jsonl");
			const target = join(directory, "untouched.jsonl");
			writeFileSync(target, "fixture-owned marker\n");
			process.env.DIFFEX_BEHAVIOR_RECORD = path;
			process.env.DIFFEX_BEHAVIOR_TRANSPORT = "0";
			extension({ on(name, callback) { callbacks.set(name, callback); }, registerProvider() {} });
			renameSync(path, pinned);
			symlinkSync(target, path);
			process.env.DIFFEX_BEHAVIOR_RECORD = target;
			callbacks.get("agent_settled")();
			assert.deepEqual(records(pinned), [{ type: "settled" }]);
			assert.equal(readFileSync(target, "utf8"), "fixture-owned marker\n");
		} finally {
			callbacks.get("session_shutdown")?.();
			globalThis.fetch = originalFetch;
			Socket.prototype.connect = originalConnect;
			process.env = originalEnv;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test(`${name} permits cwd-relative and isolated sandbox recordings with variable filenames`, () => {
		const directory = mkdtempSync(join(tmpdir(), "behavior-record-local-"));
		const local = mkdtempSync(join(process.cwd(), ".behavior-record-local-"));
		const originalEnv = { ...process.env };
		const originalCwd = process.cwd();
		const originalFetch = globalThis.fetch;
		const originalConnect = Socket.prototype.connect;
		try {
			for (const name of ["project", "agent", "home", "temp"]) mkdirSync(join(directory, name));
			process.env.HOME = join(directory, "home");
			process.env.TMPDIR = join(directory, "temp");
			process.env.DIFFEX_CODING_AGENT_DIR = join(directory, "agent");
			process.env.DIFFEX_BEHAVIOR_TRANSPORT = "0";
			for (const [cwd, path] of [
				[originalCwd, relative(originalCwd, join(local, "local-events.jsonl"))],
				[join(directory, "project"), join(directory, "different-name.jsonl")],
			]) {
				process.chdir(cwd);
				process.env.DIFFEX_BEHAVIOR_RECORD = path;
				const callbacks = new Map();
				try {
					extension({ on(name, callback) { callbacks.set(name, callback); }, registerProvider() {} });
					callbacks.get("agent_settled")();
					assert.deepEqual(records(path), [{ type: "settled" }]);
				} finally {
					callbacks.get("session_shutdown")?.();
					rmSync(resolve(path), { force: true });
					globalThis.fetch = originalFetch;
					Socket.prototype.connect = originalConnect;
				}
			}
		} finally {
			process.chdir(originalCwd);
			process.env = originalEnv;
			rmSync(directory, { recursive: true, force: true });
			rmSync(local, { recursive: true, force: true });
		}
	});
}
