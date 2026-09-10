/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import {
	Container,
	getKeybindings,
	markActiveRow,
	SELECTED_LIST_PREFIX,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	UNSELECTED_LIST_PREFIX,
} from "@diffexai/diffex-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private hintText: Text;
	private baseTitle: string;
	private displayTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private tui: TUI | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.displayTitle = title;
		this.tui = opts?.tui;

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => {
					const [firstLine = "", ...remainingLines] = this.baseTitle.split("\n");
					this.setTitle([`${firstLine} (${s}s)`, ...remainingLines].join("\n"));
				},
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.hintText = new Text(
			rawKeyHint("↑↓", "navigate") +
				"  " +
				keyHint("tui.select.confirm", "select") +
				"  " +
				keyHint("tui.select.cancel", "cancel"),
			1,
			0,
		);
		this.addChild(this.hintText);

		this.updateList();
	}

	override render(width: number): string[] {
		const rows = this.tui?.terminal.rows;
		if (rows === undefined || rows > 12) {
			return super.render(width);
		}

		const renderHeight = Math.max(1, rows);
		const sourceLines = this.displayTitle.split("\n");
		const descriptionStart = sourceLines.findIndex((line) => line.trim().length === 0);
		const titleCandidates = (descriptionStart === -1 ? sourceLines : sourceLines.slice(0, descriptionStart)).filter(
			(line) => line.trim().length > 0,
		);
		const titleLimit = Math.max(1, Math.min(2, renderHeight - 1));
		const titleLines = titleCandidates
			.slice(0, titleLimit)
			.map((line) => truncateToWidth(theme.fg("accent", theme.bold(` ${line}`)), width, ""));
		const hintLine = this.hintText.render(width)[0];
		const hintLines = hintLine === undefined || renderHeight === 1 ? [] : [hintLine];
		let remainingRows = Math.max(0, renderHeight - titleLines.length - hintLines.length);
		const spareRows = Math.max(0, remainingRows - this.options.length);
		const leadingSpacer = spareRows > 0;
		const trailingSpacer = spareRows > 1;
		remainingRows -= Number(leadingSpacer) + Number(trailingSpacer);

		const visibleCount = Math.min(this.options.length, remainingRows);
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.options.length - visibleCount),
		);
		const optionLines = Array.from({ length: visibleCount }, (_, offset) =>
			truncateToWidth(` ${this.getOptionText(startIndex + offset)}`, width, ""),
		);

		return [
			...titleLines,
			...(leadingSpacer ? [""] : []),
			...optionLines,
			...(trailingSpacer ? [""] : []),
			...hintLines,
		];
	}

	private setTitle(title: string): void {
		this.displayTitle = title;
		this.titleText.setText(theme.fg("accent", theme.bold(title)));
	}

	private getOptionText(index: number): string {
		const isSelected = index === this.selectedIndex;
		return isSelected
			? markActiveRow(theme.fg("selectionAccent", SELECTED_LIST_PREFIX)) +
					theme.fg("selectionAccent", this.options[index] ?? "")
			: `${UNSELECTED_LIST_PREFIX}${theme.fg("text", this.options[index] ?? "")}`;
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			this.listContainer.addChild(new Text(this.getOptionText(i), 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
