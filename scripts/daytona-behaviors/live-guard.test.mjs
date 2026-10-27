import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import guard from "./live-guard.mjs";

test("live transport shares six-request budget across CLI and TUI and caps output", async () => {
	const root = mkdtempSync(join(tmpdir(), "behavior-live-guard-"));
	const original = globalThis.fetch;
	const oldRecord = process.env.DIFFEX_BEHAVIOR_RECORD;
	const oldStarted = process.env.DIFFEX_BEHAVIOR_STARTED;
	const record = join(root, "events.jsonl");
	let sent = 0;
	try {
		process.env.DIFFEX_BEHAVIOR_RECORD = record;
		process.env.DIFFEX_BEHAVIOR_STARTED = String(Date.now());
		writeFileSync(record, Array.from({ length: 5 }, () => `${JSON.stringify({ type: "request" })}\n`).join(""));
		globalThis.fetch = async (request) => {
			sent++;
			assert.equal(JSON.parse(await request.text()).max_output_tokens, 512);
			return new Response("ok");
		};
		guard({ on() {} });
		const call = () => globalThis.fetch("https://api.openai.com/v1/responses", {
			method: "POST", body: JSON.stringify({ max_output_tokens: 9000 }),
		});
		await call();
		await assert.rejects(call, /budget exceeded/);
		assert.equal(sent, 1);
		assert.equal(readFileSync(record, "utf8").split("\n").filter(Boolean).map(JSON.parse).find((event) => event.type === "response").status, 200);
		assert.equal(readFileSync(record, "utf8").split("\n").filter((line) => line && JSON.parse(line).type === "request").length, 6);
		await assert.rejects(() => globalThis.fetch("https://unexpected.invalid"), /destination/);
	} finally {
		globalThis.fetch = original;
		if (oldRecord === undefined) delete process.env.DIFFEX_BEHAVIOR_RECORD;
		else process.env.DIFFEX_BEHAVIOR_RECORD = oldRecord;
		if (oldStarted === undefined) delete process.env.DIFFEX_BEHAVIOR_STARTED;
		else process.env.DIFFEX_BEHAVIOR_STARTED = oldStarted;
		rmSync(root, { recursive: true, force: true });
	}
});

test("live guard records exact HTTP diagnostics and preserves usage, tools and streamed evidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "behavior-live-status-"));
	const original = globalThis.fetch;
	const originalEnv = { ...process.env };
	const callbacks = new Map();
	try {
		const record = join(root, "events.jsonl");
		process.env.DIFFEX_BEHAVIOR_RECORD = record;
		process.env.DIFFEX_BEHAVIOR_STARTED = String(Date.now());
		process.env.OPENAI_API_KEY = "fixture-only-secret";
		const statuses = [200, 401, 429, 500, 503, 599];
		const responses = statuses.map((status) => new Response("fixture-only response", { status }));
		let sent = 0;
		globalThis.fetch = async () => responses[sent++];
		guard({ on(name, callback) { callbacks.set(name, callback); } });
		for (const response of responses) {
			assert.equal(await globalThis.fetch("https://api.openai.com/v1/responses", {
				method: "POST", body: "{}",
			}), response);
		}
		const tool = { toolName: "read", content: [{ type: "text", text: "fixture-only-secret" }], isError: false };
		callbacks.get("tool_result")(tool);
		callbacks.get("message_update")({ assistantMessageEvent: { type: "text_delta", delta: "fixture-only-secret streamed" } });
		const usage = { input: 17, output: 23, totalTokens: 40, cost: { total: 0.001 } };
		callbacks.get("agent_end")({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], usage }] });
		callbacks.get("agent_settled")();
		const text = readFileSync(record, "utf8");
		const events = text.trim().split("\n").map(JSON.parse);
		assert.deepEqual(events.filter((event) => event.type === "response").map((event) => event.status), statuses);
		assert.deepEqual(events.find((event) => event.type === "tool_result"), { type: "tool_result", ...tool, content: [{ type: "text", text: "[REDACTED]" }] });
		assert.deepEqual(events.find((event) => event.type === "streamed-text"), { type: "streamed-text", delta: "[REDACTED] streamed" });
		assert.deepEqual(events.find((event) => event.type === "agent_end").messages[0].usage, usage);
		assert.equal(events.at(-1).type, "settled");
		assert.equal(text.includes("fixture-only-secret"), false);
	} finally {
		callbacks.get("session_shutdown")?.();
		globalThis.fetch = original;
		process.env = originalEnv;
		rmSync(root, { recursive: true, force: true });
	}
});

test("live guard rejects nonnumeric, injected and out-of-range response statuses without logging payloads", async () => {
	const root = mkdtempSync(join(tmpdir(), "behavior-live-status-injection-"));
	const original = globalThis.fetch;
	const originalEnv = { ...process.env };
	const invalid = ["401\n{\"type\":\"forged\"}", "429", NaN, Infinity, 200.5, 600];
	try {
		for (const [index, status] of invalid.entries()) {
			const record = join(root, `events-${index}.jsonl`);
			process.env.DIFFEX_BEHAVIOR_RECORD = record;
			process.env.DIFFEX_BEHAVIOR_STARTED = String(Date.now());
			globalThis.fetch = async () => ({ status });
			const callbacks = new Map();
			try {
				guard({ on(name, callback) { callbacks.set(name, callback); } });
				await assert.rejects(() => globalThis.fetch("https://api.openai.com/v1/responses", {
					method: "POST", body: "{}",
				}), /Invalid live HTTP response status/);
				const events = readFileSync(record, "utf8").trim().split("\n").map(JSON.parse);
				assert.deepEqual(events.map((event) => event.type), ["request", "provider-error"]);
				assert.equal(events[1].error, "Error");
			} finally {
				callbacks.get("session_shutdown")?.();
			}
		}
	} finally {
		globalThis.fetch = original;
		process.env = originalEnv;
		rmSync(root, { recursive: true, force: true });
	}
});
