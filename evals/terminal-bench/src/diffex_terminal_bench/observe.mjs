import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Observe the first user message without registering hooks that alter input,
// provider requests, or tools. Such hooks would disable subagents in 0.2.2.
export default function observe(api) {
	const runDir = process.env.DIFFEX_TB_RUN_DIR;
	const rootSession = join(runDir, "sessions", "root.jsonl");
	let recorded = false;
	api.on("message_start", (event, ctx) => {
		if (ctx.sessionManager.getSessionFile() !== rootSession || recorded || event.message.role !== "user") return;
		recorded = true;
		const instructionPath = join(runDir, "instruction.txt");
		const instruction = readFileSync(instructionPath, "utf8");
		const prompt = typeof event.message.content === "string" ? event.message.content :
			event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		const systemPrompt = ctx.getSystemPrompt();
		const releaseAgentsPath = process.env.DIFFEX_TB_RELEASE_AGENTS;
		const releaseAgents = readFileSync(releaseAgentsPath, "utf8");
		writeFileSync(join(runDir, "system-prompt.txt"), systemPrompt, { mode: 0o600 });
		writeFileSync(join(runDir, "effective.json"), JSON.stringify({
			provider: ctx.model?.provider, model: ctx.model?.id,
			thinking: api.getThinkingLevel(), tools: api.getActiveTools(), cwd: ctx.cwd,
			root_session: rootSession,
			instruction_transport: "native-file",
			instruction_delivered: prompt === `<file name="${instructionPath}">\n${instruction}\n</file>\n`,
			instruction_sha256: createHash("sha256").update(instruction).digest("hex"),
			prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
			system_prompt_sha256: createHash("sha256").update(systemPrompt).digest("hex"),
			release_agents_path: releaseAgentsPath,
			release_agents_sha256: createHash("sha256").update(releaseAgents).digest("hex"),
			release_agents_loaded: systemPrompt.includes(releaseAgents),
		}, null, 2), { mode: 0o600 });
	});
}
