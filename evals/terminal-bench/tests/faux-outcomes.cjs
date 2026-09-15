// Outcome smoke fixture. All model responses stay on container loopback.
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, basename } = require("node:path");

const action = process.argv[2];
if (action === "prepare") {
	const state = process.env.DIFFEX_CODING_AGENT_DIR;
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	const scenario = readFileSync("/tmp/outcome-scenario", "utf8").trim();
	writeFileSync(join(state, "settings.json"), JSON.stringify({ evolution: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
	writeFileSync(join(state, "models.json"), JSON.stringify({ providers: { openai: {
		baseUrl: `http://127.0.0.1:8766/${scenario}/${basename(runDir)}/v1`, api: "openai-completions", models: [{
			id: "gpt-5", name: "Controlled outcome model", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
		}],
	} } }));
	process.exit(0);
}
if (action === "interrupt-output") {
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	if (readFileSync("/tmp/outcome-scenario", "utf8").trim() === "interrupted-output") {
		const path = join(runDir, "stdout.jsonl");
		// Model a dropped final frame while preserving process success.
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		writeFileSync(path, lines.filter((line) => JSON.parse(line).type !== "agent_end").join("\n") + '\n{"type":');
	}
	process.exit(0);
}
if (action === "linger") {
	// A detached tool descendant deliberately ignores TERM.
	process.on("SIGTERM", () => {});
	writeFileSync(join(process.env.DIFFEX_TB_RUN_DIR, "lingering-pid"), String(process.pid));
	setInterval(() => {}, 1000);
} else if (action === "spawn-linger") {
	const child = spawn(process.execPath, [__filename, "linger"], { detached: true, stdio: "ignore" });
	child.unref();
} else {
	const counts = new Map();
	createServer(async (request, response) => {
		if (request.url === "/health") { response.end("ok"); return; }
		let text = "";
		for await (const chunk of request) text += chunk;
		const body = JSON.parse(text);
		const scenario = request.url.split("/")[1];
		const count = (counts.get(request.url) ?? 0) + 1;
		counts.set(request.url, count);
		if (scenario === "authentication" || scenario === "exhausted" || (scenario === "recovered" && count === 1)) {
			response.writeHead(scenario === "authentication" ? 401 : 503, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: scenario === "authentication" ? "Controlled invalid API key" : "Controlled service overloaded" } }));
			return;
		}
		if (scenario === "timeout" && count > 1) return;
		const tool = count === 1 && ["timeout", "success"].includes(scenario)
			? { name: "bash", arguments: JSON.stringify({ command: "/opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs spawn-linger; printf retained-diagnostic >&2; printf tool-ok" }) }
			: null;
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
			id: `fixture-${count}`, object: "chat.completion.chunk", model: body.model,
			choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`);
		send({ role: "assistant" });
		if (tool) send({ tool_calls: [{ index: 0, id: `call-${count}`, type: "function", function: tool }] });
		else send({ content: "controlled-ok" });
		send({}, tool ? "tool_calls" : "stop");
		response.end("data: [DONE]\n\n");
	}).listen(8766, "127.0.0.1");
}
