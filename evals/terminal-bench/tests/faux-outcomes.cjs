// Outcome smoke fixture. All model responses stay on container loopback.
const { createServer } = require("node:http");
const { createServer: tcpServer, connect } = require("node:net");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, basename } = require("node:path");

const { identity } = require("./faux-cleanup.cjs");

const action = process.argv[2];
if (action === "health") {
	(async () => {
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				if ((await fetch("http://127.0.0.1:8766/health", { signal: AbortSignal.timeout(1000) })).ok) return;
			} catch {}
			await delay(100);
		}
		process.exitCode = 1;
	})();
} else if (action === "verify-service") {
	(async () => {
		const runDir = process.argv[3];
		const service = JSON.parse(readFileSync(join(runDir, "service.json"), "utf8"));
		assert.equal(identity(service.pid), service.start);
		for (const name of ["launcher", "cli"]) {
			const control = JSON.parse(readFileSync(join(runDir, `${name}.json`), "utf8"));
			assert.notEqual(identity(control.pid), control.start);
		}
		const socket = connect(service.port, "127.0.0.1");
		if (service.protocol === "grpc") await once(socket, "connect");
		else assert.equal(String((await once(socket, "data"))[0]), String(service.pid));
		socket.destroy();
		const provider = await (await fetch(`http://127.0.0.1:8766/state/${basename(runDir)}`)).json();
		assert.equal(provider.active, 0, "provider activity must stop before verification");
		console.log(JSON.stringify({ ...service, provider, verified: true }));
	})().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (action === "prepare") {
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
} else if (action === "interrupt-output") {
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	if (readFileSync("/tmp/outcome-scenario", "utf8").trim() === "interrupted-output") {
		const path = join(runDir, "stdout.jsonl");
		// Model a dropped final frame while preserving process success.
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		writeFileSync(path, lines.filter((line) => JSON.parse(line).type !== "agent_end").join("\n") + '\n{"type":');
	}
	process.exit(0);
} else if (action === "linger") {
	// Successful shell completion transfers this TERM-resistant service.
	process.on("SIGTERM", () => {});
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	const server = tcpServer((socket) => socket.end(String(process.pid)));
	server.listen(0, "127.0.0.1", () => writeFileSync(join(runDir, "service.json"), JSON.stringify({
		pid: process.pid, start: identity(process.pid), port: server.address().port,
	})));
} else {
	const counts = new Map();
	const states = new Map();
	createServer(async (request, response) => {
		if (request.url === "/health") { response.end("ok"); return; }
		if (request.url.startsWith("/state/")) {
			response.end(JSON.stringify(states.get(request.url.split("/")[2])));
			return;
		}
		let text = "";
		for await (const chunk of request) text += chunk;
		const body = JSON.parse(text);
		const scenario = request.url.split("/")[1];
		const count = (counts.get(request.url) ?? 0) + 1;
		counts.set(request.url, count);
		const run = request.url.split("/")[2];
		const state = states.get(run) ?? { requests: 0, active: 0 };
		states.set(run, state);
		state.requests++;
		state.active++;
		response.on("close", () => state.active--);
		if (["success", "service-failure", "timeout", "forced-death", "grpc"].includes(scenario) && count === 2) {
			const runDir = join("/logs/agent", run);
			const service = JSON.parse(readFileSync(join(runDir, "service.json"), "utf8"));
			const socket = connect(service.port, "127.0.0.1");
			await once(socket, "connect");
			socket.destroy();
			writeFileSync(join(runDir, "service-before-exit.json"), JSON.stringify(service));
			if (scenario === "forced-death") {
				const cli = JSON.parse(readFileSync(join(runDir, "cli.json"), "utf8"));
				assert.equal(identity(cli.pid), cli.start);
				process.kill(cli.pid, "SIGKILL");
				response.destroy();
				return;
			}
		}
		if (scenario === "service-failure" && count > 1) {
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Controlled failure after handoff" } }));
			return;
		}
		if (scenario === "authentication" || scenario === "exhausted" || (scenario === "recovered" && count === 1)) {
			response.writeHead(scenario === "authentication" ? 401 : 503, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: scenario === "authentication" ? "Controlled invalid API key" : "Controlled service overloaded" } }));
			return;
		}
		if (scenario === "timeout" && count > 1) return;
		let tool = count === 1 && ["timeout", "success", "service-failure", "forced-death"].includes(scenario)
			? { name: "bash", arguments: JSON.stringify({ command: 'nohup /opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs linger >/dev/null 2>&1 & while [ ! -f "$DIFFEX_TB_RUN_DIR/service.json" ]; do sleep 0.01; done; printf tool-ok' }) }
			: null;
		if (scenario === "grpc" && count === 1) tool = { name: "bash", arguments: JSON.stringify({ command:
			'cd /app && /opt/verifier/bin/python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. kv-store.proto && nohup /opt/verifier/bin/python /app/server.py >/app/server.log 2>&1 & while [ ! -f "$DIFFEX_TB_RUN_DIR/service.json" ]; do sleep 0.01; done' }) };
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
