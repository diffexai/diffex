import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createTestTUI(): TUI {
	return new TuiMainScreen(new VirtualTerminal(80, 24));
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("Editor slash command autocomplete", () => {
	it("accepts the selected command after the cursor moves within its prefix", async () => {
		for (const leftMoves of [1, 2, 3, 4]) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[{ name: "resume", description: "Resume a previous session" }],
				process.cwd(),
			);
			let submitted = "";
			editor.setAutocompleteProvider(provider);
			editor.onSubmit = (text) => {
				submitted = text;
			};

			for (const character of "/res") {
				editor.handleInput(character);
				await flushAutocomplete();
			}
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			for (let move = 0; move < leftMoves; move++) {
				editor.handleInput("\x1b[D");
			}
			editor.handleInput("\r");

			assert.strictEqual(submitted, "/resume", `failed after moving left ${leftMoves} time(s)`);
		}
	});
});
