import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// This extension only transports the first instruction and records evidence.
// It does not replace or append to the production system prompt.
export default function observe(api) {
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	const rootSession = join(runDir, "sessions", "root.jsonl");
	let delivered = false;
	api.on("input", (event, ctx) => {
		if (ctx.sessionManager.getSessionFile() !== rootSession || delivered) return;
		if (event.text !== "DIFFEX_TERMINAL_BENCH_INSTRUCTION") return;
		delivered = true;
		return { action: "transform", text: readFileSync(join(runDir, "instruction.txt"), "utf8") };
	});
	api.on("before_agent_start", (event, ctx) => {
		if (ctx.sessionManager.getSessionFile() !== rootSession) return;
		const releaseAgentsPath = "/opt/diffex-terminal-bench/cli/node_modules/@diffexai/diffex/dist/AGENTS.md";
		const releaseAgents = readFileSync(releaseAgentsPath, "utf8");
		writeFileSync(join(runDir, "system-prompt.txt"), event.systemPrompt, { mode: 0o600 });
		writeFileSync(join(runDir, "effective.json"), JSON.stringify({
			provider: ctx.model?.provider, model: ctx.model?.id,
			thinking: api.getThinkingLevel(), tools: api.getActiveTools(), cwd: ctx.cwd,
			root_session: rootSession, instruction_delivered: delivered,
			instruction_sha256: createHash("sha256").update(event.prompt).digest("hex"),
			system_prompt_sha256: createHash("sha256").update(event.systemPrompt).digest("hex"),
			release_agents_path: releaseAgentsPath,
			release_agents_sha256: createHash("sha256").update(releaseAgents).digest("hex"),
			release_agents_loaded: event.systemPrompt.includes(releaseAgents),
		}, null, 2), { mode: 0o600 });
	});
}
