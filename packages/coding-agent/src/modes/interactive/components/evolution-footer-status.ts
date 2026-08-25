import type { EvolutionHarnessVersionInfo, EvolutionOverview, EvolutionProgressEvent } from "#evolution";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 5_000;

export interface EvolutionFooterStatusClient {
	subscribe(listener: (event: EvolutionProgressEvent) => void): () => void;
	overview(): Promise<EvolutionOverview>;
	listHarnessVersionInfo(): Promise<readonly EvolutionHarnessVersionInfo[]>;
}

export interface EvolutionFooterSnapshot {
	readonly loaded: boolean;
	readonly running: boolean;
	readonly spinnerFrame: string;
	readonly activeVersionInfo: EvolutionHarnessVersionInfo | undefined;
}

export interface EvolutionFooterStatusOptions {
	readonly client: EvolutionFooterStatusClient;
	readonly getActiveHarnessVersion: () => string | undefined;
	readonly requestRender: () => void;
	readonly onSelectedHarnessChange?: (version: string) => void | Promise<void>;
	readonly activePollIntervalMs?: number;
	readonly idlePollIntervalMs?: number;
	readonly spinnerIntervalMs?: number;
}

export class EvolutionFooterStatus {
	readonly #client: EvolutionFooterStatusClient;
	readonly #getActiveHarnessVersion: () => string | undefined;
	readonly #requestRender: () => void;
	readonly #onSelectedHarnessChange: ((version: string) => void | Promise<void>) | undefined;
	readonly #activePollIntervalMs: number;
	readonly #idlePollIntervalMs: number;
	readonly #spinnerIntervalMs: number;
	readonly #unsubscribe: () => void;
	#versionInfo: readonly EvolutionHarnessVersionInfo[] = [];
	#versionInfoLoaded = false;
	#running = false;
	#spinnerFrameIndex = 0;
	#selectedHarnessVersion: string | null = null;
	#selectedHarnessVersionLoaded = false;
	#activateSelectedHarness = false;
	#reloadVersionInfo = true;
	#refreshPromise: Promise<void> | null = null;
	#refreshAgain = false;
	#pollTimeout: ReturnType<typeof setTimeout> | null = null;
	#spinnerInterval: ReturnType<typeof setInterval> | null = null;
	#disposed = false;

	constructor(options: EvolutionFooterStatusOptions) {
		this.#client = options.client;
		this.#getActiveHarnessVersion = options.getActiveHarnessVersion;
		this.#requestRender = options.requestRender;
		this.#onSelectedHarnessChange = options.onSelectedHarnessChange;
		this.#activePollIntervalMs = options.activePollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS;
		this.#idlePollIntervalMs = options.idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS;
		this.#spinnerIntervalMs = options.spinnerIntervalMs ?? SPINNER_INTERVAL_MS;
		this.#unsubscribe = this.#client.subscribe((event) => this.#handleProgress(event));
		void this.refresh();
	}

	getSnapshot(): EvolutionFooterSnapshot {
		const activeVersion = this.#getActiveHarnessVersion();
		return {
			loaded: this.#versionInfoLoaded,
			running: this.#running,
			spinnerFrame: SPINNER_FRAMES[this.#spinnerFrameIndex] ?? SPINNER_FRAMES[0],
			activeVersionInfo: this.#versionInfo.find((info) => info.version === activeVersion),
		};
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#refreshPromise !== null) {
			this.#refreshAgain = true;
			return this.#refreshPromise;
		}
		this.#clearPoll();
		this.#refreshPromise = this.#refresh().finally(() => {
			this.#refreshPromise = null;
			if (this.#refreshAgain) {
				this.#refreshAgain = false;
				void this.refresh();
			}
		});
		return this.#refreshPromise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#clearPoll();
		this.#stopSpinner();
	}

	async #refresh(): Promise<void> {
		try {
			const shouldLoadVersionInfo = this.#reloadVersionInfo || !this.#versionInfoLoaded;
			const [overview, versionInfo] = await Promise.all([
				this.#client.overview(),
				shouldLoadVersionInfo ? this.#client.listHarnessVersionInfo() : Promise.resolve(this.#versionInfo),
			]);
			if (this.#disposed) return;

			this.#versionInfo = versionInfo;
			this.#versionInfoLoaded = true;
			this.#reloadVersionInfo = false;
			this.#setRunning(overview.activeJob !== null);

			const selectedVersion = overview.currentHarnessVersion;
			const selectionChanged =
				this.#selectedHarnessVersionLoaded &&
				selectedVersion !== null &&
				selectedVersion !== this.#selectedHarnessVersion;
			this.#selectedHarnessVersion = selectedVersion;
			this.#selectedHarnessVersionLoaded = true;
			if ((selectionChanged || this.#activateSelectedHarness) && selectedVersion !== null) {
				this.#activateSelectedHarness = false;
				await this.#onSelectedHarnessChange?.(selectedVersion);
			}
		} catch {
			// Footer status is best-effort. Prompt-boundary harness refresh remains authoritative.
		} finally {
			if (!this.#disposed) {
				this.#requestRender();
				this.#schedulePoll();
			}
		}
	}

	#handleProgress(event: EvolutionProgressEvent): void {
		if (this.#disposed) return;
		if (event.type === "started" || event.type === "checkpoint") this.#setRunning(true);
		if (event.type === "completed" || event.type === "failed") this.#setRunning(false);
		if (event.type === "completed") {
			this.#activateSelectedHarness = true;
			this.#reloadVersionInfo = true;
		}
		this.#requestRender();
		void this.refresh();
	}

	#setRunning(running: boolean): void {
		if (this.#running === running) return;
		this.#running = running;
		if (running) this.#startSpinner();
		else this.#stopSpinner();
	}

	#startSpinner(): void {
		this.#stopSpinner();
		this.#spinnerFrameIndex = 0;
		this.#spinnerInterval = setInterval(() => {
			this.#spinnerFrameIndex = (this.#spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
			this.#requestRender();
		}, this.#spinnerIntervalMs);
		const interval = this.#spinnerInterval as ReturnType<typeof setInterval> & { unref?: () => void };
		interval.unref?.();
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval !== null) clearInterval(this.#spinnerInterval);
		this.#spinnerInterval = null;
	}

	#schedulePoll(): void {
		this.#clearPoll();
		const delay = this.#running ? this.#activePollIntervalMs : this.#idlePollIntervalMs;
		this.#pollTimeout = setTimeout(() => {
			this.#pollTimeout = null;
			void this.refresh();
		}, delay);
		const timeout = this.#pollTimeout as ReturnType<typeof setTimeout> & { unref?: () => void };
		timeout.unref?.();
	}

	#clearPoll(): void {
		if (this.#pollTimeout !== null) clearTimeout(this.#pollTimeout);
		this.#pollTimeout = null;
	}
}
