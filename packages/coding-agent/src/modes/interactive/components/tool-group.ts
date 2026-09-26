import { type Component, truncateToWidth, visibleWidth } from "@diffexai/diffex-tui";
import { theme } from "../theme/theme.ts";
import {
	DiffexPathDockHinge,
	DiffexPathLabel,
	type DiffexPathOrigin,
	DiffexPathRail,
	DiffexPathTerminus,
} from "./diffex-path.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

interface RenderedTool {
	lines: string[];
}

export class ToolGroupComponent implements Component {
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private outputPad: number;
	private pathOrigin: DiffexPathOrigin;
	private reusesLeadingGap: boolean;
	private settled = false;
	private cachedRender?: { width: number; lines: string[] };

	constructor(
		outputPad = 1,
		pathOrigin: DiffexPathOrigin = "standalone",
		options: { reuseLeadingGap?: boolean } = {},
	) {
		this.outputPad = outputPad;
		this.pathOrigin = pathOrigin;
		this.reusesLeadingGap = pathOrigin === "standalone" && options.reuseLeadingGap === true;
	}

	addTool(toolCallId: string, component: ToolExecutionComponent): ToolExecutionComponent {
		const existing = this.tools.get(toolCallId);
		if (existing) {
			return existing;
		}
		this.tools.set(toolCallId, component);
		this.cachedRender = undefined;
		return component;
	}

	getTool(toolCallId: string): ToolExecutionComponent | undefined {
		return this.tools.get(toolCallId);
	}

	removeTool(toolCallId: string): boolean {
		const removed = this.tools.delete(toolCallId);
		if (removed) this.cachedRender = undefined;
		return removed;
	}

	replaceTools(tools: ReadonlyArray<readonly [string, ToolExecutionComponent]>): void {
		this.tools.clear();
		for (const [toolCallId, component] of tools) {
			this.tools.delete(toolCallId);
			this.tools.set(toolCallId, component);
		}
		this.cachedRender = undefined;
	}

	hasTools(): boolean {
		return this.tools.size > 0;
	}

	getPathOrigin(): DiffexPathOrigin {
		return this.pathOrigin;
	}

	setPathOrigin(pathOrigin: DiffexPathOrigin, options: { reuseLeadingGap?: boolean } = {}): void {
		this.pathOrigin = pathOrigin;
		this.reusesLeadingGap = pathOrigin === "standalone" && options.reuseLeadingGap === true;
		this.cachedRender = undefined;
	}

	markSettled(): void {
		this.settled = true;
		this.cachedRender = undefined;
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.cachedRender = undefined;
	}

	setExpanded(expanded: boolean): void {
		for (const tool of this.tools.values()) {
			tool.setExpanded(expanded);
		}
		this.cachedRender = undefined;
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools.values()) {
			tool.setShowImages(show);
		}
		this.cachedRender = undefined;
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools.values()) {
			tool.setImageWidthCells(width);
		}
		this.cachedRender = undefined;
	}

	invalidate(): void {
		for (const tool of this.tools.values()) {
			tool.invalidate();
		}
		this.cachedRender = undefined;
	}

	render(width: number): string[] {
		if (this.settled && this.cachedRender?.width === width) return this.cachedRender.lines;
		const safeWidth = Math.max(1, width);
		const outputPad = Math.min(Math.max(0, this.outputPad), Math.max(0, safeWidth - 1));
		const outerRailWidth = safeWidth - outputPad > 1 ? 1 : 0;
		const leftPad = " ".repeat(outputPad);
		const pathPrefix = outerRailWidth > 0 ? (new DiffexPathRail(outputPad).render(safeWidth)[0] ?? leftPad) : leftPad;
		const pathPrefixWidth = visibleWidth(pathPrefix);
		const railGapWidth = safeWidth - pathPrefixWidth > 1 ? 1 : 0;
		const railGap = " ".repeat(railGapWidth);
		const toolWidth = Math.max(1, safeWidth - pathPrefixWidth - railGapWidth);
		const renderedTools: RenderedTool[] = [];

		for (const component of this.tools.values()) {
			const lines = component.render(toolWidth);
			if (lines.some((line) => line !== "")) {
				renderedTools.push({ lines });
			}
		}

		if (renderedTools.length === 0) {
			const lines =
				this.pathOrigin !== "continued"
					? []
					: this.settled
						? new DiffexPathTerminus(outputPad).render(safeWidth)
						: new DiffexPathRail(outputPad).render(safeWidth);
			if (this.settled) this.cachedRender = { width, lines };
			return lines;
		}

		const label = this.settled ? "Explored" : "Exploring";
		const continuesPath = this.pathOrigin === "continued";
		const result = continuesPath
			? new DiffexPathRail(outputPad).render(safeWidth)
			: this.pathOrigin === "user-dock"
				? new DiffexPathDockHinge(outputPad).render(safeWidth)
				: this.reusesLeadingGap
					? []
					: [""];
		result.push(
			...new DiffexPathLabel(label, {
				marker: this.pathOrigin === "standalone" ? "start" : "branch",
				padding: outputPad,
				labelColor: (text) => theme.fg("muted", theme.bold(text)),
			}).render(safeWidth),
		);
		for (const { lines } of renderedTools) {
			for (const line of lines) {
				if (line === "") {
					result.push("");
					continue;
				}

				const decoratedLine = pathPrefix + railGap + line;
				result.push(
					visibleWidth(decoratedLine) > safeWidth ? truncateToWidth(decoratedLine, safeWidth, "") : decoratedLine,
				);
			}
		}

		if (this.settled) this.cachedRender = { width, lines: result };
		return result;
	}
}
