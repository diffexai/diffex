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
