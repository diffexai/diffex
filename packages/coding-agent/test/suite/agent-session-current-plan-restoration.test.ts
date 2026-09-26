import type { AgentMessage } from "@diffexai/diffex-agent-core";
import { fauxAssistantMessage, type Message, type TextContent } from "@diffexai/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendCurrentPlanRecord,
	CURRENT_PLAN_CUSTOM_ENTRY_TYPE,
	resolveCurrentPlanState,
} from "../../src/core/current-plan-state.ts";
import type { SessionStartEvent } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createUpdatePlanToolDefinition, type UpdatePlanToolDetails } from "../../src/core/tools/update-plan.ts";
import { createHarness, type Harness } from "./harness.ts";

type PlanUpdateDetails = Extract<UpdatePlanToolDetails, { plan: unknown }>;
type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

const CURRENT_TASK_CONTEXT_HEADER = "Current task context (latest plan):";

function activeOperation(): PlanUpdateDetails {
	return {
		plan: [
			{ id: "read-existing-state", step: "Read existing state", status: "completed" },
			{
				id: "implement-exact-restore",
				step: "  Implement exact restore  ",
				status: "in_progress",
				success_criteria: ["Plan survives resume", "Criteria survive compaction"],
			},
			{ id: "verify-once", step: "Verify once", status: "pending" },
		],
		explanation: "  keep this exact explanation  ",
	};
}

function operationWithoutExplanation(): PlanUpdateDetails {
	return {
		plan: [{ id: "continue-unfinished-work", step: "Continue unfinished work", status: "in_progress" }],
	};
}

function expectedRestoredText(operation: PlanUpdateDetails): string {
	return `${CURRENT_TASK_CONTEXT_HEADER}\n${JSON.stringify({ plan: operation.plan }, null, 2)}`;
}

function createPlanSessionManager(operation: PlanUpdateDetails = activeOperation()): SessionManager {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "existing session prompt" }],
		timestamp: Date.now() - 10_000,
	});
	appendCurrentPlanRecord(sessionManager, operation);
	return sessionManager;
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function findRestoredText(messages: Message[]): string | undefined {
	return messages.map(messageText).find((text) => text.includes(CURRENT_TASK_CONTEXT_HEADER));
}

function findRestoredContextText(texts: string[]): string | undefined {
	return texts.find((text) => text.includes(CURRENT_TASK_CONTEXT_HEADER));
}

async function submitAndCaptureContextTexts(harness: Harness, prompt = "continue"): Promise<string[]> {
	const capturedContexts: Message[][] = [];
	harness.setResponses([
		(context) => {
			capturedContexts.push(context.messages);
			return fauxAssistantMessage("done");
		},
	]);

	await harness.session.prompt(prompt);

	expect(capturedContexts).toHaveLength(1);
	return (capturedContexts[0] ?? []).map(messageText);
}

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		usage: createUsage(100),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession current-plan restoration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends exact current-task context on every request after opening or resuming", async () => {
		const operation = activeOperation();
		const extensionContextMessage: AgentMessage = {
			role: "custom",
			customType: "test.context",
			content: "extension transformed context",
			display: false,
			timestamp: Date.now(),
		};
		const opened = await createHarness({
			sessionManager: createPlanSessionManager(operation),
			extensionFactories: [
				(diffex) => {
					diffex.on("context", (event) => ({ messages: [...event.messages, extensionContextMessage] }));
				},
			],
		});
		harnesses.push(opened);

		const firstContextTexts = await submitAndCaptureContextTexts(opened, "first submission");
		expect(findRestoredContextText(firstContextTexts)).toBe(expectedRestoredText(operation));
		expect(firstContextTexts.indexOf("extension transformed context")).toBeLessThan(
			firstContextTexts.findIndex((text) => text.includes(CURRENT_TASK_CONTEXT_HEADER)),
		);
		expect(firstContextTexts.at(-1)).toBe(expectedRestoredText(operation));

		const secondContextTexts = await submitAndCaptureContextTexts(opened, "second submission");
		expect(secondContextTexts.at(-1)).toBe(expectedRestoredText(operation));

		expect(opened.session.messages.some((message) => message.role === "custom")).toBe(false);
		expect(opened.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
		expect(
			opened.events.some(
				(event) =>
					(event.type === "message_start" || event.type === "message_end") && event.message.role === "custom",
			),
		).toBe(false);

		const resumed = await createHarness({
			sessionManager: createPlanSessionManager(operation),
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: "previous.jsonl" },
		});
		harnesses.push(resumed);

		const resumedContextTexts = await submitAndCaptureContextTexts(resumed, "resumed submission");
		expect(findRestoredContextText(resumedContextTexts)).toBe(expectedRestoredText(operation));
	});

	it("includes current-task context for new sessions and forks", async () => {
		for (const reason of ["new", "fork"] as const) {
			const startEvent: SessionStartEvent = {
				type: "session_start",
				reason,
				previousSessionFile: "previous.jsonl",
			};
			const harness = await createHarness({
				sessionManager: createPlanSessionManager(),
				sessionStartEvent: startEvent,
			});
			harnesses.push(harness);

			const contextTexts = await submitAndCaptureContextTexts(harness, `${reason} submission`);
			expect(contextTexts.at(-1)).toBe(expectedRestoredText(activeOperation()));
		}
	});

	it("keeps current-task context after manual, auto, and cancelled compaction", async () => {
		const manualOperation = operationWithoutExplanation();
		const manual = await createHarness({
			extensionFactories: [
				(diffex) => {
					diffex.on("session_before_compact", (event) => ({
						compaction: {
							summary: "manual summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(manual);
		seedCompactableSession(manual);
		appendCurrentPlanRecord(manual.sessionManager, manualOperation);

		await manual.session.compact();

		const manualContextTexts = await submitAndCaptureContextTexts(manual, "after manual compaction");
		const restoredManual = findRestoredContextText(manualContextTexts);
		expect(restoredManual).toBe(expectedRestoredText(manualOperation));
		expect(restoredManual).not.toContain("explanation");

		const autoOperation = operationWithoutExplanation();
		const auto = await createHarness({
			extensionFactories: [
				(diffex) => {
					diffex.on("session_before_compact", (event) => ({
						compaction: {
							summary: "auto summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(auto);
		seedCompactableSession(auto);
		appendCurrentPlanRecord(auto.sessionManager, autoOperation);

		await (auto.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		const autoContextTexts = await submitAndCaptureContextTexts(auto, "after auto compaction");
		expect(findRestoredContextText(autoContextTexts)).toBe(expectedRestoredText(autoOperation));

		const cancelled = await createHarness({
			extensionFactories: [
				(diffex) => {
					diffex.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(cancelled);
		seedCompactableSession(cancelled);
		appendCurrentPlanRecord(cancelled.sessionManager, operationWithoutExplanation());

		await expect(cancelled.session.compact()).rejects.toThrow("Compaction cancelled");

		const cancelledContextTexts = await submitAndCaptureContextTexts(cancelled, "after cancelled compaction");
		expect(findRestoredContextText(cancelledContextTexts)).toBe(expectedRestoredText(operationWithoutExplanation()));
	});

	it("includes current-task context after preflight paths and model failure", async () => {
		let handleInput = true;
		const handled = await createHarness({
			sessionManager: createPlanSessionManager(),
			extensionFactories: [
				(diffex) => {
					diffex.on("input", () => (handleInput ? { action: "handled" } : { action: "continue" }));
				},
			],
		});
		harnesses.push(handled);

		await handled.session.prompt("handled before model");
		expect(handled.faux.state.callCount).toBe(0);
		handleInput = false;

		const handledContextTexts = await submitAndCaptureContextTexts(handled, "actual model submission");
		expect(findRestoredContextText(handledContextTexts)).toBe(expectedRestoredText(activeOperation()));

		const preflight = await createHarness({
			sessionManager: createPlanSessionManager(),
			withConfiguredAuth: false,
		});
		harnesses.push(preflight);

		await expect(preflight.session.prompt("missing auth")).rejects.toThrow(
			`No API key found for ${preflight.getModel().provider}.`,
		);
		const model = preflight.getModel();
		preflight.session.modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: preflight.faux.api,
			models: preflight.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const preflightContextTexts = await submitAndCaptureContextTexts(preflight, "after preflight failure");
		expect(findRestoredContextText(preflightContextTexts)).toBe(expectedRestoredText(activeOperation()));

		const modelFailure = await createHarness({
			sessionManager: createPlanSessionManager(),
			settings: { retry: { enabled: false } },
		});
		harnesses.push(modelFailure);
		const failureContexts: Message[][] = [];
		modelFailure.setResponses([
			(context) => {
				failureContexts.push(context.messages);
				throw new Error("model failed");
			},
		]);

		await modelFailure.session.prompt("fails after submission");
		expect(findRestoredText(failureContexts[0] ?? [])).toBe(expectedRestoredText(activeOperation()));
		const failedMessage = modelFailure.session.messages.at(-1);
		expect(failedMessage?.role).toBe("assistant");
		if (failedMessage?.role === "assistant") {
			expect(failedMessage.stopReason).toBe("error");
			expect(failedMessage.errorMessage).toContain("model failed");
		}

		const afterFailureTexts = await submitAndCaptureContextTexts(modelFailure, "after model failure");
		expect(findRestoredContextText(afterFailureTexts)).toBe(expectedRestoredText(activeOperation()));
	});

	it("uses the newest state when a plan is cleared, absent, or corrupt", async () => {
		const inactive = await createHarness({ sessionManager: createPlanSessionManager() });
		harnesses.push(inactive);
		appendCurrentPlanRecord(inactive.sessionManager, { clear: true });

		const inactiveTexts = await submitAndCaptureContextTexts(inactive, "after clear");
		expect(findRestoredContextText(inactiveTexts)).toBe(
			`${CURRENT_TASK_CONTEXT_HEADER}\n${JSON.stringify({ plan: [] }, null, 2)}`,
		);
		expect(resolveCurrentPlanState(inactive.sessionManager).status).toBe("inactive");

		const absent = await createHarness({ sessionManager: createPlanSessionManager() });
		harnesses.push(absent);
		absent.sessionManager.resetLeaf();

		const absentTexts = await submitAndCaptureContextTexts(absent, "after branch reset");
		expect(findRestoredContextText(absentTexts)).toBe(
			`${CURRENT_TASK_CONTEXT_HEADER}\n${JSON.stringify({ plan: [] }, null, 2)}`,
		);

		const corrupt = await createHarness({ sessionManager: createPlanSessionManager() });
		harnesses.push(corrupt);
		corrupt.sessionManager.appendCustomEntry(CURRENT_PLAN_CUSTOM_ENTRY_TYPE, {
			plan: [{ id: "do-not-revive-older-valid-state", step: "Do not revive older valid state", status: "pending" }],
		});

		const corruptTexts = await submitAndCaptureContextTexts(corrupt, "after corrupt newest");
		expect(findRestoredContextText(corruptTexts)).toBe(
			`${CURRENT_TASK_CONTEXT_HEADER}\n${JSON.stringify({ plan: [] }, null, 2)}`,
		);
		expect(resolveCurrentPlanState(corrupt.sessionManager).status).toBe("corrupt");
	});

	it("restores independently of active tool selection and same-name custom tools", async () => {
		const excluded = await createHarness({
			sessionManager: createPlanSessionManager(),
			excludedToolNames: ["update_plan"],
		});
		harnesses.push(excluded);
		expect(excluded.session.getActiveToolNames()).not.toContain("update_plan");

		const excludedTexts = await submitAndCaptureContextTexts(excluded, "without update_plan selected");
		expect(findRestoredContextText(excludedTexts)).toBe(expectedRestoredText(activeOperation()));

		const shadowed = await createHarness({
			sessionManager: createPlanSessionManager(),
			extensionFactories: [(diffex) => diffex.registerTool(createUpdatePlanToolDefinition())],
		});
		harnesses.push(shadowed);

		const shadowedTexts = await submitAndCaptureContextTexts(shadowed, "with shadowing update_plan");
		expect(findRestoredContextText(shadowedTexts)).toBe(expectedRestoredText(activeOperation()));
	});
});
