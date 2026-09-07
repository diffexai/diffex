import { fauxAssistantMessage, fauxText } from "@earendil-works/diffex-ai";
import { afterEach, describe, expect, it } from "vitest";
import { setCollaborationMode } from "../../src/core/collaboration-mode.ts";
import { parseFinalizedPlanResponse } from "../../src/core/finalized-plan.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const validPlan = "Before\n<proposed_plan>\n# Plan\n\n1. Do it\n</proposed_plan>\nAfter";
const cleanPlan = "Before\n# Plan\n\n1. Do it\nAfter";

function getPersistedAssistantTexts(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "assistant")
		.map((entry) => getMessageText(entry.message));
}

describe("strict finalized Plan response parsing", () => {
	it.each([
		{
			name: "LF",
			input: validPlan,
			clean: cleanPlan,
			plan: "# Plan\n\n1. Do it\n",
		},
		{
			name: "CRLF",
			input: "Before\r\n<proposed_plan>\r\n# Plan\r\n\r\n1. Do it\r\n</proposed_plan>\r\nAfter",
			clean: "Before\r\n# Plan\r\n\r\n1. Do it\r\nAfter",
			plan: "# Plan\r\n\r\n1. Do it\r\n",
		},
	])("preserves surrounding text and Markdown with $name line endings", ({ input, clean, plan }) => {
		const message = fauxAssistantMessage(input);

		expect(parseFinalizedPlanResponse(message)).toEqual({
			message: { ...message, content: [{ type: "text", text: clean }] },
			plan,
		});
		expect(getMessageText(message)).toBe(input);
	});

	it("accepts tags in one text item and ignores apparent tags inside ordinary fences", () => {
		const message = fauxAssistantMessage([
			fauxText("Prelude"),
			fauxText(
				"```xml\n<proposed_plan>\nfenced\n</proposed_plan>\n```\n~~~\n<proposed_plan>\ntilde\n</proposed_plan>\n~~~\n<proposed_plan>\n**Real plan**\n</proposed_plan>",
			),
			fauxText("Epilogue"),
		]);

		const parsed = parseFinalizedPlanResponse(message);

		expect(parsed?.plan).toBe("**Real plan**\n");
		expect(parsed?.message.content).toEqual([
			fauxText("Prelude"),
			fauxText(
				"```xml\n<proposed_plan>\nfenced\n</proposed_plan>\n```\n~~~\n<proposed_plan>\ntilde\n</proposed_plan>\n~~~\n**Real plan**\n",
			),
			fauxText("Epilogue"),
		]);
	});

	it.each([
		["empty", "<proposed_plan>\n \t\n</proposed_plan>"],
		["repeated", "<proposed_plan>\none\n</proposed_plan>\n<proposed_plan>\ntwo\n</proposed_plan>"],
		["nested", "<proposed_plan>\none\n<proposed_plan>\ntwo\n</proposed_plan>\n</proposed_plan>"],
		["reversed", "</proposed_plan>\nplan\n<proposed_plan>"],
		["indented", " <proposed_plan>\nplan\n</proposed_plan>"],
		["opening tag with extra text", "<proposed_plan> extra\nplan\n</proposed_plan>"],
		["closing tag with extra text", "<proposed_plan>\nplan\n</proposed_plan> extra"],
		["fenced only", "```\n<proposed_plan>\nplan\n</proposed_plan>\n```"],
		["unclosed", "<proposed_plan>\nplan"],
	])("rejects %s markup without changing it", (_name, text) => {
		const message = fauxAssistantMessage(text);

		expect(parseFinalizedPlanResponse(message)).toBeUndefined();
		expect(getMessageText(message)).toBe(text);
	});

	it("rejects tags split across text content items", () => {
		const message = fauxAssistantMessage([
			fauxText("<proposed_plan>\nplan"),
			fauxText("continued\n</proposed_plan>"),
		]);

		expect(parseFinalizedPlanResponse(message)).toBeUndefined();
	});

	it.each(["error", "length", "aborted"] as const)("rejects a %s response", (stopReason) => {
		const message = fauxAssistantMessage(validPlan, { stopReason });

		expect(parseFinalizedPlanResponse(message)).toBeUndefined();
		expect(getMessageText(message)).toBe(validPlan);
	});
});

describe("AgentSession finalized Plan response lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function createPlanHarness(
		options?: Pick<HarnessOptions, "models" | "settings"> & { extensionFactories?: ExtensionFactory[] },
	): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		expect(setCollaborationMode(harness.session, "plan")).toEqual({ status: "changed", mode: "plan" });
		return harness;
	}

	it("parses extension replacement before public listeners and persistence", async () => {
		const observations: string[] = [];
		let harness!: Harness;
		harness = await createPlanHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						observations.push(`extension:${getMessageText(event.message)}`);
						return {
							message: {
								...event.message,
								content: [{ type: "text", text: validPlan }],
							},
						};
					});
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			observations.push(`public:${getMessageText(event.message)}`);
			observations.push(`persisted:${getPersistedAssistantTexts(harness).length}`);
		});
		harness.setResponses([fauxAssistantMessage("draft")]);

		await harness.session.prompt("plan it");

		expect(observations).toEqual([`extension:draft`, `public:${cleanPlan}`, "persisted:0"]);
		expect(getAssistantTexts(harness)).toEqual([cleanPlan]);
		expect(getPersistedAssistantTexts(harness)).toEqual([cleanPlan]);
		expect(getMessageText(harness.eventsOfType("turn_end")[0]?.message)).toBe(cleanPlan);
		expect(
			getMessageText(harness.eventsOfType("agent_end")[0]?.messages.find((message) => message.role === "assistant")),
		).toBe(cleanPlan);
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", planHandoff: { plan: "# Plan\n\n1. Do it\n" } },
		]);
	});

	it("leaves valid-looking Default markup unchanged and ineligible", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(validPlan)]);

		await harness.session.prompt("answer normally");

		expect(getAssistantTexts(harness)).toEqual([validPlan]);
		expect(getPersistedAssistantTexts(harness)).toEqual([validPlan]);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled" }]);
	});

	it("leaves invalid Plan markup unchanged and ineligible", async () => {
		const harness = await createPlanHarness();
		const invalid = "<proposed_plan> extra\n# Not official\n</proposed_plan>";
		harness.setResponses([fauxAssistantMessage(invalid)]);

		await harness.session.prompt("plan it");

		expect(getAssistantTexts(harness)).toEqual([invalid]);
		expect(getPersistedAssistantTexts(harness)).toEqual([invalid]);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled" }]);
	});

	it("uses only the latest terminal assistant response after queued continuation", async () => {
		const harness = await createPlanHarness();
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		harness.setResponses([
			async () => {
				markFirstStarted();
				await firstReleased;
				return fauxAssistantMessage(validPlan);
			},
			fauxAssistantMessage("A newer ordinary response"),
		]);

		const prompt = harness.session.prompt("plan it");
		await firstStarted;
		await harness.session.followUp("one more constraint");
		releaseFirst();
		await prompt;

		expect(getAssistantTexts(harness)).toEqual([cleanPlan, "A newer ordinary response"]);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled" }]);
	});

	it("emits only the retry's final valid response as settled eligibility", async () => {
		const harness = await createPlanHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage(validPlan, { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(validPlan),
		]);

		await harness.session.prompt("plan it");

		expect(getAssistantTexts(harness)).toEqual([cleanPlan]);
		expect(getPersistedAssistantTexts(harness)).toEqual([validPlan, cleanPlan]);
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", planHandoff: { plan: "# Plan\n\n1. Do it\n" } },
		]);
	});

	it("waits through overflow compaction and uses the retry's final response", async () => {
		const harness = await createPlanHarness({
			models: [{ id: "faux-1", contextWindow: 1_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(validPlan, { stopReason: "length" }),
			fauxAssistantMessage(validPlan),
		]);

		await harness.session.prompt("x".repeat(5_000));

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(getAssistantTexts(harness).at(-1)).toBe(cleanPlan);
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", planHandoff: { plan: "# Plan\n\n1. Do it\n" } },
		]);
	});

	it("retains eligibility across successful threshold compaction before settlement", async () => {
		const harness = await createPlanHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "threshold compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage(validPlan)]);

		await harness.session.prompt("plan it");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", planHandoff: { plan: "# Plan\n\n1. Do it\n" } },
		]);
	});

	it("does not replay settled eligibility into the next logical run", async () => {
		const harness = await createPlanHarness();
		harness.setResponses([fauxAssistantMessage(validPlan), fauxAssistantMessage("ordinary")]);

		await harness.session.prompt("plan it");
		await harness.session.prompt("continue planning");

		expect(harness.eventsOfType("agent_settled")).toEqual([
			{ type: "agent_settled", planHandoff: { plan: "# Plan\n\n1. Do it\n" } },
			{ type: "agent_settled" },
		]);
	});
});
