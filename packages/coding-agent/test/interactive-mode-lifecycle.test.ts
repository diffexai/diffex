import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type StartableTui = {
	mode: "regular" | "fullscreen";
	start(): void;
	stop(options?: { preserveScreen?: boolean }): void;
};

type InteractiveModeLifecyclePrototype = {
	startInteractiveTui(tui: StartableTui): void;
	uncaughtCrash(
		this: {
			isShuttingDown: boolean;
			unregisterSignalHandlers(): void;
			ui: Pick<StartableTui, "mode" | "stop">;
			stopForTerminalHandoff(tui?: Pick<StartableTui, "mode" | "stop">): void;
		},
		error: Error,
	): never;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeLifecyclePrototype;

describe("InteractiveMode terminal lifecycle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("rolls back terminal state when renderer startup fails", () => {
		const startupError = new Error("startup failed");
		const tui: StartableTui = {
			mode: "fullscreen",
			start: vi.fn(() => {
				throw startupError;
			}),
			stop: vi.fn(),
		};

		expect(() => interactiveModePrototype.startInteractiveTui(tui)).toThrow(startupError);
		expect(tui.stop).toHaveBeenCalledWith({ preserveScreen: true });
	});

	test.each([
		["fullscreen", true],
		["regular", false],
	] as const)("restores terminal modes after a crashing %s renderer", (mode, preserveScreen) => {
		const exitError = new Error("process exited");
		const unregisterSignalHandlers = vi.fn();
		const ui = { mode, stop: vi.fn() };
		const context = {
			isShuttingDown: false,
			unregisterSignalHandlers,
			ui,
			stopForTerminalHandoff(tui: Pick<StartableTui, "mode" | "stop"> = ui): void {
				if (tui.mode === "fullscreen") {
					tui.stop({ preserveScreen: true });
					return;
				}
				tui.stop();
			},
		};
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw exitError;
		}) as typeof process.exit);

		expect(() => interactiveModePrototype.uncaughtCrash.call(context, new Error("crash"))).toThrow(exitError);
		expect(context.isShuttingDown).toBe(true);
		expect(unregisterSignalHandlers).toHaveBeenCalledTimes(1);
		if (preserveScreen) {
			expect(ui.stop).toHaveBeenCalledWith({ preserveScreen: true });
		} else {
			expect(ui.stop).toHaveBeenCalledWith();
		}
	});
});
