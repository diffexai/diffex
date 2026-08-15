import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/diffex-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/gu, " ")
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

export interface FooterTaskContext {
	profileName: string;
	profileRouting: "auto" | "pinned";
	harnessName?: string;
}

/** Persistent task context shown above either the built-in or an extension footer. */
export class FooterTaskContextComponent implements Component {
	private session: AgentSession;
	private readonly getTaskContext: () => FooterTaskContext;

	constructor(session: AgentSession, getTaskContext: () => FooterTaskContext) {
		this.session = session;
		this.getTaskContext = getTaskContext;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const taskContext = this.getTaskContext();
		const planStatus = this.session.collaborationMode === "plan" ? "[plan] " : "";
		const profileName = sanitizeStatusText(taskContext.profileName) || "unknown";
		const harnessName = sanitizeStatusText(taskContext.harnessName ?? "not selected") || "not selected";
		const profilePrefix = `${planStatus}Profile: `;
		const middle = ` (${taskContext.profileRouting}) • Harness: `;
		const fixedWidth = visibleWidth(profilePrefix) + visibleWidth(middle);
		const availableValueWidth = width - fixedWidth;
		let contextLine: string;

		if (availableValueWidth >= 2) {
			const profileDesiredWidth = visibleWidth(profileName);
			const harnessDesiredWidth = visibleWidth(harnessName);
			let profileWidth = Math.min(profileDesiredWidth, Math.max(1, Math.floor(availableValueWidth / 2)));
			let harnessWidth = Math.min(harnessDesiredWidth, Math.max(1, availableValueWidth - profileWidth));
			let remainingWidth = availableValueWidth - profileWidth - harnessWidth;
			const additionalProfileWidth = Math.min(remainingWidth, profileDesiredWidth - profileWidth);
			profileWidth += additionalProfileWidth;
			remainingWidth -= additionalProfileWidth;
			harnessWidth += Math.min(remainingWidth, harnessDesiredWidth - harnessWidth);
			contextLine = `${profilePrefix}${truncateToWidth(profileName, profileWidth, "...")}${middle}${truncateToWidth(harnessName, harnessWidth, "...")}`;
		} else {
			contextLine = truncateToWidth(`${profilePrefix}${profileName}${middle}${harnessName}`, width, "...");
		}

		return [theme.fg("dim", contextLine)];
	}
}

/**
 * Footer component that shows model, thinking, and context usage.
 * Gets context usage from the session and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private readonly taskContext: FooterTaskContextComponent;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, getTaskContext: () => FooterTaskContext) {
		this.session = session;
		this.footerData = footerData;
		this.taskContext = new FooterTaskContextComponent(session, getTaskContext);
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.taskContext.setSession(session);
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
		// Git watcher cleanup handled by provider
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
		let statsLine = `${modelName} ${thinkingLevel} • ${contextPercentStr} • ${windowDisplay}`;

		if (visibleWidth(statsLine) > width) {
			statsLine = truncateToWidth(statsLine, width, "...");
		}

		const lines = [...this.taskContext.render(width), theme.fg("dim", statsLine)];

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
