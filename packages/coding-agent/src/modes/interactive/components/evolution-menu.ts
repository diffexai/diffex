import {
	Container,
	type Focusable,
	getKeybindings,
	SELECTED_LIST_PREFIX,
	Spacer,
	Text,
	TruncatedText,
	UNSELECTED_LIST_PREFIX,
} from "@earendil-works/diffex-tui";
import type {
	EvolutionJobDetail,
	EvolutionJobSummary,
	EvolutionOverview,
	EvolutionProgressEvent,
	EvolutionProposalDetail,
	EvolutionRollbackAction,
	EvolutionStartResult,
} from "#evolution";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface EvolutionMenuClient {
	subscribe(listener: (event: EvolutionProgressEvent) => void): () => void;
	overview(): Promise<EvolutionOverview>;
	listJobs(): Promise<readonly EvolutionJobSummary[]>;
	jobDetail(jobId: string): Promise<EvolutionJobDetail>;
	proposalDetail(jobId: string, proposalId: string): Promise<EvolutionProposalDetail>;
	startManual(): Promise<EvolutionStartResult>;
	resumeNewest(): Promise<EvolutionJobSummary>;
	cancelActive(): Promise<EvolutionJobSummary>;
	rollback(): Promise<EvolutionRollbackAction>;
}

type MenuView =
	| { readonly kind: "overview" }
	| { readonly kind: "jobs" }
	| { readonly kind: "job"; readonly jobId: string }
	| { readonly kind: "proposal"; readonly jobId: string; readonly proposalId: string }
	| { readonly kind: "confirm"; readonly action: "cancel" | "resume" | "rollback" | "start" };

interface MenuEntry {
	readonly label: string;
	readonly enabled: boolean;
	readonly disabledStatus?: string;
	readonly select: () => void;
}

export function sanitizeEvolutionText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

function abbreviate(value: string | null): string {
	if (value === null) return "none";
	const [algorithm, digest] = value.split(":", 2);
	return algorithm && digest ? `${algorithm}:${digest.slice(0, 12)}` : sanitizeEvolutionText(value);
}

function duration(milliseconds: number): string {
	if (milliseconds <= 0) return "ready";
	const minutes = Math.ceil(milliseconds / 60_000);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatEvolutionTimestamp(value: string | null, now = new Date()): string {
	if (value === null) return "never";
	const checkpoint = new Date(value);
	if (!Number.isFinite(checkpoint.getTime())) return sanitizeEvolutionText(value);
	const hours = checkpoint.getHours();
	const time = `${hours % 12 || 12}:${checkpoint.getMinutes().toString().padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
	const isToday =
		checkpoint.getFullYear() === now.getFullYear() &&
		checkpoint.getMonth() === now.getMonth() &&
		checkpoint.getDate() === now.getDate();
	return isToday ? `Today at ${time}` : `${checkpoint.getMonth() + 1}/${checkpoint.getDate()} at ${time}`;
}

export class EvolutionMenuComponent extends Container implements Focusable {
	readonly #client: EvolutionMenuClient;
	readonly #onClose: () => void;
	readonly #onStatus: (message: string, error: boolean) => void;
	readonly #requestRender: () => void;
	readonly #unsubscribe: () => void;
	readonly #pollIntervalMs: number;
	readonly #viewStack: MenuView[] = [{ kind: "overview" }];
	#overview: EvolutionOverview | null = null;
	#jobs: readonly EvolutionJobSummary[] = [];
	#job: EvolutionJobDetail | null = null;
	#proposal: EvolutionProposalDetail | null = null;
	#entries: readonly MenuEntry[] = [];
	#selectedIndex = 0;
	#loading = true;
	#disposed = false;
	#focused = false;
	#pollTimeout: ReturnType<typeof setTimeout> | null = null;
	#refreshPromise: Promise<void> | null = null;

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	constructor(
		client: EvolutionMenuClient,
		onClose: () => void,
		onStatus: (message: string, error: boolean) => void,
		requestRender: () => void,
		pollIntervalMs = 1_000,
	) {
		super();
		this.#client = client;
		this.#onClose = onClose;
		this.#onStatus = onStatus;
		this.#requestRender = requestRender;
		this.#pollIntervalMs = pollIntervalMs;
		this.#unsubscribe = client.subscribe(() => {
			void this.refresh();
		});
		this.rebuild();
		void this.refresh();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		if (this.#pollTimeout !== null) clearTimeout(this.#pollTimeout);
	}

	#view(): MenuView {
		return this.#viewStack[this.#viewStack.length - 1] ?? { kind: "overview" };
	}

	#push(view: MenuView): void {
		this.#viewStack.push(view);
		this.#selectedIndex = 0;
		void this.refresh();
	}

	#back(): void {
		if (this.#viewStack.length > 1) {
			this.#viewStack.pop();
			this.#selectedIndex = 0;
			void this.refresh();
			return;
		}
		this.dispose();
		this.#onClose();
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#refreshPromise !== null) return this.#refreshPromise;
		this.#refreshPromise = this.#refresh();
		return this.#refreshPromise;
	}

	async #refresh(): Promise<void> {
		this.#loading = true;
		this.rebuild();
		try {
			this.#overview = await this.#client.overview();
			const view = this.#view();
			if (view.kind === "jobs") this.#jobs = await this.#client.listJobs();
			if (view.kind === "job") this.#job = await this.#client.jobDetail(view.jobId);
			if (view.kind === "proposal") {
				this.#proposal = await this.#client.proposalDetail(view.jobId, view.proposalId);
			}
		} catch (error) {
			this.#onStatus(error instanceof Error ? error.message : String(error), true);
		} finally {
			this.#refreshPromise = null;
			this.#loading = false;
			this.rebuild();
			this.#requestRender();
			this.#schedulePoll();
		}
	}

	#schedulePoll(): void {
		if (this.#pollTimeout !== null) clearTimeout(this.#pollTimeout);
		this.#pollTimeout = null;
		if (this.#disposed || this.#overview === null || this.#overview.activeJob === null) return;
		this.#pollTimeout = setTimeout(() => {
			this.#pollTimeout = null;
			void this.refresh();
		}, this.#pollIntervalMs);
		const timeout = this.#pollTimeout as ReturnType<typeof setTimeout> & { unref?: () => void };
		timeout.unref?.();
	}

	#run<T>(action: () => Promise<T>, success: string | ((result: T) => string)): void {
		void action()
			.then((result) => {
				this.#onStatus(typeof success === "string" ? success : success(result), false);
				this.#viewStack.splice(1);
				return this.refresh();
			})
			.catch((error: unknown) => {
				this.#onStatus(error instanceof Error ? error.message : String(error), true);
				this.#viewStack.pop();
				return this.refresh();
			});
	}

	#confirm(action: "cancel" | "resume" | "rollback" | "start"): void {
		this.#push({ kind: "confirm", action });
	}

	#overviewEntries(overview: EvolutionOverview): readonly MenuEntry[] {
		return [
			{ label: "Refresh", enabled: true, select: () => void this.refresh() },
			{
				label: "Evolve",
				enabled: overview.activeJob === null,
				disabledStatus: overview.activeJob === null ? undefined : "Started",
				select: () => this.#confirm("start"),
			},
			{
				label: "View",
				enabled: overview.activeJob !== null,
				select: () => {
					if (overview.activeJob) this.#push({ kind: "job", jobId: overview.activeJob.jobId });
				},
			},
			{
				label: "Resume",
				enabled: overview.newestResumableJob !== null && overview.activeJob === null,
				select: () => this.#confirm("resume"),
			},
			{
				label: "Browse",
				enabled: true,
				select: () => this.#push({ kind: "jobs" }),
			},
			{
				label: "Rollback",
				enabled: overview.rollbackAction !== null,
				select: () => this.#confirm("rollback"),
			},
			{
				label: "Cancel",
				enabled: overview.activeJob?.cancellable === true,
				select: () => this.#confirm("cancel"),
			},
		];
	}

	#confirmationLines(action: "cancel" | "resume" | "rollback" | "start"): readonly string[] {
		const overview = this.#overview;
		if (action === "start") {
			return [
				"Would you like Diffex to evolve based on the information it has collected?",
				"This process will run in the background.",
			];
		}
		if (action === "resume") {
			return [
				`Resume ${overview?.newestResumableJob?.jobId ?? "the newest interrupted job"}?`,
				"The durable checkpoint will become active background work.",
			];
		}
		if (action === "cancel") {
			return [
				`Cancel ${overview?.activeJob?.jobId ?? "the active job"}?`,
				"The current stage will be interrupted and remain resumable.",
			];
		}
		return [
			`Roll back ${abbreviate(overview?.rollbackAction?.fromHarnessVersion ?? null)} to ${abbreviate(overview?.rollbackAction?.toHarnessVersion ?? null)}?`,
			"The selected harness pointer will change. The next fresh prompt will observe it.",
		];
	}

	#confirmEntries(action: "cancel" | "resume" | "rollback" | "start"): readonly MenuEntry[] {
		const run = () => {
			if (action === "start") {
				this.#run(
					() => this.#client.startManual(),
					(result) => {
						if (result.status === "created") return "Evolution job started";
						if (result.status === "attached") return `Attached to evolution job ${result.job.jobId}`;
						if (result.reason === "no-new-evidence") return "No new settled evidence is available";
						return `Evolution job was not started: ${result.reason}`;
					},
				);
			}
			if (action === "resume") this.#run(() => this.#client.resumeNewest(), "Evolution job resumed");
			if (action === "cancel") this.#run(() => this.#client.cancelActive(), "Evolution job interrupted");
			if (action === "rollback") this.#run(() => this.#client.rollback(), "Harness revision rolled back");
		};
		return [
			{ label: `Confirm ${action}`, enabled: true, select: run },
			{ label: "Back without changing state", enabled: true, select: () => this.#back() },
		];
	}

	#addLine(value: string, color: "accent" | "muted" | "text" | "warning" = "text"): void {
		this.addChild(new Text(theme.fg(color, sanitizeEvolutionText(value)), 1, 0));
	}

	#renderOverview(overview: EvolutionOverview): void {
		this.#addLine(`Evolution tokens: ${overview.unprocessedEstimatedTokens.toLocaleString()}`);
		this.#addLine(`Evolution invocations: ${overview.settledInvocationCount}`);
		this.#addLine(`Last evolution: ${formatEvolutionTimestamp(overview.lastEvolutionAt)}`);
		this.#addLine(
			overview.automaticEligibility.eligible
				? "Next automatic evolution: Eligible"
				: `Next automatic evolution: ${
						overview.automaticEligibility.reason === "insufficient-tokens"
							? "Insufficient information"
							: overview.automaticEligibility.reason
					}`,
		);
		this.#addLine(`Cooldown: ${duration(overview.cooldownRemainingMs)}`);
		this.#addLine(`Session harness: ${abbreviate(overview.observedHarnessVersion)}`);
		if (overview.nextPromptWillRefresh) this.#addLine("Next prompt will refresh the selected harness", "accent");
	}

	#renderJob(job: EvolutionJobDetail): void {
		const coverage = job.observability.sliceCoverage;
		let result: string;
		if (job.outcome === "active") result = "In progress";
		else if (job.outcome === "completed") {
			result = job.emittedProposals === 0 ? "Completed with no proposals" : "Completed with proposals";
		} else if (job.outcome === "terminal-failed" && job.stage === "reflecting" && job.emittedProposals === 0) {
			result = "Failed during reflection before proposals could be generated";
		} else if (job.outcome === "terminal-failed") result = `Failed during ${job.stage}`;
		else if (job.outcome === "retryable-failed") result = "Paused after a recoverable failure";
		else if (job.outcome === "interrupted") result = "Interrupted";
		else result = "Superseded";
		for (const line of [
			`Trigger: ${job.trigger}`,
			`Stage: ${job.stage} (${job.outcome})`,
			`Result: ${result}`,
			`Finished: ${formatEvolutionTimestamp(job.terminalAt)}`,
			`Proposals: ${job.emittedProposals} emitted / ${job.eligibleProposals} eligible`,
			`Evolution token: ${job.observability.estimatedEvidenceTokens.toLocaleString()}`,
			`Reflector budget: ${job.observability.reflectorBudget.modelCalls} model / ${job.observability.reflectorBudget.reflectionRounds} rounds / ${job.observability.reflectorBudget.toolCalls} tools`,
			coverage === null
				? job.outcome === "active"
					? "Coverage: pending"
					: "Coverage: unavailable - reflection did not complete"
				: `Coverage: ${coverage.analyzed} analyzed / ${coverage.corrupt} corrupt / ${coverage.skipped} skipped / ${coverage.unreadable} unreadable`,
			`Recovery attempts: ${job.observability.recoveryAttempts}`,
			`Last checkpoint: ${formatEvolutionTimestamp(job.lastCheckpointAt)}`,
			`Last error: ${job.errorMessage ?? "none"}`,
			`Base harness: ${abbreviate(job.baseHarnessVersion)}`,
		]) {
			this.#addLine(line);
		}
	}

	#renderProposal(detail: EvolutionProposalDetail): void {
		this.#addLine(`Proposal: ${detail.proposal.proposalId}`);
		this.#addLine(`Summary: ${detail.proposal.summary}`);
		this.#addLine(`Action: ${detail.proposal.action}`);
		this.#addLine(`Validation: ${detail.validationDisposition ?? "pending"}`);
		this.#addLine(`Structured delta: ${JSON.stringify(detail.proposal.exactDelta)}`);
		this.#addLine(`Evidence ranking: ${detail.score ? JSON.stringify(detail.score.scoreComponents) : "pending"}`);
		this.#addLine(`Supporting evidence: ${detail.proposal.supportingEvidenceIds.join(", ") || "none"}`);
		this.#addLine(`Contradicting evidence: ${detail.proposal.contradictingEvidenceIds.join(", ") || "none"}`);
		this.#addLine(
			`Applied diff: ${detail.exactAppliedDiff ? JSON.stringify(detail.exactAppliedDiff) : "not applied"}`,
		);
		this.#addLine(`Rollback target: ${abbreviate(detail.rollbackTarget)}`);
	}

	#renderEntries(entries: readonly MenuEntry[]): void {
		this.#entries = entries;
		this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, Math.max(0, entries.length - 1)));
		entries.forEach((entry, index) => {
			const selected = index === this.#selectedIndex;
			const prefix = selected ? SELECTED_LIST_PREFIX : UNSELECTED_LIST_PREFIX;
			const disabled = entry.enabled ? "" : ` [${entry.disabledStatus ?? "unavailable"}]`;
			const line = `${prefix}${entry.label}${disabled}`;
			this.addChild(
				new TruncatedText(theme.fg(entry.enabled ? (selected ? "selectionAccent" : "text") : "muted", line), 1, 0),
			);
		});
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.#addLine("Evolution", "accent");
		this.addChild(new Spacer(1));
		if (this.#loading) {
			this.#addLine("Loading durable evolution state...", "muted");
		} else {
			const view = this.#view();
			if (view.kind === "overview" && this.#overview) {
				this.#renderOverview(this.#overview);
				this.addChild(new Spacer(1));
				this.#renderEntries(this.#overviewEntries(this.#overview));
			} else if (view.kind === "jobs") {
				this.#renderEntries(
					this.#jobs.map((job) => ({
						label: `${job.jobId} - ${job.trigger} - ${job.stage} - ${job.outcome}`,
						enabled: true,
						select: () => this.#push({ kind: "job", jobId: job.jobId }),
					})),
				);
				if (this.#jobs.length === 0) this.#addLine("No evolution jobs", "muted");
			} else if (view.kind === "job" && this.#job) {
				this.#renderJob(this.#job);
				this.addChild(new Spacer(1));
				this.#renderEntries(
					this.#job.proposalIds.map((proposalId) => ({
						label: `Proposal ${proposalId}`,
						enabled: true,
						select: () => this.#push({ kind: "proposal", jobId: view.jobId, proposalId }),
					})),
				);
				if (this.#job.proposalIds.length === 0) this.#addLine("No proposals emitted", "muted");
			} else if (view.kind === "proposal" && this.#proposal) {
				this.#renderProposal(this.#proposal);
				this.#entries = [];
			} else if (view.kind === "confirm") {
				for (const line of this.#confirmationLines(view.action)) this.#addLine(line, "warning");
				this.addChild(new Spacer(1));
				this.#renderEntries(this.#confirmEntries(view.action));
			}
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "open") +
					"  " +
					keyHint("tui.select.cancel", "back"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.#back();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.up")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.rebuild();
			this.#requestRender();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down")) {
			this.#selectedIndex = Math.min(Math.max(0, this.#entries.length - 1), this.#selectedIndex + 1);
			this.rebuild();
			this.#requestRender();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm")) {
			const entry = this.#entries[this.#selectedIndex];
			if (entry?.enabled) entry.select();
		}
	}
}
