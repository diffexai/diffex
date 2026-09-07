import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	markActiveRow,
	SELECTED_LIST_PREFIX,
	type TUI,
	UNSELECTED_LIST_PREFIX,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/diffex-tui";
import type {
	RequestUserInputAnswer,
	RequestUserInputQuestion,
	RequestUserInputResult,
} from "../../../core/tools/request-user-input.ts";
import type { Theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

const OTHER_LABEL = "Other";

export class RequestUserInputComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly questions: readonly RequestUserInputQuestion[];
	private readonly done: (result: RequestUserInputResult) => void;
	private readonly onDispose: (() => void) | undefined;
	private readonly answers = new Map<string, RequestUserInputAnswer>();
	private readonly optionIndices: number[];
	private readonly input = new Input();
	private questionIndex = 0;
	private inputMode = false;
	private blankInput = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		questions: readonly RequestUserInputQuestion[],
		done: (result: RequestUserInputResult) => void,
		onDispose?: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.questions = questions;
		this.done = done;
		this.onDispose = onDispose;
		this.optionIndices = questions.map(() => 0);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.inputMode;
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private allAnswered(): boolean {
		return this.questions.every((question) => this.answers.has(question.id));
	}

	private moveQuestion(offset: number): void {
		this.inputMode = false;
		this.blankInput = false;
		this.input.setValue("");
		const tabCount = this.questions.length + 1;
		this.questionIndex = (this.questionIndex + offset + tabCount) % tabCount;
		this.refresh();
	}

	private advanceAfterAnswer(): void {
		this.inputMode = false;
		this.blankInput = false;
		this.input.setValue("");
		this.questionIndex = Math.min(this.questionIndex + 1, this.questions.length);
		this.refresh();
	}

	private submit(): void {
		if (!this.allAnswered()) return;
		const answers = Object.create(null) as Record<string, RequestUserInputAnswer>;
		for (const question of this.questions) {
			const answer = this.answers.get(question.id);
			if (answer) answers[question.id] = { ...answer };
		}
		this.done({ status: "answered", answers });
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.done({ status: "cancelled" });
			return;
		}

		if (this.inputMode) {
			if (keybindings.matches(data, "tui.input.submit")) {
				const value = this.input.getValue().trim();
				if (value.length === 0) {
					this.blankInput = true;
					this.refresh();
					return;
				}
				const question = this.questions[this.questionIndex];
				if (question) this.answers.set(question.id, { value, source: "free_form" });
				this.advanceAfterAnswer();
				return;
			}
			this.blankInput = false;
			this.input.handleInput(data);
			this.refresh();
			return;
		}

		if (keybindings.matches(data, "tui.select.pageUp")) {
			this.moveQuestion(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown")) {
			this.moveQuestion(1);
			return;
		}

		if (this.questionIndex === this.questions.length) {
			if (keybindings.matches(data, "tui.select.confirm")) this.submit();
			return;
		}

		const question = this.questions[this.questionIndex];
		if (!question) return;
		const optionCount = question.options.length + 1;
		if (keybindings.matches(data, "tui.select.up")) {
			this.optionIndices[this.questionIndex] = Math.max(0, this.optionIndices[this.questionIndex]! - 1);
			this.refresh();
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.optionIndices[this.questionIndex] = Math.min(
				optionCount - 1,
				this.optionIndices[this.questionIndex]! + 1,
			);
			this.refresh();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			const optionIndex = this.optionIndices[this.questionIndex]!;
			if (optionIndex === question.options.length) {
				this.inputMode = true;
				this.blankInput = false;
				this.input.setValue("");
				this.input.focused = this.focused;
				this.refresh();
				return;
			}
			const option = question.options[optionIndex];
			if (option) this.answers.set(question.id, { value: option.label, source: "option" });
			this.advanceAfterAnswer();
		}
	}

	override render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const addWrapped = (prefix: string, text: string): void => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				lines.push(...wrapTextWithAnsi(`${prefix}${text}`, renderWidth));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
			}
		};

		const tabs = this.questions.map((question, index) => {
			const marker = this.answers.has(question.id) ? "[x]" : "[ ]";
			const label = `${marker} ${question.header}`;
			return index === this.questionIndex ? this.theme.fg("selectionAccent", label) : this.theme.fg("muted", label);
		});
		const submitLabel = this.allAnswered() ? "[Submit]" : "[Submit incomplete]";
		tabs.push(
			this.questionIndex === this.questions.length
				? this.theme.fg("selectionAccent", submitLabel)
				: this.theme.fg(this.allAnswered() ? "success" : "dim", submitLabel),
		);
		addWrapped(" ", tabs.join("  "));
		lines.push("");

		if (this.questionIndex === this.questions.length) {
			addWrapped(" ", this.theme.fg("accent", this.theme.bold("Review answers")));
			for (const question of this.questions) {
				const answer = this.answers.get(question.id);
				addWrapped(
					" ",
					`${this.theme.fg("muted", `${question.header}:`)} ${answer ? answer.value : this.theme.fg("warning", "Unanswered")}`,
				);
			}
			lines.push("");
			addWrapped(
				" ",
				this.allAnswered()
					? `${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.pageUp", "previous")}  ${keyHint("tui.select.pageDown", "next")}  ${keyHint("tui.select.cancel", "cancel")}`
					: this.theme.fg("warning", "Answer every question before submitting"),
			);
			return lines;
		}

		const question = this.questions[this.questionIndex];
		if (!question) return lines;
		addWrapped(" ", this.theme.fg("accent", this.theme.bold(question.header)));
		addWrapped(" ", this.theme.fg("text", question.question));
		lines.push("");
		const options = [...question.options, { label: OTHER_LABEL, description: "Type a different answer." }];
		for (let index = 0; index < options.length; index++) {
			const option = options[index]!;
			const selected = index === this.optionIndices[this.questionIndex];
			const prefix = selected
				? markActiveRow(this.theme.fg("selectionAccent", SELECTED_LIST_PREFIX))
				: UNSELECTED_LIST_PREFIX;
			addWrapped(prefix, this.theme.fg(selected ? "selectionAccent" : "text", option.label));
			addWrapped("    ", this.theme.fg("muted", option.description));
		}

		if (this.inputMode) {
			lines.push("");
			addWrapped(" ", this.theme.fg("muted", "Your answer:"));
			for (const line of this.input.render(Math.max(1, renderWidth - 1))) lines.push(` ${line}`);
			if (this.blankInput) addWrapped(" ", this.theme.fg("warning", "Enter a non-blank answer."));
		}
		lines.push("");
		addWrapped(
			" ",
			this.theme.fg(
				"dim",
				this.inputMode
					? `${keyHint("tui.input.submit", "answer")}  ${keyHint("tui.select.cancel", "cancel")}`
					: `${keyHint("tui.select.up", "select")}  ${keyHint("tui.select.confirm", "answer")}  ${keyHint("tui.select.pageUp", "previous")}  ${keyHint("tui.select.pageDown", "next")}  ${keyHint("tui.select.cancel", "cancel")}`,
			),
		);
		return lines;
	}

	dispose(): void {
		this.onDispose?.();
	}
}
