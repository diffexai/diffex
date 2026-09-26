import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, getGlyphs, truncateToWidth, visibleWidth } from "@diffexai/diffex-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { getCollaborationMode } from "../../../core/collaboration-mode.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";
import { EvolutionFooterStatus, type EvolutionFooterStatusClient } from "./evolution-footer-status.ts";
import { formatEvolutionTimestamp } from "./harness-version-display.ts";
import { keyText } from "./keybinding-hints.ts";

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

export class CustomFooterPlanModeIndicator implements Component {
	private readonly shouldShow: () => boolean;

	constructor(shouldShow: () => boolean) {
		this.shouldShow = shouldShow;
	}

	render(width: number): string[] {
		if (width <= 0 || !this.shouldShow()) return [];
		return [truncateToWidth(theme.fg("warning", "Plan mode"), width, getGlyphs().ellipsis)];
	}

	invalidate(): void {}
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
		if (width <= 0) {
			return [""];
		}

		const state = this.session.state;
		const glyphs = getGlyphs();

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent;
		const contextPercent =
			contextPercentValue === null || contextPercentValue === undefined ? "?" : contextPercentValue.toFixed(1);
		const compactContextPercent =
			contextPercentValue === null || contextPercentValue === undefined
				? "?"
				: Math.round(contextPercentValue).toString();
		const modelName = state.model?.id || "no-model";
		const thinkingLevel = state.thinkingLevel || "off";
		const windowDisplay = contextWindow > 0 ? formatTokens(contextWindow) : "?";
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
		const separator = theme.fg("borderMuted", ` ${glyphs.bullet} `);
		const separatorWidth = visibleWidth(separator);
		const contextCompact = theme.fg("footerContext", `${compactContextPercent}%`);
		const contextMedium =
			theme.fg("footerContext", `ctx ${contextPercent}%`) +
			theme.fg("borderMuted", "/") +
			theme.fg("footerWindow", windowDisplay);
		const contextFull =
			theme.fg("footerContext", `context ${contextPercent}%`) +
			theme.fg("borderMuted", " / ") +
			theme.fg("footerWindow", windowDisplay);
		const { input, cacheRead, cacheWrite } = this.session.getSessionStats().tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		const cacheHitPercent =
			promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)
				? `${((cacheRead / promptTokens) * 100).toFixed(1)}%`
				: undefined;

		const planMode = getCollaborationMode(this.session) === "plan";
		const planFull = theme.fg("warning", "Plan mode");
		const planCompact = theme.fg("warning", "Plan");

		if (planMode && width < visibleWidth(planCompact)) {
			return [truncateToWidth(planCompact, width, glyphs.ellipsis)];
		}

		if (!planMode && width <= visibleWidth(contextCompact) + separatorWidth) {
			return [truncateToWidth(theme.fg("footerModel", modelName), width, glyphs.ellipsis)];
		}

		type FooterField = { key: string; order: number; text: string };
		const planText = planMode && width >= visibleWidth(planFull) ? planFull : planCompact;
		const planCoreWidth = visibleWidth(planText) + separatorWidth * 2 + visibleWidth(contextCompact) + 1;
		if (planMode && width < planCoreWidth) {
			const planAndModelWidth = visibleWidth(planText) + separatorWidth + 1;
			if (width < planAndModelWidth) {
				return [planText];
			}
			const modelWidth = width - visibleWidth(planText) - separatorWidth;
			return [
				[planText, truncateToWidth(theme.fg("footerModel", modelName), modelWidth, glyphs.ellipsis)].join(
					separator,
				),
			];
		}

		const reservedWidth =
			visibleWidth(contextCompact) + separatorWidth + (planMode ? visibleWidth(planText) + separatorWidth : 0);
		const modelWidth = Math.min(width - reservedWidth, Math.max(1, Math.floor(width * 0.45)));
		let fields: FooterField[] = [
			...(planMode ? [{ key: "plan", order: -1, text: planText }] : []),
			{
				key: "model",
				order: 0,
				text: truncateToWidth(theme.fg("footerModel", modelName), modelWidth, glyphs.ellipsis),
			},
			{ key: "context", order: 2, text: contextCompact },
		];
		const renderFields = (candidate: FooterField[]): string =>
			[...candidate]
				.sort((a, b) => a.order - b.order)
				.map((field) => field.text)
				.join(separator);
		const trySetFields = (candidate: FooterField[]): boolean => {
			if (visibleWidth(renderFields(candidate)) > width) {
				return false;
			}
			fields = candidate;
			return true;
		};
		const tryAddField = (field: FooterField): boolean => trySetFields([...fields, field]);
		const tryUpgradeField = (key: string, text: string): boolean =>
			trySetFields(fields.map((field) => (field.key === key ? { ...field, text } : field)));
		if (cacheHitPercent !== undefined) {
			tryAddField({ key: "cache", order: 3, text: theme.fg("dim", `cache ${cacheHitPercent}`) });
		}

		// Extension statuses are public UI state, so admit them before optional
		// detail upgrades and shortcut hints. Truncate only their own field.
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusText = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text))
				.filter((text) => text.length > 0)
				.join(" ");
			const availableWidth = width - visibleWidth(renderFields(fields)) - separatorWidth;
			if (statusText.length > 0 && availableWidth > 0) {
				tryAddField({
					key: "extensions",
					order: 5,
					text: truncateToWidth(theme.fg("dim", statusText), availableWidth, glyphs.ellipsis),
				});
			}
		}

		tryAddField({ key: "thinking", order: 1, text: theme.fg("thinkingText", thinkingLevel) });
		tryAddField({
			key: "harness",
			order: 4,
			text: theme.fg("dim", `h:${harnessVersion}`) + evolutionSpinner,
		});
		tryUpgradeField("context", contextMedium);
		tryUpgradeField("thinking", theme.fg("thinkingText", `thinking ${thinkingLevel}`));
		if (cacheHitPercent !== undefined) {
			tryUpgradeField("cache", theme.fg("dim", `input cache hit ${cacheHitPercent}`));
		}
		tryUpgradeField("harness", theme.fg("dim", `harness ${harnessVersion}`) + evolutionSpinner);
		tryUpgradeField("context", contextFull);

		tryAddField({ key: "hotkeys", order: 8, text: theme.fg("dim", "/hotkeys") });

		const getBindingHint = (action: "app.thinking.cycle" | "app.model.cycleForward", label: string) => {
			try {
				const binding = keyText(action);
				return binding ? theme.fg("dim", `${binding} ${label}`) : undefined;
			} catch {
				return undefined;
			}
		};
		const thinkingHint = getBindingHint("app.thinking.cycle", "thinking");
		if (thinkingHint) {
			tryAddField({ key: "thinkingHint", order: 6, text: thinkingHint });
		}
		const modelHint = getBindingHint("app.model.cycleForward", "model");
		if (modelHint) {
			tryAddField({ key: "modelHint", order: 7, text: modelHint });
		}

		return [renderFields(fields)];
	}
}
