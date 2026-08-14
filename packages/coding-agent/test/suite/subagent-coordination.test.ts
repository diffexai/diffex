import type { Context } from "@earendil-works/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

async function expectPending(promise: Promise<unknown>): Promise<void> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
}

function hasTool(context: Context, name: string): boolean {
	return context.tools?.some((tool) => tool.name === name) ?? false;
}

function hasToolResult(context: Context, name: string): boolean {
	return context.messages.some((message) => message.role === "toolResult" && message.toolName === name);
}

describe("automatic subagent coordination", () => {
	const roots: AgentSession[] = [];
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await root.dispose();
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	async function createRoot(): Promise<{ root: AgentSession; harness: Harness }> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const { session: root } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model: harness.getModel(),
			tools: ["spawn_agent", "agent_action", "agents"],
			subagents: { maxConcurrent: 2 },
		});
		roots.push(root);
		return { root, harness };
	}

	it("keeps the parent pending and resumes it with the child result", async () => {
		const { root, harness } = await createRoot();
		const releaseChild = deferred<void>();
		const parentFinishedEarly = deferred<void>();
		const parentContexts: Context[] = [];
		harness.setResponses(
			Array.from({ length: 8 }, () => async (context: Context) => {
				if (!hasTool(context, "spawn_agent")) {
					await releaseChild.promise;
					return fauxAssistantMessage("CHILD-RESULT-SENTINEL");
				}

				parentContexts.push(context);
				const hiddenResult = context.messages.find(
					(message) => message.role === "user" && getMessageText(message).includes("CHILD-RESULT-SENTINEL"),
				);
				if (hiddenResult) {
					return fauxAssistantMessage("automatic final answer");
				}
				if (!hasToolResult(context, "spawn_agent")) {
					return fauxAssistantMessage(
						fauxToolCall("spawn_agent", { name: "worker", task: "finish delayed work" }),
						{ stopReason: "toolUse" },
					);
				}

				parentFinishedEarly.resolve();
				return fauxAssistantMessage("attempted early finish");
			}),
		);

		const prompt = root.prompt("delegate work");
		await parentFinishedEarly.promise;
		try {
			await expectPending(prompt);
		} finally {
			releaseChild.resolve();
		}
		await prompt;

		expect(root.getLastAssistantText()).toBe("automatic final answer");
		expect(parentContexts).toHaveLength(3);
		expect(getMessageText(parentContexts[2]?.messages.at(-1))).toContain("CHILD-RESULT-SENTINEL");
	});
});
