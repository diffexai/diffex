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

function timestamp(value: string | null): string {
	return value === null ? "never" : sanitizeEvolutionText(value);
}

export class EvolutionMenuComponent extends Container implements Focusable {
	readonly #client: EvolutionMenuClient;
	readonly #onClose: () => void;
	readonly #onStatus: (message: string, error: boolean) => void;
	readonly #requestRender: () => void;
	readonly #unsubscribe: () => void;
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
	) {
		super();
		this.#client = client;
		this.#onClose = onClose;
		this.#onStatus = onStatus;
		this.#requestRender = requestRender;
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

	async refresh(): Promise<void> {
		if (this.#disposed) return;
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
			this.#loading = false;
			this.rebuild();
			this.#requestRender();
		}
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
			{ label: "Refresh overview", enabled: true, select: () => void this.refresh() },
			{
				label: "Start a new evolution job",
				enabled: overview.activeJob === null,
				select: () => this.#confirm("start"),
			},
			{
				label: overview.activeJob ? `View active job ${overview.activeJob.jobId}` : "View active job",
				enabled: overview.activeJob !== null,
				select: () => {
					if (overview.activeJob) this.#push({ kind: "job", jobId: overview.activeJob.jobId });
				},
			},
			{
				label: overview.newestResumableJob
					? `Resume ${overview.newestResumableJob.jobId}`
					: "Resume newest interrupted job",
				enabled: overview.newestResumableJob !== null && overview.activeJob === null,
				select: () => this.#confirm("resume"),
			},
			{
				label: "Browse job history, proposals, and applied diffs",
				enabled: true,
				select: () => this.#push({ kind: "jobs" }),
			},
			{
				label: overview.rollbackAction
					? `Roll back ${abbreviate(overview.rollbackAction.fromHarnessVersion)} to ${abbreviate(overview.rollbackAction.toHarnessVersion)}`
					: "Roll back the active evolution revision",
				enabled: overview.rollbackAction !== null,
				select: () => this.#confirm("rollback"),
			},
			{
				label: overview.activeJob ? `Cancel ${overview.activeJob.jobId}` : "Cancel active job",
				enabled: overview.activeJob?.cancellable === true,
				select: () => this.#confirm("cancel"),
			},
		];
	}

	#confirmationLines(action: "cancel" | "resume" | "rollback" | "start"): readonly string[] {
		const overview = this.#overview;
		if (action === "start") {
			return [
				"Start a manual evolution job?",
				"The job will snapshot globally unprocessed evidence and run in the background.",
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
		this.#addLine("Evidence scope: global");
		this.#addLine(`Unprocessed materialized tokens: ${overview.unprocessedEstimatedTokens.toLocaleString()}`);
		this.#addLine(`Automatic threshold: > ${overview.automaticTokenThreshold.toLocaleString()} tokens`);
		this.#addLine(`Settled invocations: ${overview.settledInvocationCount}`);
		this.#addLine(`Last automatic run: ${timestamp(overview.lastAutomaticRunAt)}`);
		this.#addLine(`Cooldown: ${duration(overview.cooldownRemainingMs)}`);
		this.#addLine(
			overview.automaticEligibility.eligible
				? "Next automatic run: eligible"
				: `Next automatic run: ${overview.automaticEligibility.reason}`,
		);
		this.#addLine(`Selected harness (global): ${abbreviate(overview.currentHarnessVersion)}`);
		this.#addLine(`Session harness: ${abbreviate(overview.observedHarnessVersion)}`);
		if (overview.nextPromptWillRefresh) this.#addLine("Next prompt will refresh the selected harness", "accent");
	}

	#renderJob(job: EvolutionJobDetail): void {
		const stageLatencies = job.observability.stageLatencies
			.map((entry) => `${entry.stage}=${entry.durationMs}ms`)
			.join(", ");
		const coverage = job.observability.sliceCoverage;
		for (const line of [
			`Job: ${job.jobId}`,
			`Trigger: ${job.trigger}`,
			`Evidence high-water cursor: ${job.evidenceHighWaterCursor}`,
			`Stage: ${job.stage} (${job.outcome})`,
			`Slices: ${job.completedSlices} completed / ${job.discoveredSlices} discovered`,
			`Model calls: ${job.modelCalls}; retries: ${job.modelRetries}`,
			`Proposals: ${job.emittedProposals} emitted / ${job.eligibleProposals} eligible`,
			`Selected operations: ${job.selectedOperations}`,
			`Queue age: ${job.observability.queueAgeMs === null ? "pending" : `${job.observability.queueAgeMs}ms`}`,
			`Stage latency: ${stageLatencies || "pending"}`,
			`Evidence tokens: ${job.observability.estimatedEvidenceTokens.toLocaleString()}`,
			"Provider cost: unavailable",
			`Reflector budget: ${job.observability.reflectorBudget.modelCalls} model / ${job.observability.reflectorBudget.reflectionRounds} rounds / ${job.observability.reflectorBudget.toolCalls} tools`,
			`Coverage: ${coverage.analyzed} analyzed / ${coverage.corrupt} corrupt / ${coverage.skipped} skipped / ${coverage.unreadable} unreadable`,
			`Proposal dispositions: ${JSON.stringify(job.observability.proposalDispositions)}`,
			`Activation conflicts: ${job.observability.activationConflicts}`,
			`Recovery attempts: ${job.observability.recoveryAttempts}`,
			`Rollback available: ${job.observability.rollbackAvailable ? "yes" : "no"}`,
			`Last checkpoint: ${timestamp(job.lastCheckpointAt)}`,
			`Last error: ${job.errorMessage ?? "none"}`,
			`Base harness: ${abbreviate(job.baseHarnessVersion)}`,
			`Activated harness: ${abbreviate(job.activatedHarnessVersion)}`,
			`Next prompt will refresh: ${job.nextPromptWillRefresh ? "yes" : "no"}`,
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
			const disabled = entry.enabled ? "" : " [unavailable]";
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
