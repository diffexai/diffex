// Source-level fixture for the eval runner. No provider or sandbox network calls.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Context, SimpleStreamOptions } from "@diffexai/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness } from "../harness.ts";
import { deferred } from "../subagent-harness.ts";

const [scenario, directory] = process.argv.slice(2);
if (!directory || !["exhausted", "success"].includes(scenario ?? "")) throw new Error("Invalid fixture arguments");
const harness = await createHarness({
	settings: {
		evolution: { enabled: false },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
		compaction: { enabled: false },
	},
});
const services = await createAgentSessionServices({
	cwd: harness.tempDir,
	agentDir: harness.tempDir,
	modelRuntime: harness.session.modelRuntime,
	settingsManager: harness.settingsManager,
	resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
});
const { session: root } = await createAgentSession({
	...services,
	sessionManager: SessionManager.inMemory(harness.tempDir),
	model: harness.getModel(),
	tools: ["spawn_agent", "agent_action", "agent_status"],
	subagents: { maxConcurrent: 1 },
});
const runtime = new AgentSessionRuntime(root, services, async () => {
	throw new Error("Unexpected session replacement");
});
const childStarted = deferred<void>();
const parentWaiting = deferred<void>();
let parentCalls = 0;
let childCalls = 0;
let childSettled = false;
root.subscribe((event) => {
	if (event.type === "subagent_wait_start") parentWaiting.resolve();
	if (event.type === "auto_retry_end" && !event.success) {
		void root.sendCustomMessage({ customType: "subagent_results", content: "queued report", display: false });
	}
	if (event.type === "agent_settled") {
		writeFileSync(
			join(directory, "parent.json"),
			JSON.stringify({
				parentCalls,
				childCalls,
				childSettled,
				children: root.getSubagents(),
				lastMessage: root.messages.at(-1),
				error: root.state.errorMessage,
			}),
		);
	}
});
harness.setResponses(
	Array.from({ length: 12 }, () => async (context: Context, options?: SimpleStreamOptions) => {
		if (!context.tools?.some((tool) => tool.name === "spawn_agent")) {
			childCalls += 1;
			childStarted.resolve();
			if (scenario === "exhausted") {
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
			if (scenario === "success") await parentWaiting.promise;
			await setTimeout(20);
			childSettled = true;
			return fauxAssistantMessage("child result", { stopReason: scenario === "exhausted" ? "aborted" : "stop" });
		}
		parentCalls += 1;
		if (parentCalls === 1) {
			const calls = [fauxToolCall("spawn_agent", { name: "running", task: "delayed work" })];
			if (scenario === "exhausted") calls.push(fauxToolCall("spawn_agent", { name: "queued", task: "queued work" }));
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		}
		await childStarted.promise;
		return scenario === "exhausted"
			? fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exhausted" })
			: fauxAssistantMessage("completed successfully");
	}),
);
try {
	process.exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: "delegate work" });
} finally {
	await runtime.dispose();
	await harness.cleanup();
}
