// Controlled Linux smoke fixture. Never used by the benchmark adapter.
const { createServer } = require("node:http");
const { appendFileSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

if (process.argv[2] === "prepare") {
	const state = process.env.DIFFEX_CODING_AGENT_DIR;
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	writeFileSync(join(runDir, "fixture-start.json"), JSON.stringify({
		state_entries: readdirSync(state).sort(),
		session_entries: readdirSync(process.env.DIFFEX_SESSION_DIR),
		settings: JSON.parse(readFileSync(join(state, "settings.json"), "utf8")),
		unrelated_credential_present: Boolean(process.env.ANTHROPIC_API_KEY),
	}));
	// Only redirect the fixture model to loopback. The release's CLI, tools,
	// prompt construction, persistence, and adapter extension run unchanged.
	writeFileSync(join(state, "models.json"), JSON.stringify({ providers: { openai: {
		baseUrl: "http://127.0.0.1:8765/v1", api: "openai-completions", models: [{
			id: "gpt-5", name: "Controlled smoke model", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 4096,
		}],
	} } }));
	process.exit(0);
}

let requestNumber = 0;
createServer(async (request, response) => {
	if (request.url === "/health") { response.end("ok"); return; }
	let text = "";
	for await (const chunk of request) text += chunk;
	const body = JSON.parse(text);
	appendFileSync("/logs/agent/fixture-requests.jsonl", `${JSON.stringify({
		body, credential_received: request.headers.authorization === "Bearer fixture-secret-never-log",
	})}\n`);
	const completed = body.messages.filter((message) => message.role === "tool").length;
	const isChild = JSON.stringify(body.messages.find((message) => message.role === "user")?.content).includes("CONTROLLED_CHILD_TASK");
	const enabled = body.tools.some((tool) => tool.function.name === "spawn_agent");
	let tool;
	if (completed === 0 && isChild) {
		tool = { name: "write", arguments: JSON.stringify({ path: "child.txt", content: "child-ok\n" }) };
	} else if (completed === 0) {
		tool = { name: "bash", arguments: JSON.stringify({ command: "pwd > cwd.txt; printf shell-ok > shell.txt" }) };
	} else if (completed === 1 && !isChild) {
		tool = { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "file-ok\n" }) };
	} else if (completed === 2 && enabled && !isChild) {
		tool = { name: "spawn_agent", arguments: JSON.stringify({ name: "helper", task: "CONTROLLED_CHILD_TASK" }) };
	}
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const id = `completion-${++requestNumber}`;
	const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
		id, object: "chat.completion.chunk", created: 1, model: body.model,
		choices: [{ index: 0, delta, finish_reason }],
	})}\n\n`);
	send({ role: "assistant" });
	if (tool) send({ tool_calls: [{ index: 0, id: `call-${requestNumber}`, type: "function", function: tool }] });
	else send({ content: "controlled-ok" });
	send({}, tool ? "tool_calls" : "stop");
	response.end("data: [DONE]\n\n");
}).listen(8765, "127.0.0.1");
