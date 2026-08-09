import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

vi.mock("child_process", () => childProcessMocks);

vi.mock("../src/modes/interactive/components/bordered-loader.ts", () => ({
	BorderedLoader: class {
		readonly signal = new AbortController().signal;
		onAbort: (() => void) | undefined;

		dispose(): void {}
	},
}));

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ShareCommandContext = {
	session: { exportToHtml: (outputPath: string) => Promise<string> };
	editorContainer: { clear: () => void; addChild: (child: unknown) => void };
	editor: object;
	ui: { setFocus: (component: unknown) => void; requestRender: () => void };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};

type InteractiveModePrototype = {
	handleShareCommand(this: ShareCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const originalPiShareViewerUrl = process.env.PI_SHARE_VIEWER_URL;

function mockSuccessfulGistCreation(gistUrl: string): void {
	childProcessMocks.spawnSync.mockReturnValue({ status: 0 });
	childProcessMocks.spawn.mockReturnValue({
		stdout: {
			on: (event: string, callback: (data: Buffer) => void) => {
				if (event === "data") callback(Buffer.from(`${gistUrl}\n`));
			},
		},
		stderr: { on: vi.fn() },
		on: (event: string, callback: (code: number) => void) => {
			if (event === "close") queueMicrotask(() => callback(0));
		},
		kill: vi.fn(),
	});
}

function createContext(): {
	context: ShareCommandContext;
	showError: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
} {
	const showError = vi.fn();
	const showStatus = vi.fn();
	return {
		context: {
			session: { exportToHtml: vi.fn(async (outputPath: string) => outputPath) },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			showError,
			showStatus,
		},
		showError,
		showStatus,
	};
}

describe("InteractiveMode /share", () => {
	beforeEach(() => {
		delete process.env.PI_SHARE_VIEWER_URL;
		childProcessMocks.spawn.mockReset();
		childProcessMocks.spawnSync.mockReset();
	});

	afterEach(() => {
		if (originalPiShareViewerUrl === undefined) {
			delete process.env.PI_SHARE_VIEWER_URL;
		} else {
			process.env.PI_SHARE_VIEWER_URL = originalPiShareViewerUrl;
		}
	});

	it("shows the direct Gist once when using the default viewer", async () => {
		const gistUrl = "https://gist.github.com/example/abc123";
		mockSuccessfulGistCreation(gistUrl);
		const { context, showError, showStatus } = createContext();

		await interactiveModePrototype.handleShareCommand.call(context);

		expect(childProcessMocks.spawnSync).toHaveBeenCalledWith("gh", ["auth", "status"], { encoding: "utf-8" });
		expect(childProcessMocks.spawn).toHaveBeenCalledWith("gh", [
			"gist",
			"create",
			"--public=false",
			expect.stringMatching(/session\.html$/),
		]);
		expect(showStatus).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(`Gist: ${gistUrl}`);
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows both the custom viewer and source Gist", async () => {
		process.env.PI_SHARE_VIEWER_URL = "https://viewer.example/session/";
		const gistUrl = "https://gist.github.com/example/abc123";
		mockSuccessfulGistCreation(gistUrl);
		const { context, showError, showStatus } = createContext();

		await interactiveModePrototype.handleShareCommand.call(context);

		expect(showStatus).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(`Share URL: https://viewer.example/session/#abc123\nGist: ${gistUrl}`);
		expect(showError).not.toHaveBeenCalled();
	});
});
