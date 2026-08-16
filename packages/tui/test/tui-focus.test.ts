import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	hardwareCursorVisible = false;

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override hideCursor(): void {
		this.hardwareCursorVisible = false;
		super.hideCursor();
	}

	override showCursor(): void {
		this.hardwareCursorVisible = true;
		super.showCursor();
	}
}

class CursorComponent implements Component {
	render(): string[] {
		return [`${CURSOR_MARKER}\x1b[7m \x1b[0m`];
	}

	invalidate(): void {}
}

class FocusUnsupportedTerminal extends RecordingTerminal {
	override readonly focusReportingSupported = false;
}

describe("TUI terminal focus", () => {
	it("enables focus reporting and consumes focus changes", () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const recorder = new InputRecorder();
		tui.setFocus(recorder);

		tui.start();
		assert.ok(terminal.writes.includes("\x1b[?1004h"));
		assert.strictEqual(tui.isTerminalFocused(), true);

		terminal.sendInput("\x1b[O");
		assert.strictEqual(tui.isTerminalFocused(), false);
		assert.deepStrictEqual(recorder.inputs, []);

		terminal.sendInput("\x1b[I");
		assert.strictEqual(tui.isTerminalFocused(), true);
		assert.deepStrictEqual(recorder.inputs, []);

		terminal.sendInput("a");
		assert.deepStrictEqual(recorder.inputs, ["a"]);

		tui.stop();
		assert.ok(terminal.writes.includes("\x1b[?1004l"));
	});

	it("defaults to a static software cursor when focus reporting is unavailable", () => {
		const terminal = new FocusUnsupportedTerminal();
		const tui = new TuiMainScreen(terminal, true);
		tui.addChild(new CursorComponent());

		tui.start();
		tui.renderNow();
		assert.strictEqual(tui.isTerminalFocused(), false);
		assert.strictEqual(terminal.hardwareCursorVisible, false);

		terminal.sendInput("\x1b[I");
		tui.renderNow();
		assert.strictEqual(tui.isTerminalFocused(), true);
		assert.strictEqual(terminal.hardwareCursorVisible, true);
		tui.stop();
	});

	it("reports focus in alternate-screen mode when mouse tracking is disabled", () => {
		const terminal = new RecordingTerminal();
		const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: false });

		tui.start();
		assert.ok(terminal.writes.includes("\x1b[?1004h"));
		tui.stop();
		assert.ok(terminal.writes.includes("\x1b[?1004l"));
	});
});
