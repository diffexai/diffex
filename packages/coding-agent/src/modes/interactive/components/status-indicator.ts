import { type Component, getGlyphs, Loader, type LoaderIndicatorOptions, type TUI } from "@diffexai/diffex-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { formatDiffexPathPrefix } from "./diffex-path.ts";
import { keyText } from "./keybinding-hints.ts";
import { createSpinnerVerbSequence } from "./spinner-verbs.ts";

const SPINNER_VERB_CHANGE_INTERVAL_MS = 5000;

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary" | "subagentWait";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	override setIndicator(indicator?: LoaderIndicatorOptions): void {
		const indicatorPrefix = indicator?.prefix;
		super.setIndicator({
			...indicator,
			prefix: () =>
				`${formatDiffexPathPrefix("start")}${
					typeof indicatorPrefix === "function" ? indicatorPrefix() : (indicatorPrefix ?? "")
				}`,
		});
	}

	setOutputPad(padding: number): void {
		this.setPaddingX(padding);
	}

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	private readonly nextSpinnerVerb: () => string;
	private currentSpinnerVerb: string;
	private verbAnimationIntervalId: NodeJS.Timeout | undefined;

	constructor(ui: TUI, message?: string, indicator?: WorkingIndicatorOptions) {
		const nextSpinnerVerb = createSpinnerVerbSequence();
		const initialSpinnerVerb = message === undefined ? nextSpinnerVerb() : "";
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message ?? `${initialSpinnerVerb}...`,
			indicator,
		);
		this.nextSpinnerVerb = nextSpinnerVerb;
		this.currentSpinnerVerb = initialSpinnerVerb;
		if (message === undefined) {
			this.startVerbAnimation(false);
		}
	}

	setWorkingMessage(message?: string): void {
		if (message !== undefined) {
			this.stopVerbAnimation();
			this.setMessage(message);
			return;
		}
		this.startVerbAnimation(true);
	}

	override dispose(): void {
		this.stopVerbAnimation();
		super.dispose();
	}

	private startVerbAnimation(updateImmediately: boolean): void {
		this.stopVerbAnimation();
		if (updateImmediately) {
			this.currentSpinnerVerb = this.nextSpinnerVerb();
			this.setMessage(`${this.currentSpinnerVerb}...`);
		}
		this.verbAnimationIntervalId = setInterval(() => {
			this.currentSpinnerVerb = this.nextSpinnerVerb();
			this.setMessage(`${this.currentSpinnerVerb}...`);
		}, SPINNER_VERB_CHANGE_INTERVAL_MS);
	}

	private stopVerbAnimation(): void {
		if (this.verbAnimationIntervalId !== undefined) {
			clearInterval(this.verbAnimationIntervalId);
			this.verbAnimationIntervalId = undefined;
		}
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const separator = ` ${getGlyphs().bullet} `;
		const retryMessage = (seconds: number) =>
			`Retry ${attempt}/${maxAttempts} in ${seconds}s${separator}${keyText("app.interrupt")} cancel`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow";

export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `${getGlyphs().bullet} ${keyText("app.interrupt")} cancel`;
		const label =
			reason === "manual"
				? `Compacting context ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow" : "Auto-compacting context"} ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		const glyphs = getGlyphs();
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch ${glyphs.bullet} ${keyText("app.interrupt")} cancel`,
		);
	}
}

export class SubagentWaitStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, count: number) {
		const glyphs = getGlyphs();
		const label = count === 1 ? "Waiting for subagent" : `Waiting for ${count} subagents`;
		super(
			"subagentWait",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`${label} ${glyphs.bullet} ${keyText("app.interrupt")} cancel`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine];
	}
}
