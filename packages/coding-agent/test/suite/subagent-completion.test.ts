import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@diffexai/diffex-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../extension-test-utils.ts";
import { createHarness, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

let harness: Harness | undefined;
let root: AgentSession | undefined;
afterEach(async () => {
	await root?.dispose();
	await harness?.cleanup();
});

it("asks the parent to cancel obsolete children before completing a solved task", async () => {
	harness = await createHarness({ settings: { retry: { enabled: false } } });
	({ session: root } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: createTestResourceLoader(),
		sessionManager: SessionManager.inMemory(harness.tempDir),
		model: harness.getModel(),
		tools: ["spawn_agent", "agent_action", "agent_status"],
	}));
	const started = deferred<void>();
	let reviewed = false;
	let cancelled = false;
	harness.setResponses(
		Array.from({ length: 10 }, () => async (context: Context, options?: SimpleStreamOptions) => {
			if (!context.tools?.some((tool) => tool.name === "spawn_agent")) {
				return await new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
					started.resolve();
					const abort = () => {
						cancelled = true;
						resolve(fauxAssistantMessage("cancelled", { stopReason: "aborted" }));
					};
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				});
			}
			if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "spawn_agent")) {
				return fauxAssistantMessage(
					fauxToolCall("spawn_agent", { name: "compiler", task: "Investigate compiler" }),
					{ stopReason: "toolUse" },
				);
			}
			if (!JSON.stringify(context.messages).includes("subagent_completion_check")) {
				await started.promise;
				return fauxAssistantMessage("Build solved.");
			}
			reviewed = true;
			if (
				!context.messages.some((message) => message.role === "toolResult" && message.toolName === "agent_action")
			) {
				return fauxAssistantMessage(fauxToolCall("agent_action", { target: "compiler", action: "interrupt" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("Build solved; obsolete investigation cancelled.");
		}),
	);
	const prompt = root.prompt("Compile the project.");
	try {
		await vi.waitFor(() => expect(reviewed).toBe(true));
		await prompt;
		expect(cancelled).toBe(true);
		expect(root.getSubagents()[0]?.status).toBe("interrupted");
		expect(root.getLastAssistantText()).toBe("Build solved; obsolete investigation cancelled.");
	} finally {
		await root.abort();
		await prompt;
	}
});
