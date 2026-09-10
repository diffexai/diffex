import { type Component, truncateToWidth } from "@diffexai/diffex-tui";
import type { SubagentStatus, SubagentSummary } from "../../../core/subagents/types.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

const COLUMN_GAP = "  ";
const MIN_TABLE_WIDTH = 9;
const MIN_TASK_WIDTH = 3;

const STATUS_COLORS = {
	queued: "warning",
	running: "accent",
	idle: "success",
	failed: "error",
	interrupted: "warning",
} satisfies Record<SubagentStatus, ThemeColor>;

function normalizeTask(task: string): string {
	return task.replace(/\s+/gu, " ").trim();
}

export class SubagentsComponent implements Component {
	readonly #subagents: readonly SubagentSummary[];

	constructor(subagents: readonly SubagentSummary[]) {
		this.#subagents = subagents;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];

		const lines = [truncateToWidth(theme.bold("Sub-agents"), width, ""), ""];
		if (this.#subagents.length === 0) {
			lines.push(theme.fg("dim", truncateToWidth("No sub-agents in this session.", width, "...")));
			return lines;
		}

		if (width < MIN_TABLE_WIDTH) {
			lines.push(truncateToWidth("Name Status Task", width, ""));
			for (const subagent of this.#subagents) {
				lines.push(
					truncateToWidth(
						`${subagent.name} ${theme.fg(STATUS_COLORS[subagent.status], subagent.status)} ${theme.fg("dim", normalizeTask(subagent.task))}`,
						width,
						"...",
					),
				);
			}
			return lines;
		}

		const maxNameWidth = Math.max("Name".length, ...this.#subagents.map((subagent) => subagent.name.length));
		const maxStatusWidth = Math.max("Status".length, ...this.#subagents.map((subagent) => subagent.status.length));
		const fixedWidthBudget = width - COLUMN_GAP.length * 2 - MIN_TASK_WIDTH;
		const statusWidth = Math.min(maxStatusWidth, Math.max(1, Math.floor(fixedWidthBudget / 2)));
		const nameWidth = Math.min(maxNameWidth, Math.max(1, fixedWidthBudget - statusWidth));
		const taskWidth = width - nameWidth - statusWidth - COLUMN_GAP.length * 2;
		const formatColumn = (value: string, columnWidth: number): string =>
			truncateToWidth(value, columnWidth, "", true);

		lines.push(
			`${formatColumn("Name", nameWidth)}${COLUMN_GAP}${formatColumn("Status", statusWidth)}${COLUMN_GAP}${truncateToWidth("Task", taskWidth, "")}`,
		);
		for (const subagent of this.#subagents) {
			const name = formatColumn(subagent.name, nameWidth);
			const status = theme.fg(STATUS_COLORS[subagent.status], formatColumn(subagent.status, statusWidth));
			const task = theme.fg("dim", truncateToWidth(normalizeTask(subagent.task), taskWidth, "..."));
			lines.push(`${name}${COLUMN_GAP}${status}${COLUMN_GAP}${task}`);
		}

		return lines;
	}
}
