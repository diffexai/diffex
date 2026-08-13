import { type Component, Loader, type TUI } from "@earendil-works/diffex-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";
import { createSpinnerVerbSequence } from "./spinner-verbs.ts";

const SPINNER_VERB_CHANGE_INTERVAL_MS = 5000;
const SPINNER_VERB_DOT_INTERVAL_MS = 500;
const SPINNER_VERB_CHANGE_TICKS = SPINNER_VERB_CHANGE_INTERVAL_MS / SPINNER_VERB_DOT_INTERVAL_MS;

export type StatusIndicatorKind =
	| "working"
	| "taskBoundary"
	| "retry"
	| "compaction"
	| "branchSummary"
	| "subagentWait";

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

	dispose(): void {
		this.stop();
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	private readonly nextSpinnerVerb: () => string;
	private currentSpinnerVerb: string;
	private verbAnimationIntervalId: NodeJS.Timeout | undefined;
	private verbAnimationTick = 0;

	constructor(ui: TUI, message?: string, indicator?: WorkingIndicatorOptions) {
		const nextSpinnerVerb = createSpinnerVerbSequence();
		const initialSpinnerVerb = message === undefined ? nextSpinnerVerb() : "";
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message ?? `${initialSpinnerVerb}.`,
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
			this.verbAnimationTick = 0;
			this.setMessage(`${this.currentSpinnerVerb}.`);
		}
		this.verbAnimationIntervalId = setInterval(() => {
			this.verbAnimationTick += 1;
			if (this.verbAnimationTick === SPINNER_VERB_CHANGE_TICKS) {
				this.currentSpinnerVerb = this.nextSpinnerVerb();
				this.verbAnimationTick = 0;
			}
			const dots = ".".repeat((this.verbAnimationTick % 3) + 1);
			this.setMessage(`${this.currentSpinnerVerb}${dots}`);
		}, SPINNER_VERB_DOT_INTERVAL_MS);
	}

	private stopVerbAnimation(): void {
		if (this.verbAnimationIntervalId !== undefined) {
			clearInterval(this.verbAnimationIntervalId);
			this.verbAnimationIntervalId = undefined;
		}
	}
}

export class TaskBoundaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string) {
		super(
			"taskBoundary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
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
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
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
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class SubagentWaitStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, count: number) {
		const label = count === 1 ? "Waiting for subagent" : `Waiting for ${count} subagents`;
		super(
			"subagentWait",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`${label}... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
