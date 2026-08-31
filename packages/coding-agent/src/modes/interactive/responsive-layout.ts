import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/diffex-tui";

export const MIN_INTERACTIVE_COLUMNS = 60;
export const MIN_INTERACTIVE_ROWS = 12;

export type ViewportTier = "wide" | "standard" | "narrow" | "too-small";

export interface ViewportDimensions {
	width: number;
	height: number;
}

export interface ViewportProfile extends ViewportDimensions {
	tier: ViewportTier;
	compact: boolean;
}

export type ViewportSource = () => ViewportDimensions;

function normalizeDimension(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

/** Classify a terminal without consulting process state or renderer state. */
export function classifyViewport(width: number, height: number): ViewportProfile {
	const normalizedWidth = normalizeDimension(width);
	const normalizedHeight = normalizeDimension(height);
	let tier: ViewportTier;

	if (normalizedWidth < MIN_INTERACTIVE_COLUMNS || normalizedHeight < MIN_INTERACTIVE_ROWS) {
		tier = "too-small";
	} else if (normalizedWidth >= 121) {
		tier = "wide";
	} else if (normalizedWidth >= 80) {
		tier = "standard";
	} else {
		tier = "narrow";
	}

	return {
		width: normalizedWidth,
		height: normalizedHeight,
		tier,
		compact: tier === "too-small" || tier === "narrow" || normalizedHeight < 24,
	};
}

export function getViewportProfile(source: ViewportSource): ViewportProfile {
	const viewport = source();
	return classifyViewport(viewport.width, viewport.height);
}

export interface ResponsiveEditorPresentation {
	frameStyle: "top";
	maxVisibleLines: number;
}

/** Reserve enough rows for transcript, status, queue, widgets, and footer. */
export function getResponsiveEditorPresentation(profile: ViewportProfile): ResponsiveEditorPresentation {
	if (profile.tier === "too-small") {
		return { frameStyle: "top", maxVisibleLines: 1 };
	}

	const compactReservedRows = profile.height < 16 ? 9 : 12;
	const reservedRows = profile.compact ? compactReservedRows : 19;
	const tierCap = profile.tier === "wide" ? 7 : profile.tier === "standard" ? 6 : 4;
	return {
		frameStyle: "top",
		maxVisibleLines: Math.max(2, Math.min(tierCap, profile.height - reservedRows)),
	};
}

export class ResponsiveSpacer implements Component {
	private readonly viewport: ViewportSource;

	constructor(viewport: ViewportSource) {
		this.viewport = viewport;
	}

	render(_width: number): string[] {
		return getViewportProfile(this.viewport).compact ? [] : [""];
	}

	invalidate(): void {}
}

export type ResponsiveSectionRetention = "start" | "end" | "edges";

/** Limit dock content only when fullscreen space is genuinely constrained. */
export function getResponsiveSectionMaxLines(
	mode: "regular" | "fullscreen",
	profile: ViewportProfile,
	compactMaxLines: number,
): number | undefined {
	return mode === "fullscreen" && profile.compact ? Math.max(0, Math.floor(compactMaxLines)) : undefined;
}

export interface ResponsiveSectionOptions {
	maxLines: (profile: ViewportProfile) => number | undefined;
	retention?: ResponsiveSectionRetention;
	trimLeadingBlankWhenCompact?: boolean;
}

/** Bound secondary dock content while retaining the most useful edge lines. */
export class ResponsiveSection implements Component {
	private readonly component: Component;
	private readonly viewport: ViewportSource;
	private readonly options: ResponsiveSectionOptions;

	constructor(component: Component, viewport: ViewportSource, options: ResponsiveSectionOptions) {
		this.component = component;
		this.viewport = viewport;
		this.options = options;
	}

	render(width: number): string[] {
		const profile = getViewportProfile(this.viewport);
		let lines = this.component.render(width);
		if (profile.compact && this.options.trimLeadingBlankWhenCompact) {
			const firstContentLine = lines.findIndex((line) => visibleWidth(line) > 0);
			lines = firstContentLine === -1 ? [] : lines.slice(firstContentLine);
		}

		const requestedMaxLines = this.options.maxLines(profile);
		if (requestedMaxLines === undefined) return lines;
		const maxLines = Math.max(0, Math.floor(requestedMaxLines));
		if (lines.length <= maxLines) return lines;
		if (maxLines === 0) return [];

		switch (this.options.retention ?? "start") {
			case "end":
				return lines.slice(-maxLines);
			case "edges": {
				if (maxLines === 1) return lines.slice(0, 1);
				const leadingLines = Math.ceil(maxLines / 2);
				return [...lines.slice(0, leadingLines), ...lines.slice(-(maxLines - leadingLines))];
			}
			case "start":
				return lines.slice(0, maxLines);
		}
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

export class ResponsiveEditorRegion implements Component {
	private readonly component: Component;
	private readonly viewport: ViewportSource;
	private readonly applyPresentation: (presentation: ResponsiveEditorPresentation) => void;

	constructor(
		component: Component,
		viewport: ViewportSource,
		applyPresentation: (presentation: ResponsiveEditorPresentation) => void,
	) {
		this.component = component;
		this.viewport = viewport;
		this.applyPresentation = applyPresentation;
	}

	render(width: number): string[] {
		this.applyPresentation(getResponsiveEditorPresentation(getViewportProfile(this.viewport)));
		return this.component.render(width);
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

export interface TooSmallTerminalTheme {
	title(text: string): string;
	detail(text: string): string;
	hint(text: string): string;
}

function centerLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2)))}${clipped}`;
}

/** A full-height replacement view that automatically disappears after resize. */
export class TooSmallTerminalComponent implements Component {
	private readonly viewport: ViewportSource;
	private readonly theme: TooSmallTerminalTheme;

	constructor(viewport: ViewportSource, theme: TooSmallTerminalTheme) {
		this.viewport = viewport;
		this.theme = theme;
	}

	render(width: number): string[] {
		const profile = getViewportProfile(this.viewport);
		const renderWidth = Math.max(1, Math.min(normalizeDimension(width), Math.max(1, profile.width)));
		const renderHeight = Math.max(1, profile.height);
		const candidates = [
			this.theme.title("Diffex needs more room"),
			this.theme.detail(`Terminal ${profile.width} x ${profile.height} - minimum 60 x 12`),
			this.theme.hint("Resize to continue. Keys stay active."),
		];
		const messageLines = candidates.slice(0, Math.min(candidates.length, renderHeight));
		const topPadding = Math.max(0, Math.floor((renderHeight - messageLines.length) / 2));
		const lines = Array.from({ length: renderHeight }, () => "");
		for (let index = 0; index < messageLines.length; index++) {
			lines[topPadding + index] = centerLine(messageLines[index]!, renderWidth);
		}
		return lines;
	}

	invalidate(): void {}
}

export class ResponsiveViewportRoot implements Component {
	private readonly content: Component;
	private readonly tooSmall: Component;
	private readonly viewport: ViewportSource;

	constructor(content: Component, tooSmall: Component, viewport: ViewportSource) {
		this.content = content;
		this.tooSmall = tooSmall;
		this.viewport = viewport;
	}

	render(width: number): string[] {
		return getViewportProfile(this.viewport).tier === "too-small"
			? this.tooSmall.render(width)
			: this.content.render(width);
	}

	invalidate(): void {
		this.content.invalidate();
		this.tooSmall.invalidate();
	}
}

export interface QueuedMessages {
	steering: readonly string[];
	followUp: readonly string[];
}

export interface QueuedMessagesTheme {
	text(value: string): string;
}

/** Render a concise queue summary on narrow or short terminals. */
export class ResponsiveQueuedMessagesComponent implements Component {
	private readonly getMessages: () => QueuedMessages;
	private readonly getDequeueHint: () => string;
	private readonly viewport: ViewportSource;
	private readonly theme: QueuedMessagesTheme;

	constructor(
		getMessages: () => QueuedMessages,
		getDequeueHint: () => string,
		viewport: ViewportSource,
		theme: QueuedMessagesTheme,
	) {
		this.getMessages = getMessages;
		this.getDequeueHint = getDequeueHint;
		this.viewport = viewport;
		this.theme = theme;
	}

	render(width: number): string[] {
		const profile = getViewportProfile(this.viewport);
		const { steering, followUp } = this.getMessages();
		const total = steering.length + followUp.length;
		if (total === 0) return [];

		const renderWidth = Math.max(1, width);
		if (profile.compact) {
			const groups: string[] = [];
			if (steering.length > 0) groups.push(`${steering.length} steering`);
			if (followUp.length > 0) groups.push(`${followUp.length} follow-up`);
			const line = `${total} queued (${groups.join(", ")}) - ${this.getDequeueHint()} to edit`;
			return [truncateToWidth(this.theme.text(line), renderWidth)];
		}

		const entries = [
			...steering.map((message) => `Steering: ${message}`),
			...followUp.map((message) => `Follow-up: ${message}`),
		];
		const shownEntries = entries.slice(0, 2);
		const lines = ["", ...shownEntries.map((entry) => `  ${entry}`)];
		if (entries.length > shownEntries.length) {
			lines.push(`  +${entries.length - shownEntries.length} more queued`);
		}
		lines.push(`  ${this.getDequeueHint()} to edit queued messages`);
		return lines.map((line) => truncateToWidth(this.theme.text(line), renderWidth));
	}

	invalidate(): void {}
}
