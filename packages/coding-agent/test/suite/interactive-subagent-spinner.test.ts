import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import type { Container } from "@diffexai/diffex-tui";
import { expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createTestResourceLoader } from "../extension-test-utils.ts";
import { createHarness } from "./harness.ts";
import { deferred, getLastUserText } from "./subagent-harness.ts";

it.each(["regular", "fullscreen"] as const)("keeps the %s spinner visible through delegated work", async (tuiMode) => {
	initTheme("dark");
	const harness = await createHarness();
	const { session } = await createAgentSession({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: createTestResourceLoader(),
		sessionManager: SessionManager.inMemory(harness.tempDir),
		model: harness.getModel(),
		tools: ["spawn_agent"],
		subagents: { maxConcurrent: 1 },
	});
	const mode = new InteractiveMode(
		{
			session,
			setBeforeSessionInvalidate() {},
			setRebindSession() {},
		} as unknown as AgentSessionRuntime,
		{ tuiMode },
	);
	const state = mode as unknown as {
		isInitialized: boolean;
		subscribeToAgent(): void;
		statusContainer: Container;
	};
	state.isInitialized = true;
	state.subscribeToAgent();
	const releaseChild = deferred<void>();
	const endOfResponse: string[] = [];
	let waitStatus = "";
	const renderStatus = () => stripAnsi(state.statusContainer.render(80).join("\n")).trim();
	session.subscribe((event) => {
		if (event.type === "agent_end") endOfResponse.push(renderStatus());
		if (event.type === "subagent_wait_start") {
			waitStatus = renderStatus();
			releaseChild.resolve();
		}
	});
	harness.setResponses(
		Array.from({ length: 6 }, () => async (context: Context) => {
			if (!context.tools?.some((tool) => tool.name === "spawn_agent")) {
				await releaseChild.promise;
				return fauxAssistantMessage("Child result");
			}
			if (getLastUserText(context).includes("subagent_batch_results")) return fauxAssistantMessage("Done");
			if (context.messages.some((message) => message.role === "toolResult")) return fauxAssistantMessage("Waiting");
			return fauxAssistantMessage(fauxToolCall("spawn_agent", { name: "worker", task: "Review" }), {
				stopReason: "toolUse",
			});
		}),
	);
	try {
		await session.prompt("Delegate the review");
		expect(session.getLastAssistantText()).toBe("Done");
		expect(waitStatus).toContain("Waiting for subagent");
		expect(endOfResponse).not.toContain("");
		expect(renderStatus()).toBe("");
	} finally {
		releaseChild.resolve();
		mode.stop();
		await session.dispose();
		await harness.cleanup();
	}
});
