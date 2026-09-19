import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@diffexai/diffex-ai";
import { afterEach, expect, it } from "vitest";
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

it("inspects a running child immediately and automatically waits for its result", async () => {
	harness = await createHarness({ settings: { retry: { enabled: false } } });
	({ session: root } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: createTestResourceLoader(),
		sessionManager: SessionManager.inMemory(harness.tempDir),
		model: harness.getModel(),
	}));
	expect(root.getActiveToolNames()).toContain("agent_status");
	expect(root.getToolDefinition("wait_for_agents")).toBeUndefined();
	const started = deferred<void>();
	const finish = deferred<void>();
	const waiting = deferred<void>();
	root.subscribe((event) => {
		if (event.type === "subagent_wait_start") waiting.resolve();
	});
	let inspected = false;
	harness.setResponses(
		Array.from({ length: 8 }, () => async (context: Context, options?: SimpleStreamOptions) => {
			if (!context.tools?.some((tool) => tool.name === "spawn_agent")) {
				options?.signal?.addEventListener("abort", () => finish.resolve(), { once: true });
				started.resolve();
				await finish.promise;
				return fauxAssistantMessage("verified child result");
			}
			const results = context.messages.filter((message) => message.role === "toolResult");
			if (!results.some((message) => message.toolName === "spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "Check the build" }), {
					stopReason: "toolUse",
				});
			}
			if (!results.some((message) => message.toolName === "agent_status")) {
				await started.promise;
				return fauxAssistantMessage(fauxToolCall("agent_status", { targets: ["worker"] }), {
					stopReason: "toolUse",
				});
			}
			const status = results.find((message) => message.toolName === "agent_status")!;
			expect(status.isError).toBe(false);
			expect(status.content).toEqual([{ type: "text", text: '{"agents":[{"name":"worker","status":"running"}]}' }]);
			inspected = true;
			if (JSON.stringify(context.messages).includes("verified child result"))
				return fauxAssistantMessage("Build verified.");
			return fauxAssistantMessage("Only the delegated build check remains.");
		}),
	);
	const prompt = root.prompt("Verify the build.");
	try {
		await waiting.promise;
		expect(inspected).toBe(true);
		expect(root.getSubagents()[0]?.status).toBe("running");
		finish.resolve();
		await prompt;
		expect(root.getLastAssistantText()).toBe("Build verified.");
		expect(
			root.messages.filter((message) => message.role === "custom" && message.customType === "subagent_results"),
		).toHaveLength(1);
	} finally {
		finish.resolve();
		await root.abort();
		await prompt;
	}
});
