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
	EvolutionHarnessVersionInfo,
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
import {
	formatEvolutionTimestamp,
	formatHarnessVersionReference,
	sanitizeDisplayText,
} from "./harness-version-display.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export { formatEvolutionTimestamp } from "./harness-version-display.ts";

export interface EvolutionMenuClient {
	getEnabled(): boolean;
	setEnabled(enabled: boolean): Promise<void>;
	subscribe(listener: (event: EvolutionProgressEvent) => void): () => void;
	overview(): Promise<EvolutionOverview>;
	listHarnessVersionInfo(): Promise<readonly EvolutionHarnessVersionInfo[]>;
	listCurrentDirectoryHarnessVersionInfo(): Promise<readonly EvolutionHarnessVersionInfo[]>;
	listJobs(): Promise<readonly EvolutionJobSummary[]>;
	jobDetail(jobId: string): Promise<EvolutionJobDetail>;
	proposalDetail(jobId: string, proposalId: string): Promise<EvolutionProposalDetail>;
	startManual(): Promise<EvolutionStartResult>;
	resumeNewest(): Promise<EvolutionJobSummary>;
	cancelJob(jobId: string): Promise<void>;
	rollback(): Promise<EvolutionRollbackAction>;
}

type MenuView =
	| { readonly kind: "overview" }
	| { readonly kind: "jobs" }
	| { readonly kind: "job"; readonly jobId: string }
	| { readonly kind: "proposal"; readonly jobId: string; readonly proposalId: string }
	| {
			readonly kind: "proposal-evidence";
			readonly jobId: string;
			readonly proposalId: string;
			readonly evidenceKind: "supporting" | "contradicting";
	  }
	| {
			readonly kind: "confirm";
			readonly action: "cancel" | "resume" | "rollback" | "start";
			readonly jobId?: string;
	  };

interface MenuEntry {
	readonly label: string;
	readonly enabled: boolean;
	readonly disabledStatus?: string;
	readonly select: () => void;
}

export function sanitizeEvolutionText(value: string): string {
	return sanitizeDisplayText(value);
}

function duration(milliseconds: number): string {
	if (milliseconds <= 0) return "ready";
	const minutes = Math.ceil(milliseconds / 60_000);
	return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatEvolutionProposalOutcome(proposal: EvolutionProposalDetail["proposal"]): string {
	if (proposal.disposition === "deferred") return proposal.finding;
	if (proposal.exactDelta.operation === "ADD") return proposal.exactDelta.content;
	if (proposal.exactDelta.operation === "REMOVE") {
		return `Remove the existing evolution-memory entry because ${proposal.exactDelta.reason}`;
	}
	return proposal.exactDelta.addition.content;
}

function firstCharacters(value: string, maximum: number): string {
	return [...sanitizeEvolutionText(value).replace(/\s+/gu, " ").trim()].slice(0, maximum).join("");
}

export function formatEvolutionJobLabel(job: EvolutionJobSummary, now = new Date()): string {
	const trigger = job.trigger === "automatic" ? "auto" : "manual";
	return `${formatEvolutionTimestamp(job.createdAt, now)} - ${trigger} - ${job.stage}`;
}

export function formatEvolutionProposalLabel(proposal: EvolutionProposalDetail["proposal"]): string {
	return `Proposal ${firstCharacters(formatEvolutionProposalOutcome(proposal), 50)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const visibleText = value.flatMap((item) =>
			isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
		);
		if (visibleText.length > 0) return visibleText.join(" ");
		return value.map(evidenceContent).filter(Boolean).join(" ");
	}
	if (!isRecord(value)) return "";
	if (isRecord(value.message)) return evidenceContent(value.message);
	if ("content" in value) {
		const content = evidenceContent(value.content);
		if (content) return content;
	}
	for (const key of ["text", "output", "error", "command", "thinking"] as const) {
		if (typeof value[key] === "string") return value[key];
	}
	if (value.type === "toolCall" && typeof value.name === "string") {
		return `${value.name}: ${JSON.stringify(value.arguments ?? {})}`;
	}
	return "";
}

export function formatEvolutionEvidencePreview(
	evidence: EvolutionProposalDetail["supportingEvidence"][number],
): string {
	const content = evidenceContent(evidence.payload) || JSON.stringify(evidence.payload);
	return firstCharacters(content, 100);
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
	#harnessVersionInfo: readonly EvolutionHarnessVersionInfo[] = [];
	#harnessVersionInfoLoaded = false;
	#job: EvolutionJobDetail | null = null;
	#proposal: EvolutionProposalDetail | null = null;
	#entries: readonly MenuEntry[] = [];
	#selectedIndex = 0;
	#loading = true;
	#disposed = false;
	#focused = false;
	#pollTimeout: ReturnType<typeof setTimeout> | null = null;
	#refreshPromise: Promise<void> | null = null;
	#refreshQueued = false;

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
		this.#unsubscribe = client.subscribe((event) => {
			if (event.type === "completed") this.#harnessVersionInfoLoaded = false;
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
		this.#refreshQueued = true;
		if (this.#refreshPromise !== null) return this.#refreshPromise;
		this.#refreshPromise = (async () => {
			do {
				this.#refreshQueued = false;
				await this.#refresh();
			} while (this.#refreshQueued && !this.#disposed);
		})().finally(() => {
			this.#refreshPromise = null;
		});
		return this.#refreshPromise;
	}

	async #refresh(): Promise<void> {
		this.#loading = true;
		this.rebuild();
		try {
			this.#overview = await this.#client.overview();
			if (!this.#harnessVersionInfoLoaded) {
				this.#harnessVersionInfo = await this.#client.listHarnessVersionInfo();
				this.#harnessVersionInfoLoaded = true;
			}
			const view = this.#view();
			if (view.kind === "jobs") this.#jobs = await this.#client.listJobs();
			if (view.kind === "job") this.#job = await this.#client.jobDetail(view.jobId);
			if (view.kind === "proposal" || view.kind === "proposal-evidence") {
				this.#proposal = await this.#client.proposalDetail(view.jobId, view.proposalId);
			}
		} catch (error) {
			this.#onStatus(error instanceof Error ? error.message : String(error), true);
		} finally {
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
		this.#loading = true;
		this.rebuild();
		this.#requestRender();
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

	#confirm(action: "cancel" | "resume" | "rollback" | "start", jobId?: string): void {
		this.#push({ kind: "confirm", action, jobId });
	}

	#overviewEntries(overview: EvolutionOverview): readonly MenuEntry[] {
		const evolutionEnabled = this.#client.getEnabled();
		const cancellableJob =
			[overview.activeJob, overview.newestResumableJob].find((job) => job?.cancellable === true) ?? null;
		return [
			{ label: "Refresh", enabled: evolutionEnabled, select: () => void this.refresh() },
			{
				label: "Evolve",
				enabled: evolutionEnabled && overview.activeJob === null,
				disabledStatus: evolutionEnabled && overview.activeJob !== null ? "Started" : undefined,
				select: () => this.#confirm("start"),
			},
			{
				label: "View",
				enabled: evolutionEnabled && overview.activeJob !== null,
				select: () => {
					if (overview.activeJob) this.#push({ kind: "job", jobId: overview.activeJob.jobId });
				},
			},
			{
				label: "Resume",
				enabled: evolutionEnabled && overview.newestResumableJob !== null && overview.activeJob === null,
				select: () => this.#confirm("resume"),
			},
			{
				label: "Browse",
				enabled: evolutionEnabled,
				select: () => this.#push({ kind: "jobs" }),
			},
			{
				label: "Rollback",
				enabled: evolutionEnabled && overview.rollbackAction !== null,
				select: () => this.#confirm("rollback"),
			},
			{
				label: "Cancel",
				enabled: evolutionEnabled && cancellableJob !== null,
				select: () => {
					if (cancellableJob !== null) this.#confirm("cancel", cancellableJob.jobId);
				},
			},
			{
				label: `Toggle [${evolutionEnabled ? "on" : "off"}]`,
				enabled: true,
				select: () => {
					const enabled = !this.#client.getEnabled();
					void this.#client
						.setEnabled(enabled)
						.then(() => {
							this.#onStatus(`Self-evolution ${enabled ? "enabled" : "disabled"}`, false);
							this.rebuild();
							this.#requestRender();
						})
						.catch((error: unknown) => {
							this.#onStatus(error instanceof Error ? error.message : String(error), true);
						});
				},
			},
		];
	}

	#confirmationLines(view: Extract<MenuView, { kind: "confirm" }>): readonly string[] {
		const { action } = view;
		const overview = this.#overview;
		if (action === "start") {
			return [
				"Would you like Diffex to evolve based on the information it has collected?",
				"This process will run in the background.",
			];
		}
		if (action === "resume") {
			return [
				`Resume ${overview?.newestResumableJob ? formatEvolutionJobLabel(overview.newestResumableJob) : "the newest interrupted job"}?`,
				"The durable checkpoint will become active background work.",
			];
		}
		if (action === "cancel") {
			const job = [overview?.activeJob, overview?.newestResumableJob].find(
				(candidate) => candidate?.jobId === view.jobId,
			);
			return [
				`Cancel ${job ? formatEvolutionJobLabel(job) : "the selected job"}?`,
				"The evolution round will be removed. Its tokens and invocations will remain available.",
			];
		}
		return [
			`Roll back ${formatHarnessVersionReference(overview?.rollbackAction?.fromHarnessVersion ?? null, this.#harnessVersionInfo, overview?.currentHarnessVersion)} to ${formatHarnessVersionReference(overview?.rollbackAction?.toHarnessVersion ?? null, this.#harnessVersionInfo, overview?.currentHarnessVersion)}?`,
			"The selected harness pointer will change. The next fresh prompt will observe it.",
		];
	}

	#confirmEntries(view: Extract<MenuView, { kind: "confirm" }>): readonly MenuEntry[] {
		const { action } = view;
		const run = () => {
			if (action === "start") {
				this.#run(
					() => this.#client.startManual(),
					(result) => {
						if (result.status === "created") return "Evolution job started";
						if (result.status === "attached")
							return `Attached to evolution job ${formatEvolutionJobLabel(result.job)}`;
						if (result.reason === "no-new-evidence") return "No new settled evidence is available";
						return `Evolution job was not started: ${result.reason}`;
					},
				);
			}
			if (action === "resume") this.#run(() => this.#client.resumeNewest(), "Evolution job resumed");
			const cancellationJobId = view.jobId;
			if (action === "cancel" && cancellationJobId !== undefined) {
				this.#run(() => this.#client.cancelJob(cancellationJobId), "Evolution round removed");
			}
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
		const evolutionEnabled = this.#client.getEnabled();
		this.#addLine(`Evolution tokens: ${overview.unprocessedEstimatedTokens.toLocaleString()}`);
		this.#addLine(`Evolution invocations: ${overview.settledInvocationCount}`);
		this.#addLine(`Last evolution: ${formatEvolutionTimestamp(overview.lastEvolutionAt)}`);
		this.#addLine(
			!evolutionEnabled
				? "Next automatic evolution: Disabled"
				: overview.automaticEligibility.eligible
					? "Next automatic evolution: Eligible"
					: `Next automatic evolution: ${
							overview.automaticEligibility.reason === "insufficient-tokens"
								? "Insufficient information"
								: overview.automaticEligibility.reason
						}`,
		);
		this.#addLine(`Cooldown: ${duration(overview.cooldownRemainingMs)}`);
		this.#addLine(
			`Session harness: ${formatHarnessVersionReference(
				overview.observedHarnessVersion,
				this.#harnessVersionInfo,
				overview.currentHarnessVersion,
			)}`,
		);
		if (overview.nextPromptWillRefresh) this.#addLine("Next prompt will refresh the selected harness", "accent");
	}

	#renderJob(job: EvolutionJobDetail): void {
		for (const line of [
			`Trigger: ${job.trigger}`,
			`Stage: ${job.stage} (${job.outcome})`,
			`Finished: ${formatEvolutionTimestamp(job.terminalAt)}`,
			`Evolution token: ${job.observability.estimatedEvidenceTokens.toLocaleString()}`,
			`Last checkpoint: ${formatEvolutionTimestamp(job.lastCheckpointAt)}`,
			`Base harness: ${formatHarnessVersionReference(
				job.baseHarnessVersion,
				this.#harnessVersionInfo,
				this.#overview?.currentHarnessVersion,
				job.baseHarnessInfo,
			)}`,
		]) {
			this.#addLine(line);
		}
	}

	#renderProposal(detail: EvolutionProposalDetail): void {
		this.#addLine(formatEvolutionProposalLabel(detail.proposal));
		this.addChild(new Spacer(1));
		this.#addLine(`Validation: ${detail.validationDisposition ?? "pending"}`);
		this.addChild(new Spacer(1));
		this.#addLine(`Outcome: ${formatEvolutionProposalOutcome(detail.proposal)}`);
	}

	#proposalEvidenceEntries(detail: EvolutionProposalDetail, jobId: string, proposalId: string): readonly MenuEntry[] {
		return [
			{
				label: `Supporting evidence (${detail.proposal.supportingEvidenceIds.length})`,
				enabled: true,
				select: () =>
					this.#push({
						kind: "proposal-evidence",
						jobId,
						proposalId,
						evidenceKind: "supporting",
					}),
			},
			{
				label: `Contradicting evidence (${detail.proposal.contradictingEvidenceIds.length})`,
				enabled: true,
				select: () =>
					this.#push({
						kind: "proposal-evidence",
						jobId,
						proposalId,
						evidenceKind: "contradicting",
					}),
			},
		];
	}

	#renderProposalEvidence(detail: EvolutionProposalDetail, evidenceKind: "supporting" | "contradicting"): void {
		const supporting = evidenceKind === "supporting";
		const label = supporting ? "Supporting evidence" : "Contradicting evidence";
		const evidence = supporting ? detail.supportingEvidence : detail.contradictingEvidence;
		this.#addLine(`${label} (${evidence.length})`, "accent");
		if (evidence.length === 0) {
			this.#addLine(`No ${label.toLowerCase()}`, "muted");
			return;
		}
		for (const [index, item] of evidence.entries()) {
			this.#addLine(`${index + 1}. ${formatEvolutionEvidencePreview(item)}`);
		}
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
		this.#entries = [];
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
						label: formatEvolutionJobLabel(job),
						enabled: true,
						select: () => this.#push({ kind: "job", jobId: job.jobId }),
					})),
				);
				if (this.#jobs.length === 0) this.#addLine("No evolution jobs", "muted");
			} else if (view.kind === "job" && this.#job) {
				this.#renderJob(this.#job);
				this.addChild(new Spacer(1));
				this.#renderEntries(
					this.#job.proposals.map((proposal) => ({
						label: formatEvolutionProposalLabel(proposal),
						enabled: true,
						select: () => this.#push({ kind: "proposal", jobId: view.jobId, proposalId: proposal.proposalId }),
					})),
				);
				if (this.#job.proposals.length === 0) this.#addLine("No proposals emitted", "muted");
			} else if (view.kind === "proposal" && this.#proposal) {
				this.#renderProposal(this.#proposal);
				this.addChild(new Spacer(1));
				this.#renderEntries(this.#proposalEvidenceEntries(this.#proposal, view.jobId, view.proposalId));
			} else if (view.kind === "proposal-evidence" && this.#proposal) {
				this.#renderProposalEvidence(this.#proposal, view.evidenceKind);
				this.#entries = [];
			} else if (view.kind === "confirm") {
				for (const line of this.#confirmationLines(view)) this.#addLine(line, "warning");
				this.addChild(new Spacer(1));
				this.#renderEntries(this.#confirmEntries(view));
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
