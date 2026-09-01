import { type Component, getGlyphs, truncateToWidth, visibleWidth } from "@earendil-works/diffex-tui";
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
		return component;
	}

	getTool(toolCallId: string): ToolExecutionComponent | undefined {
		return this.tools.get(toolCallId);
	}

	removeTool(toolCallId: string): boolean {
		return this.tools.delete(toolCallId);
	}

	replaceTools(tools: ReadonlyArray<readonly [string, ToolExecutionComponent]>): void {
		this.tools.clear();
		for (const [toolCallId, component] of tools) {
			this.tools.delete(toolCallId);
			this.tools.set(toolCallId, component);
		}
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
	}

	markSettled(): void {
		this.settled = true;
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
	}

	setExpanded(expanded: boolean): void {
		for (const tool of this.tools.values()) {
			tool.setExpanded(expanded);
		}
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools.values()) {
			tool.setShowImages(show);
		}
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools.values()) {
			tool.setImageWidthCells(width);
		}
	}

	invalidate(): void {
		for (const tool of this.tools.values()) {
			tool.invalidate();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const outputPad = Math.min(Math.max(0, this.outputPad), Math.max(0, safeWidth - 1));
		const outerRailWidth = safeWidth - outputPad > 1 ? 1 : 0;
		const railGapWidth = safeWidth - outputPad - outerRailWidth > 1 ? 1 : 0;
		const treeWidth = safeWidth - outputPad - outerRailWidth - railGapWidth > 1 ? 1 : 0;
		const toolWidth = Math.max(1, safeWidth - outputPad - outerRailWidth - railGapWidth - treeWidth);
		const renderedTools: RenderedTool[] = [];

		for (const component of this.tools.values()) {
			const lines = component.render(toolWidth);
			if (lines.some((line) => line !== "")) {
				renderedTools.push({ lines });
			}
		}

		if (renderedTools.length === 0) {
			if (this.pathOrigin !== "continued") {
				return [];
			}
			return this.settled
				? new DiffexPathTerminus(outputPad).render(safeWidth)
				: new DiffexPathRail(outputPad).render(safeWidth);
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
		const glyphs = getGlyphs();
		const leftPad = " ".repeat(outputPad);
		const outerRail = outerRailWidth > 0 ? theme.fg("borderMuted", glyphs.rail) : "";
		const railGap = " ".repeat(railGapWidth);

		for (let toolIndex = 0; toolIndex < renderedTools.length; toolIndex++) {
			const { lines } = renderedTools[toolIndex]!;
			const isLastTool = toolIndex === renderedTools.length - 1;
			let renderedFirstLine = false;

			for (const line of lines) {
				if (line === "") {
					result.push("");
					continue;
				}

				let connector = "";
				if (treeWidth > 0) {
					connector = renderedFirstLine
						? isLastTool
							? " "
							: glyphs.rail
						: isLastTool
							? glyphs.end
							: glyphs.branch;
				}
				const decoratedLine = leftPad + outerRail + railGap + theme.fg("muted", connector) + line;
				result.push(
					visibleWidth(decoratedLine) > safeWidth ? truncateToWidth(decoratedLine, safeWidth, "") : decoratedLine,
				);
				renderedFirstLine = true;
			}
		}

		return result;
	}
}
