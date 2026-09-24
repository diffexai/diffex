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
		const requested = JSON.parse(readFileSync(join(runDir, "requested.json"), "utf8"));
		const prompt = typeof event.message.content === "string" ? event.message.content :
			event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		const systemPrompt = ctx.getSystemPrompt();
		writeFileSync(join(runDir, "system-prompt.txt"), systemPrompt, { mode: 0o600 });
		writeFileSync(join(runDir, "effective.json"), JSON.stringify({
			provider: ctx.model?.provider, model: ctx.model?.id,
			thinking: api.getThinkingLevel(), tools: api.getActiveTools(), cwd: ctx.cwd,
			root_session: rootSession,
			background_process_lifetime: process.argv.includes("--background-process-lifetime")
				? process.argv[process.argv.indexOf("--background-process-lifetime") + 1] : null,
			instruction_transport: "native-file",
			instruction_delivered: prompt === `<file name="${instructionPath}">\n${instruction}\n</file>\n${requested.user_message_suffix}`,
			user_message_suffix: requested.user_message_suffix,
			instruction_sha256: createHash("sha256").update(instruction).digest("hex"),
			prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
			system_prompt_sha256: createHash("sha256").update(systemPrompt).digest("hex"),
			context_files_disabled: process.argv.includes("--no-context-files"),
		}, null, 2), { mode: 0o600 });
	});
}
