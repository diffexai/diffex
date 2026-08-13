import type { Context } from "@earendil-works/diffex-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { deferred } from "./subagent-harness.ts";

function hasTool(context: Context, name: string): boolean {
	return context.tools?.some((tool) => tool.name === name) ?? false;
}

function getToolResultNames(context: Context): string[] {
	return context.messages.flatMap((message) => (message.role === "toolResult" ? [message.toolName] : []));
}

describe("automatic subagent coordination", () => {
	const roots: AgentSession[] = [];
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const root of roots.splice(0)) await root.dispose();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRoot(maxConcurrent = 2): Promise<{ root: AgentSession; harness: Harness }> {
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
			subagents: { maxConcurrent },
		});
		roots.push(root);
		return { root, harness };
	}

	it("resumes an idle parent and synthesizes without another user prompt", async () => {
		const { root, harness } = await createRoot();
		const childResult = deferred<void>();
		const synthesis = deferred<void>();
		const response = async (context: Context) => {
			if (!hasTool(context, "spawn_agent")) {
				await childResult.promise;
				return fauxAssistantMessage("CHILD-OUTPUT-SENTINEL");
			}

			const userTexts = context.messages
				.filter((message) => message.role === "user")
				.map((message) => getMessageText(message));
			if (userTexts.some((text) => text.includes('"cohort_complete":true'))) {
				synthesis.resolve();
				return fauxAssistantMessage("automatic final synthesis");
			}
			if (userTexts.some((text) => text.includes('"completed_attempts"'))) {
				return fauxAssistantMessage("brief completion report");
			}
			if (!getToolResultNames(context).includes("spawn_agent")) {
				return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "finish work" }), {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage("worker accepted");
		};
		harness.setResponses(Array.from({ length: 8 }, () => response));

		await root.prompt("delegate and synthesize");
		expect(root.getLastAssistantText()).toBe("worker accepted");

		childResult.resolve();
		await synthesis.promise;
		await root.waitForIdle();

		expect(root.getLastAssistantText()).toBe("automatic final synthesis");
		expect(
			root.messages.filter((message) => message.role === "toolResult").map((message) => message.toolName),
		).toEqual(["spawn_agent"]);
		const notifications = root.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "subagent_progress" ? [entry] : [],
			);
		expect(notifications).toHaveLength(2);
		expect(notifications.filter((entry) => JSON.stringify(entry).includes("CHILD-OUTPUT-SENTINEL"))).toHaveLength(1);
		const finalNotification = notifications.at(-1);
		expect(finalNotification).toMatchObject({ display: false });
		expect(JSON.parse(typeof finalNotification?.content === "string" ? finalNotification.content : "")).toEqual({
			cohort_complete: true,
			manifest: {
				cohort_id: expect.any(String),
				agents: [
					{
						name: "worker",
						status: "idle",
						attempt: 1,
						result_id: expect.any(String),
					},
				],
				unresolved: [],
			},
		});
	});
});
