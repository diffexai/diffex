import type { Component, TUI } from "@diffexai/diffex-tui";
import { setKeybindings, visibleWidth } from "@diffexai/diffex-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	createRequestUserInputToolDefinition,
	parseRequestUserInput,
	type RequestUserInputQuestion,
	type RequestUserInputResult,
	type RequestUserInputToolInput,
} from "../src/core/tools/request-user-input.ts";
import { RequestUserInputComponent } from "../src/modes/interactive/components/request-user-input.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const question = (id = "scope", header = "Scope"): RequestUserInputQuestion => ({
	id,
	header,
	question: "Which implementation scope should the plan use?",
	options: [
		{ label: "Focused (Recommended)", description: "Changes only the requested behavior." },
		{ label: "Broad", description: "Also refactors adjacent behavior." },
	],
});

function fakeTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

function createDialog(questions: readonly RequestUserInputQuestion[]): {
	component: RequestUserInputComponent;
	results: RequestUserInputResult[];
} {
	const results: RequestUserInputResult[] = [];
	return {
		component: new RequestUserInputComponent(fakeTui(), theme, questions, (result) => results.push(result)),
		results,
	};
}

function renderPlain(component: Component, width = 80): string[] {
	return component.render(width).map(stripAnsi);
}

async function executeWithDialog(
	input: RequestUserInputToolInput,
	drive: (component: RequestUserInputComponent) => void,
) {
	const tui = fakeTui();
	const context = {
		mode: "tui",
		ui: {
			custom: async (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: RequestUserInputResult) => void,
				) => Component,
			) => {
				let result: RequestUserInputResult | undefined;
				const component = factory(tui, theme, new KeybindingsManager(), (value) => {
					result = value;
				});
				drive(component as RequestUserInputComponent);
				if (!result) throw new Error("Dialog did not finish");
				return result;
			},
		},
	} as unknown as ExtensionContext;
	return createRequestUserInputToolDefinition().execute("question-1", input, undefined, undefined, context);
}

describe("request_user_input tool", () => {
	beforeEach(() => {
		initTheme("dark", false);
		setKeybindings(new KeybindingsManager());
	});

	it("publishes the exact bounded object schema and sequential execution", () => {
		const definition = createRequestUserInputToolDefinition();
		const schema = definition.parameters as {
			additionalProperties?: boolean;
			properties?: {
				questions?: {
					minItems?: number;
					maxItems?: number;
					items?: {
						additionalProperties?: boolean;
						properties?: {
							id?: { maxLength?: number; pattern?: string };
							header?: { maxLength?: number };
							options?: { minItems?: number; maxItems?: number; items?: { additionalProperties?: boolean } };
						};
					};
				};
			};
		};

		expect(definition.name).toBe("request_user_input");
		expect(definition.executionMode).toBe("sequential");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties?.questions?.minItems).toBe(1);
		expect(schema.properties?.questions?.maxItems).toBe(3);
		expect(schema.properties?.questions?.items?.additionalProperties).toBe(false);
		expect(schema.properties?.questions?.items?.properties?.id).toMatchObject({
			maxLength: 64,
			pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
		});
		expect(schema.properties?.questions?.items?.properties?.header?.maxLength).toBe(12);
		expect(schema.properties?.questions?.items?.properties?.options).toMatchObject({ minItems: 2, maxItems: 3 });
		expect(schema.properties?.questions?.items?.properties?.options?.items?.additionalProperties).toBe(false);
	});

	it("normalizes trimmed content while retaining a prototype-sensitive valid id", () => {
		const parsed = parseRequestUserInput({
			questions: [
				{
					...question("constructor"),
					header: "  Scope  ",
					question: "  Choose a scope.  ",
					options: [
						{ label: "  Focused  ", description: "  Minimal change.  " },
						{ label: "Broad", description: "Larger change." },
					],
				},
			],
		});

		expect(parsed).toEqual({
			questions: [
				{
					id: "constructor",
					header: "Scope",
					question: "Choose a scope.",
					options: [
						{ label: "Focused", description: "Minimal change." },
						{ label: "Broad", description: "Larger change." },
					],
				},
			],
		});
	});

	it.each([
		[{}, "one to three questions"],
		[{ questions: [] }, "one to three questions"],
		[{ questions: [question("a"), question("b"), question("c"), question("d")] }, "one to three questions"],
		[{ questions: [question("UPPER")] }, "id must match"],
		[{ questions: [question("has-dash")] }, "id must match"],
		[{ questions: [question("a".repeat(65))] }, "at most 64"],
		[{ questions: [question("same"), question("same")] }, "Duplicate question id"],
		[{ questions: [{ ...question(), header: "   " }] }, "header must be a non-empty"],
		[{ questions: [{ ...question(), header: "Thirteen chars" }] }, "header must be at most 12"],
		[{ questions: [{ ...question(), question: "\t" }] }, "question must be a non-empty"],
		[{ questions: [{ ...question(), options: [question().options[0]] }] }, "two or three options"],
		[
			{ questions: [{ ...question(), options: [...question().options, ...question().options] }] },
			"two or three options",
		],
		[
			{
				questions: [
					{ ...question(), options: [question().options[0], { ...question().options[1], label: "other" }] },
				],
			},
			"label is reserved",
		],
		[
			{
				questions: [
					{
						...question(),
						options: [question().options[0], { ...question().options[1], label: " focused (recommended) " }],
					},
				],
			},
			"labels must be unique",
		],
	])("rejects invalid bounded input %#", (input, message) => {
		expect(() => parseRequestUserInput(input)).toThrow(message);
	});

	it.each([
		[{ questions: [question()], extra: true }, "request_user_input input contains unexpected field"],
		[{ questions: [{ ...question(), extra: true }] }, "Question 1 contains unexpected field"],
		[
			{
				questions: [{ ...question(), options: [{ ...question().options[0], extra: true }, question().options[1]] }],
			},
			"Question 1 option 1 contains unexpected field",
		],
		[
			{ questions: [{ ...question(), options: [{ label: "A", description: " " }, question().options[1]] }] },
			"description must be a non-empty",
		],
	])("rejects unexpected and missing content %#", (input, message) => {
		expect(() => parseRequestUserInput(input)).toThrow(message);
	});

	it("returns the normal unavailable result without TUI support", async () => {
		const context = { mode: "print" } as unknown as ExtensionContext;
		await expect(
			createRequestUserInputToolDefinition().execute(
				"question-1",
				{ questions: [question()] },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("request_user_input is unavailable without interactive UI.");
	});

	it("renders descriptions and synthetic Other while wrapping narrow output", () => {
		const { component } = createDialog([question()]);
		const output = renderPlain(component, 24);

		expect(output.join("\n")).toContain("Changes only the");
		expect(output.join("\n")).toContain("Other");
		expect(output.join("\n")).toContain("Type a different");
		expect(output.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	it("preserves answers and navigation across three questions and submits exact prototype-safe details", async () => {
		const questions = [
			question("constructor", "Scope"),
			question("delivery", "Delivery"),
			question("tests", "Tests"),
		];
		const result = await executeWithDialog({ questions }, (component) => {
			component.handleInput("\r");
			component.handleInput("\x1b[B");
			component.handleInput("\r");
			component.handleInput("\r");
			component.handleInput("\x1b[5~");
			component.handleInput("\x1b[5~");
			expect(renderPlain(component).join("\n")).toContain("[x] Scope");
			component.handleInput("\x1b[6~");
			component.handleInput("\x1b[6~");
			component.handleInput("\r");
		});

		expect(result.details?.status).toBe("answered");
		if (result.details?.status !== "answered") return;
		expect(Object.getPrototypeOf(result.details.answers)).toBeNull();
		expect(result.details.answers).toEqual({
			constructor: { value: "Focused (Recommended)", source: "option" },
			delivery: { value: "Broad", source: "option" },
			tests: { value: "Focused (Recommended)", source: "option" },
		});
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("constructor: Focused");
	});

	it("rejects blank free-form input, trims an answer, and requires complete submission", () => {
		const { component, results } = createDialog([question("scope"), question("delivery")]);
		component.handleInput("\x1b[6~");
		component.handleInput("\x1b[6~");
		component.handleInput("\r");
		expect(results).toEqual([]);
		component.handleInput("\x1b[5~");
		component.handleInput("\x1b[5~");
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		component.handleInput("   ");
		component.handleInput("\r");
		expect(results).toEqual([]);
		expect(renderPlain(component).join("\n")).toContain("Enter a non-blank answer.");
		component.handleInput(" custom answer ");
		component.handleInput("\r");
		component.handleInput("\x1b[6~");
		expect(renderPlain(component).join("\n")).toContain("custom answer");
		component.handleInput("\x1b[5~");
		component.handleInput("\r");
		component.handleInput("\r");
		expect(results).toEqual([
			{
				status: "answered",
				answers: {
					scope: { value: "custom answer", source: "free_form" },
					delivery: { value: "Focused (Recommended)", source: "option" },
				},
			},
		]);
	});

	it("returns exact non-fatal cancellation from question and free-form views", async () => {
		const questionCancel = await executeWithDialog({ questions: [question()] }, (component) => {
			component.handleInput("\x1b");
		});
		const inputCancel = await executeWithDialog({ questions: [question()] }, (component) => {
			component.handleInput("\x1b[B");
			component.handleInput("\x1b[B");
			component.handleInput("\r");
			component.handleInput("\x1b");
		});

		for (const result of [questionCancel, inputCancel]) {
			expect(result.details).toEqual({ status: "cancelled" });
			expect(result).not.toHaveProperty("isError");
			expect(result.content).toEqual([{ type: "text", text: "User cancelled the questions." }]);
		}
	});
});
