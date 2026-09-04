import { Container, Text } from "@earendil-works/diffex-tui";
import { Type } from "typebox";
import { RequestUserInputComponent } from "../../modes/interactive/components/request-user-input.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, invalidArgText } from "./render-utils.ts";

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

export interface RequestUserInputOption {
	label: string;
	description: string;
}

export interface RequestUserInputQuestion {
	id: string;
	header: string;
	question: string;
	options: RequestUserInputOption[];
}

export interface RequestUserInputToolInput {
	questions: RequestUserInputQuestion[];
}

export interface RequestUserInputAnswer {
	value: string;
	source: "option" | "free_form";
}

export type RequestUserInputResult =
	| { status: "answered"; answers: Record<string, RequestUserInputAnswer> }
	| { status: "cancelled" };

const optionSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, description: "User-facing label." }),
		description: Type.String({ minLength: 1, description: "One short sentence explaining the impact or tradeoff." }),
	},
	{ additionalProperties: false },
);

const questionSchema = Type.Object(
	{
		id: Type.String({
			maxLength: 64,
			pattern: "^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$",
			description: "Stable identifier used as the answer key.",
		}),
		header: Type.String({ minLength: 1, maxLength: 12, description: "Short header label." }),
		question: Type.String({ minLength: 1, description: "Question shown to the user." }),
		options: Type.Array(optionSchema, { minItems: 2, maxItems: 3 }),
	},
	{ additionalProperties: false },
);

const requestUserInputSchema = Type.Object(
	{
		questions: Type.Array(questionSchema, { minItems: 1, maxItems: 3 }),
	},
	{ additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnexpectedFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
	const unexpected = Reflect.ownKeys(value).find((key) => typeof key !== "string" || !allowed.includes(key));
	if (unexpected !== undefined) throw new Error(`${subject} contains unexpected field: ${String(unexpected)}.`);
}

function trimmedNonEmpty(value: unknown, subject: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`${subject} must be a non-empty string.`);
	return value.trim();
}

export function parseRequestUserInput(input: unknown): RequestUserInputToolInput {
	if (!isRecord(input)) throw new Error("request_user_input input must be an object.");
	rejectUnexpectedFields(input, ["questions"], "request_user_input input");
	if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 3) {
		throw new Error("request_user_input requires one to three questions.");
	}

	const ids = new Set<string>();
	const questions = input.questions.map((rawQuestion, questionIndex): RequestUserInputQuestion => {
		const subject = `Question ${questionIndex + 1}`;
		if (!isRecord(rawQuestion)) throw new Error(`${subject} must be an object.`);
		rejectUnexpectedFields(rawQuestion, ["id", "header", "question", "options"], subject);

		if (
			typeof rawQuestion.id !== "string" ||
			rawQuestion.id.length > 64 ||
			!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(rawQuestion.id)
		) {
			throw new Error(
				`${subject} id must match ^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$ and be at most 64 ASCII characters.`,
			);
		}
		if (ids.has(rawQuestion.id)) throw new Error(`Duplicate question id: ${rawQuestion.id}.`);
		ids.add(rawQuestion.id);

		const header = trimmedNonEmpty(rawQuestion.header, `${subject} header`);
		if ([...header].length > 12) throw new Error(`${subject} header must be at most 12 characters.`);
		const question = trimmedNonEmpty(rawQuestion.question, `${subject} question`);
		if (!Array.isArray(rawQuestion.options) || rawQuestion.options.length < 2 || rawQuestion.options.length > 3) {
			throw new Error(`${subject} must contain two or three options.`);
		}

		const labels = new Set<string>();
		const options = rawQuestion.options.map((rawOption, optionIndex): RequestUserInputOption => {
			const optionSubject = `${subject} option ${optionIndex + 1}`;
			if (!isRecord(rawOption)) throw new Error(`${optionSubject} must be an object.`);
			rejectUnexpectedFields(rawOption, ["label", "description"], optionSubject);
			const label = trimmedNonEmpty(rawOption.label, `${optionSubject} label`);
			const foldedLabel = label.toLowerCase();
			if (foldedLabel === "other") throw new Error(`${optionSubject} label is reserved: Other.`);
			if (labels.has(foldedLabel)) throw new Error(`${subject} option labels must be unique ignoring case.`);
			labels.add(foldedLabel);
			return {
				label,
				description: trimmedNonEmpty(rawOption.description, `${optionSubject} description`),
			};
		});

		return { id: rawQuestion.id, header, question, options };
	});

	return { questions };
}

function formatResult(result: RequestUserInputResult): string {
	if (result.status === "cancelled") return "User cancelled the questions.";
	return Object.entries(result.answers)
		.map(([id, answer]) => `${id}: ${answer.value} (${answer.source})`)
		.join("\n");
}

export function createRequestUserInputToolDefinition(): ToolDefinition<
	typeof requestUserInputSchema,
	RequestUserInputResult | undefined
> {
	return {
		name: REQUEST_USER_INPUT_TOOL_NAME,
		label: REQUEST_USER_INPUT_TOOL_NAME,
		description:
			"Ask one to three structured questions. Explain the context first, use mutually exclusive options, and put the recommended option first with a (Recommended) suffix.",
		parameters: requestUserInputSchema,
		executionMode: "sequential",
		async execute(_toolCallId, rawInput, signal, _onUpdate, ctx) {
			const input = parseRequestUserInput(rawInput);
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "request_user_input is unavailable without interactive UI." }],
					details: undefined,
					isError: true,
				};
			}
			if (signal?.aborted) {
				const details = { status: "cancelled" } as const;
				return { content: [{ type: "text", text: formatResult(details) }], details };
			}

			const details = await ctx.ui.custom<RequestUserInputResult>((tui, dialogTheme, _keybindings, done) => {
				const onAbort = (): void => done({ status: "cancelled" });
				signal?.addEventListener("abort", onAbort, { once: true });
				return new RequestUserInputComponent(tui, dialogTheme, input.questions, done, () => {
					signal?.removeEventListener("abort", onAbort);
				});
			});
			return { content: [{ type: "text", text: formatResult(details) }], details };
		},
		renderCall(args, theme, context) {
			let text = theme.fg("toolTitle", theme.bold(REQUEST_USER_INPUT_TOOL_NAME));
			try {
				const input = parseRequestUserInput(args);
				text += ` ${theme.fg("muted", `${input.questions.length} question${input.questions.length === 1 ? "" : "s"}`)}`;
				for (const question of input.questions)
					text += `\n${theme.fg("toolOutput", `${question.header}: ${question.question}`)}`;
			} catch {
				if (context.argsComplete || context.executionStarted || context.isError)
					text += `\n${invalidArgText(theme)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError)
				return new Text(`\n${theme.fg("error", getTextOutput(result, context.showImages))}`, 0, 0);
			if (result.details?.status === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			if (result.details?.status === "answered") {
				return new Text(
					Object.entries(result.details.answers)
						.map(([id, answer]) => `${theme.fg("success", "[x]")} ${theme.fg("accent", id)}: ${answer.value}`)
						.join("\n"),
					0,
					0,
				);
			}
			return new Container();
		},
	};
}
