import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/diffex-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";
import { EvolutionFooterStatus, type EvolutionFooterStatusClient } from "./evolution-footer-status.ts";
import { formatEvolutionTimestamp } from "./harness-version-display.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows model, thinking, and context usage.
 * Gets context usage from the session and extension statuses from provider.
 */
export interface FooterComponentOptions {
	readonly evolution?: EvolutionFooterStatusClient;
	readonly requestRender?: () => void;
	readonly onSelectedHarnessChange?: (version: string) => void | Promise<void>;
}

export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private readonly evolutionStatus: EvolutionFooterStatus | undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, options: FooterComponentOptions = {}) {
		this.session = session;
		this.footerData = footerData;
		this.evolutionStatus = options.evolution
			? new EvolutionFooterStatus({
					client: options.evolution,
					getActiveHarnessVersion: () => this.session.activeHarnessVersion,
					requestRender: options.requestRender ?? (() => {}),
					onSelectedHarnessChange: options.onSelectedHarnessChange,
				})
			: undefined;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		void this.evolutionStatus?.refresh();
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		this.evolutionStatus?.dispose();
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const contextPercentDisplay = `Context ${contextPercent}% used`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}

		const modelName = state.model?.id || "no-model";
		const thinkingLevel = state.thinkingLevel || "off";
		const windowDisplay = `${formatTokens(contextWindow)} window`;
		const evolutionSnapshot = this.evolutionStatus?.getSnapshot();
		const harnessInfo = evolutionSnapshot?.activeVersionInfo;
		const harnessVersion =
			evolutionSnapshot === undefined
				? "default"
				: !evolutionSnapshot.loaded
					? "..."
					: harnessInfo?.kind === "evolved"
						? harnessInfo.evolvedAt === null
							? "evolved"
							: formatEvolutionTimestamp(harnessInfo.evolvedAt)
						: harnessInfo?.kind === "default"
							? "default"
							: "unknown";
		const evolutionSpinner = evolutionSnapshot?.running
			? ` ${theme.fg("accent", evolutionSnapshot.spinnerFrame)}`
			: "";
		let statsLine = `${modelName} ${thinkingLevel} • ${contextPercentStr} • ${windowDisplay}`;
		let harnessLine = `Harness ${harnessVersion}${evolutionSpinner}`;

		if (visibleWidth(statsLine) > width) {
			statsLine = truncateToWidth(statsLine, width, "...");
		}
		if (visibleWidth(harnessLine) > width) {
			harnessLine = truncateToWidth(harnessLine, width, "...");
		}

		const lines = [theme.fg("dim", statsLine), theme.fg("dim", harnessLine)];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
