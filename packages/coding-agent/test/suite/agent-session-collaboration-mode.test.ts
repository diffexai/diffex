import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/diffex-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COLLABORATION_MODE_CUSTOM_TYPE,
	getCollaborationMode,
	PLAN_MODE_SYSTEM_PROMPT,
	resolveCollaborationMode,
	restoreCollaborationMode,
	setCollaborationMode,
} from "../../src/core/collaboration-mode.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import * as publicApi from "../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

function createTool(name: string, output = name, onExecute?: () => void): AgentTool {
	return {
		name,
		label: `Base ${name}`,
		description: `Base ${name} tool`,
		parameters: Type.Object({}),
		execute: async () => {
			onExecute?.();
			return { content: [{ type: "text", text: output }], details: {} };
		},
	};
}

const createBaseTools = (): AgentTool[] => [
	createTool("read", "base read"),
	createTool("grep"),
	createTool("find"),
	createTool("ls"),
	createTool("bash"),
	createTool("write"),
];

describe("AgentSession collaboration mode foundation", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("resolves only the newest matching entry on the selected branch and fails malformed data to Default", () => {
		const sessionManager = SessionManager.inMemory();
		const planEntry = sessionManager.appendCustomEntry(COLLABORATION_MODE_CUSTOM_TYPE, { mode: "plan" });
		sessionManager.appendCustomEntry("unrelated", { mode: "default" });
		expect(resolveCollaborationMode(sessionManager)).toBe("plan");

		sessionManager.appendCustomEntry(COLLABORATION_MODE_CUSTOM_TYPE, { mode: "plan", unexpected: true });
		expect(resolveCollaborationMode(sessionManager)).toBe("default");

		sessionManager.branch(planEntry);
		sessionManager.appendCustomEntry("unrelated", { mode: "default" });
		expect(resolveCollaborationMode(sessionManager)).toBe("plan");

		sessionManager.resetLeaf();
		expect(resolveCollaborationMode(sessionManager)).toBe("default");
	});

	it("keeps control package-internal and requires explicit interactive restoration", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry(COLLABORATION_MODE_CUSTOM_TYPE, { mode: "plan" });
		const harness = await createHarness({ sessionManager, tools: createBaseTools() });
		harnesses.push(harness);

		expect(publicApi).not.toHaveProperty("setCollaborationMode");
		expect(publicApi).not.toHaveProperty("restoreCollaborationMode");
		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(harness.session.getActiveToolNames()).toContain("bash");

		expect(restoreCollaborationMode(harness.session)).toEqual({ status: "changed", mode: "plan" });
		expect(getCollaborationMode(harness.session)).toBe("plan");
		expect(
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === COLLABORATION_MODE_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("installs a mode only after its session entry persists", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "diffex-plan-mode-atomic-"));
		const sessionManager = SessionManager.create(process.cwd(), sessionDir);
		sessionManager.appendMessage(fauxAssistantMessage("seed"));
		const harness = await createHarness({ sessionManager, tools: createBaseTools() });
		harnesses.push(harness);
		rmSync(sessionDir, { recursive: true, force: true });

		expect(() => setCollaborationMode(harness.session, "plan")).toThrow();
		expect(getCollaborationMode(harness.session)).toBe("default");
		expect(harness.session.getActiveToolNames()).toContain("bash");
		expect(resolveCollaborationMode(sessionManager)).toBe("default");
	});

	it("uses only trusted filtered base tools in Plan and restores the latest requested Default tools", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "read",
					label: "Extension read",
					description: "An untrusted same-name replacement",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "extension read" }], details: {} }),
				});
				pi.registerTool({
					name: "custom",
					label: "Custom",
					description: "A custom tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "custom" }], details: {} }),
				});
			},
		];
		const harness = await createHarness({ tools: createBaseTools(), extensionFactories });
		harnesses.push(harness);

		const defaultRead = harness.session.agent.state.tools.find((tool) => tool.name === "read");
		expect((await defaultRead?.execute("default-read", {}))?.content).toContainEqual({
			type: "text",
			text: "extension read",
		});

		expect(setCollaborationMode(harness.session, "plan")).toEqual({ status: "changed", mode: "plan" });
		expect(harness.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls", "request_user_input"]);
		expect(harness.session.getToolDefinition("read")?.label).toBe("Base read");
		const planRead = harness.session.agent.state.tools.find((tool) => tool.name === "read");
		expect((await planRead?.execute("plan-read", {}))?.content).toContainEqual({
			type: "text",
			text: "base read",
		});
		expect(harness.session.systemPrompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(2);
		expect(harness.session.systemPrompt).not.toContain("An untrusted same-name replacement");

		harness.session.setActiveToolsByName(["bash", "custom"]);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls", "request_user_input"]);
		expect(harness.session.systemPrompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(2);
		expect(setCollaborationMode(harness.session, "default")).toEqual({ status: "changed", mode: "default" });
		expect(harness.session.getActiveToolNames()).toEqual(["bash", "custom"]);
		expect(harness.session.systemPrompt).not.toContain(PLAN_MODE_SYSTEM_PROMPT);

		expect(setCollaborationMode(harness.session, "default")).toEqual({ status: "unchanged", mode: "default" });
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === COLLABORATION_MODE_CUSTOM_TYPE),
		).toHaveLength(2);
	});

	it("intersects Plan tools with invocation filters and never synthesizes missing host tools", async () => {
		const filtered = await createHarness({
			tools: createBaseTools(),
			allowedToolNames: ["read", "grep", "find", "bash"],
			excludedToolNames: ["grep"],
		});
		const questionOnly = await createHarness({
			tools: createBaseTools(),
			allowedToolNames: ["request_user_input"],
		});
		const excludedQuestion = await createHarness({
			tools: createBaseTools(),
			excludedToolNames: ["request_user_input"],
		});
		const missing = await createHarness({ tools: [createTool("read")] });
		harnesses.push(filtered, questionOnly, excludedQuestion, missing);

		setCollaborationMode(filtered.session, "plan");
		setCollaborationMode(questionOnly.session, "plan");
		setCollaborationMode(excludedQuestion.session, "plan");
		setCollaborationMode(missing.session, "plan");

		expect(filtered.session.getActiveToolNames()).toEqual(["read", "find"]);
		expect(questionOnly.session.getActiveToolNames()).toEqual(["request_user_input"]);
		expect(excludedQuestion.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls"]);
		expect(missing.session.getActiveToolNames()).toEqual(["read", "request_user_input"]);
		expect(missing.session.getToolDefinition("grep")).toBeUndefined();
	});

	it("reserves request_user_input for the built-in Plan tool", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "request_user_input",
					label: "Extension question",
					description: "Untrusted replacement",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "extension" }], details: {} }),
				});
			},
		];
		const harness = await createHarness({ tools: createBaseTools(), extensionFactories });
		harnesses.push(harness);

		expect(harness.session.getActiveToolNames()).not.toContain("request_user_input");
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("request_user_input");
		setCollaborationMode(harness.session, "plan");
		expect(harness.session.getToolDefinition("request_user_input")?.label).toBe("request_user_input");
	});

	it("captures Plan synchronously at admission and applies its instructions after extension prompt hooks", async () => {
		let releaseInput: (() => void) | undefined;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("input", async () => {
					await inputGate;
					return { action: "continue" };
				});
				pi.on("before_agent_start", () => ({ systemPrompt: "extension-owned prompt" }));
			},
		];
		const harness = await createHarness({ tools: createBaseTools(), extensionFactories });
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		let providerPrompt = "";
		let activeTransition: unknown;
		harness.setResponses([
			(context) => {
				providerPrompt = context.systemPrompt ?? "";
				activeTransition = setCollaborationMode(harness.session, "default");
				return fauxAssistantMessage("planned");
			},
		]);

		const prompt = harness.session.prompt("make a plan");
		expect(setCollaborationMode(harness.session, "default")).toEqual({ status: "busy", mode: "plan" });
		releaseInput?.();
		await prompt;

		expect(activeTransition).toEqual({ status: "busy", mode: "plan" });
		expect(providerPrompt.startsWith("extension-owned prompt\n\n")).toBe(true);
		expect(providerPrompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(2);
		expect(getCollaborationMode(harness.session)).toBe("plan");

		await harness.session.reload();
		expect(harness.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls", "request_user_input"]);
		expect(harness.session.systemPrompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(2);
	});

	it("freezes the admitted Plan prompt and exact tool implementations through preflight and continuations", async () => {
		let currentSystemPrompt = "admission-owned prompt";
		let signalInputStarted: (() => void) | undefined;
		let releaseInput: (() => void) | undefined;
		let refreshTools = (): void => {
			throw new Error("Extension did not initialize");
		};
		const inputStarted = new Promise<void>((resolve) => {
			signalInputStarted = resolve;
		});
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				refreshTools = () => {
					pi.registerTool({
						name: "late_tool",
						label: "Late tool",
						description: "Registered after Plan admission",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
					});
				};
				pi.on("input", async () => {
					signalInputStarted?.();
					await inputGate;
					return { action: "continue" };
				});
				pi.on("before_agent_start", (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nextension-owned admission prompt`,
				}));
			},
		]);
		const baseResourceLoader = createTestResourceLoader({ extensionsResult });
		const resourceLoader = {
			...baseResourceLoader,
			getSystemPrompt: () => currentSystemPrompt,
		};
		const harness = await createHarness({ tools: createBaseTools(), resourceLoader });
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		const admittedTools = harness.session.agent.state.tools.slice();
		const providerPrompts: string[] = [];
		const providerTools: object[][] = [];
		harness.setResponses([
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				providerTools.push(context.tools ?? []);
				return fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" });
			},
			(context) => {
				providerPrompts.push(context.systemPrompt ?? "");
				providerTools.push(context.tools ?? []);
				return fauxAssistantMessage("planned");
			},
		]);

		const prompt = harness.session.prompt("make a stable plan");
		await inputStarted;
		currentSystemPrompt = "next-run prompt";
		refreshTools();
		harness.session.setActiveToolsByName(["bash"]);
		releaseInput?.();
		await prompt;

		expect(providerPrompts).toHaveLength(2);
		for (const providerPrompt of providerPrompts) {
			expect(providerPrompt).toContain("admission-owned prompt");
			expect(providerPrompt).toContain("extension-owned admission prompt");
			expect(providerPrompt).not.toContain("next-run prompt");
			expect(providerPrompt.split(PLAN_MODE_SYSTEM_PROMPT)).toHaveLength(2);
		}
		expect(providerTools).toHaveLength(2);
		for (const tools of providerTools) {
			expect(tools).toHaveLength(admittedTools.length);
			expect(tools.every((tool, index) => tool === admittedTools[index])).toBe(true);
		}
		expect(getAssistantTexts(harness)).toContain("planned");
		expect(harness.session.systemPrompt).toContain("next-run prompt");

		setCollaborationMode(harness.session, "default");
		expect(harness.session.getActiveToolNames()).toEqual(["bash"]);
	});

	it.each(["isStreaming", "isCompacting", "isRetrying", "isBashRunning"] as const)(
		"rejects a mode change while %s is true",
		async (property) => {
			const harness = await createHarness({ tools: createBaseTools() });
			harnesses.push(harness);
			vi.spyOn(harness.session, property, "get").mockReturnValue(true);

			expect(setCollaborationMode(harness.session, "plan")).toEqual({ status: "busy", mode: "default" });
			expect(resolveCollaborationMode(harness.sessionManager)).toBe("default");
		},
	);

	it("rejects a mode change from the synchronous start of manual compaction", async () => {
		const harness = await createHarness({ tools: createBaseTools() });
		harnesses.push(harness);
		let signalAbortStarted: (() => void) | undefined;
		let releaseAbort: (() => void) | undefined;
		const abortStarted = new Promise<void>((resolve) => {
			signalAbortStarted = resolve;
		});
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		vi.spyOn(harness.session, "abort").mockImplementation(async () => {
			signalAbortStarted?.();
			await abortGate;
		});

		const compaction = harness.session.compact();
		await abortStarted;
		expect(setCollaborationMode(harness.session, "plan")).toEqual({ status: "busy", mode: "default" });
		releaseAbort?.();
		await expect(compaction).rejects.toThrow("Nothing to compact");
		expect(resolveCollaborationMode(harness.sessionManager)).toBe("default");
	});

	it("blocks a stale disallowed Plan call before extension hooks", async () => {
		let bashExecutions = 0;
		let extensionToolCalls = 0;
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("tool_call", () => {
					extensionToolCalls++;
				});
			},
		];
		const read = createTool("read");
		const bash = createTool("bash", "unsafe", () => bashExecutions++);
		const harness = await createHarness({ tools: [read, bash], extensionFactories });
		harnesses.push(harness);
		const staleBash = harness.session.agent.state.tools.find((tool) => tool.name === "bash");
		if (!staleBash) throw new Error("Expected the base bash tool");
		setCollaborationMode(harness.session, "plan");
		harness.session.agent.state.tools.push(staleBash);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "toolUse" }),
			(context) => {
				const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
				const text = result?.role === "toolResult" ? result.content.find((part) => part.type === "text")?.text : "";
				return fauxAssistantMessage(text ?? "");
			},
		]);

		await harness.session.prompt("try the stale tool");

		expect(bashExecutions).toBe(0);
		expect(extensionToolCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain('Tool "bash" is unavailable in Plan mode.');
	});

	it("blocks a stale question call outside the captured Plan run", async () => {
		let extensionToolCalls = 0;
		const harness = await createHarness({
			tools: createBaseTools(),
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => {
						extensionToolCalls++;
					});
				},
			],
		});
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		const staleQuestion = harness.session.agent.state.tools.find((tool) => tool.name === "request_user_input");
		if (!staleQuestion) throw new Error("Expected the built-in question tool");
		setCollaborationMode(harness.session, "default");
		harness.session.agent.state.tools.push(staleQuestion);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [
						{
							id: "scope",
							header: "Scope",
							question: "Which scope?",
							options: [
								{ label: "Focused", description: "Keep the change focused." },
								{ label: "Broad", description: "Expand the change." },
							],
						},
					],
				}),
				{
					stopReason: "toolUse",
				},
			),
			(context) => {
				const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
				const text = result?.role === "toolResult" ? result.content.find((part) => part.type === "text")?.text : "";
				return fauxAssistantMessage(text ?? "");
			},
		]);

		await harness.session.prompt("try the stale question tool");

		expect(extensionToolCalls).toBe(0);
		expect(getAssistantTexts(harness)).toContain('Tool "request_user_input" is unavailable outside Plan mode.');
	});

	it("reports unavailable Plan questions as errors when no TUI supports the call", async () => {
		const harness = await createHarness({ tools: createBaseTools() });
		harnesses.push(harness);
		setCollaborationMode(harness.session, "plan");
		let observedResult: { isError: boolean; text: string } | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("request_user_input", {
					questions: [
						{
							id: "scope",
							header: "Scope",
							question: "Which scope?",
							options: [
								{ label: "Focused", description: "Keep the change focused." },
								{ label: "Broad", description: "Expand the change." },
							],
						},
					],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
				const text = result?.role === "toolResult" ? result.content.find((part) => part.type === "text")?.text : "";
				observedResult = { isError: result?.role === "toolResult" && result.isError, text: text ?? "" };
				return fauxAssistantMessage("continued after unavailable question");
			},
		]);

		await harness.session.prompt("ask without an interactive UI");

		expect(observedResult).toEqual({
			isError: true,
			text: "request_user_input is unavailable without interactive UI.",
		});
		expect(getAssistantTexts(harness)).toContain("continued after unavailable question");
		expect(getCollaborationMode(harness.session)).toBe("plan");
	});
});
