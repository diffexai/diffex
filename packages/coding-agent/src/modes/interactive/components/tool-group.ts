import { type Component, getGlyphs, Text } from "@earendil-works/diffex-tui";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

interface RenderedTool {
	lines: string[];
}

export class ToolGroupComponent implements Component {
	private readonly tools = new Map<string, ToolExecutionComponent>();
	private outputPad: number;
	private settled = false;

	constructor(outputPad = 1) {
		this.outputPad = outputPad;
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

	hasTools(): boolean {
		return this.tools.size > 0;
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
		const treeWidth = safeWidth - outputPad > 1 ? 1 : 0;
		const toolWidth = Math.max(1, safeWidth - outputPad - treeWidth);
		const renderedTools: RenderedTool[] = [];

		for (const component of this.tools.values()) {
			const lines = component.render(toolWidth);
			if (lines.some((line) => line !== "")) {
				renderedTools.push({ lines });
			}
		}

		if (renderedTools.length === 0) {
			return [];
		}

		const label = this.settled ? "Explored" : "Exploring";
		const result = new Text(theme.fg("muted", theme.bold(label)), outputPad, 0).render(safeWidth);
		const glyphs = getGlyphs();
		const leftPad = " ".repeat(outputPad);

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
				result.push(leftPad + theme.fg("muted", connector) + line);
				renderedFirstLine = true;
			}
		}

		return result;
	}
}
