import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, Editor, Spacer, Text, type TUI, TuiMainScreen } from "@earendil-works/diffex-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff, type Edit } from "../src/core/tools/edit-diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const TARGET_FILE = "streamed-edit-target.txt";
const EDITOR_TEXT = "stable editor draft";
const FOOTER_TEXT = "gpt-5.6-sol · context 1.3%";

async function waitForText(terminal: VirtualTerminal, expected: string): Promise<string> {
	const deadline = Date.now() + 2000;
	let rendered = "";
	while (Date.now() < deadline) {
		await terminal.waitForRender();
		rendered = terminal.getScrollBuffer().join("\n");
		if (rendered.includes(expected)) {
			return rendered;
		}
	}
	throw new Error(`Timed out waiting for terminal buffer to include "${expected}". Last render:\n${rendered}`);
}

function expectStableComposition(terminal: VirtualTerminal): void {
	const lines = terminal.getScrollBuffer();
	expect(lines.filter((line) => line.includes(TARGET_FILE))).toHaveLength(1);
	expect(lines.filter((line) => line.includes(EDITOR_TEXT))).toHaveLength(1);
	expect(lines.filter((line) => line.includes(FOOTER_TEXT))).toHaveLength(1);
}

describe("streamed edit terminal rendering", () => {
	const tempDirs: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it.each([
		{ columns: 80, rows: 24 },
		{ columns: 120, rows: 36 },
	])(
		"keeps one edit block while its async preview grows and settles at $columns x $rows",
		async ({ columns, rows }) => {
			const cwd = await mkdtemp(join(tmpdir(), "diffex-edit-stream-"));
			tempDirs.push(cwd);
			await writeFile(
				join(cwd, TARGET_FILE),
				["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n"),
				"utf8",
			);
			const edits: Edit[] = [
				{
					oldText: "beta",
					newText: ["beta one", "beta two", "beta three", "beta four", "beta five"].join("\n"),
				},
			];
			const diff = await computeEditsDiff(TARGET_FILE, edits, cwd);
			if ("error" in diff) {
				throw new Error(diff.error);
			}

			const terminal = new VirtualTerminal(columns, rows);
			const ui: TUI = new TuiMainScreen(terminal);
			ui.setClearOnShrink(false);
			const root = new Container();
			const component = new ToolExecutionComponent(
				"edit",
				"streamed-edit-call",
				{ path: TARGET_FILE, edits },
				{},
				createEditToolDefinition(cwd),
				ui,
				cwd,
			);
			const editor = new Editor(ui, getEditorTheme(), {
				frameStyle: "top",
				prompt: "› ",
			});
			editor.setText(EDITOR_TEXT);
			root.addChild(new Text("existing conversation", 0, 0));
			root.addChild(component);
			root.addChild(new Spacer(1));
			root.addChild(editor);
			root.addChild(new Text(FOOTER_TEXT, 0, 0));
			ui.addChild(root);

			ui.start();
			try {
				await waitForText(terminal, TARGET_FILE);
				expectStableComposition(terminal);

				component.setArgsComplete();
				await waitForText(terminal, "beta five");
				expectStableComposition(terminal);

				component.markExecutionStarted();
				await waitForText(terminal, "running");
				expectStableComposition(terminal);

				component.updateResult(
					{
						content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${TARGET_FILE}.` }],
						details: diff,
						isError: false,
					},
					false,
				);
				ui.requestRender();
				await terminal.waitForRender();
				const settled = terminal.getScrollBuffer().join("\n");
				expect(settled).toContain("beta five");
				expect(settled).not.toContain("running");
				expect(settled).not.toContain("complete");
				expectStableComposition(terminal);
			} finally {
				ui.stop();
			}
		},
	);
});
