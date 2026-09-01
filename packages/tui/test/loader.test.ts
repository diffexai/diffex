import assert from "node:assert";
import { test } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { type GlyphMode, getGlyphs } from "../src/glyphs.ts";
import type { TUI } from "../src/tui.ts";

function getSignalFrames(mode?: GlyphMode): string[] {
	const { bullet, running } = getGlyphs(mode);
	return [
		`${running}${bullet.repeat(3)}`,
		`${bullet}${running}${bullet.repeat(2)}`,
		`${bullet.repeat(2)}${running}${bullet}`,
		`${bullet.repeat(3)}${running}`,
		`${bullet.repeat(2)}${running}${bullet}`,
		`${bullet}${running}${bullet.repeat(2)}`,
	];
}

function useGlyphMode(mode: GlyphMode): () => void {
	const previousTerm = process.env.TERM;
	const previousAsciiMode = process.env.DIFFEX_ASCII;
	process.env.TERM = "xterm-256color";
	if (mode === "ascii") {
		process.env.DIFFEX_ASCII = "1";
	} else {
		delete process.env.DIFFEX_ASCII;
	}

	return () => {
		if (previousTerm === undefined) {
			delete process.env.TERM;
		} else {
			process.env.TERM = previousTerm;
		}
		if (previousAsciiMode === undefined) {
			delete process.env.DIFFEX_ASCII;
		} else {
			process.env.DIFFEX_ASCII = previousAsciiMode;
		}
	};
}

test("uses the fixed-width signal animation by default", (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
	const restoreGlyphMode = useGlyphMode("unicode");
	let renderRequests = 0;
	const ui = {
		requestRender: () => {
			renderRequests += 1;
		},
	} as unknown as TUI;
	const loader = new Loader(
		ui,
		(value) => value,
		(value) => value,
		"Busy",
	);

	try {
		const frames = getSignalFrames("unicode");
		for (const frame of frames) {
			const lines = loader.render(40);
			assert.strictEqual(lines.length, 1);
			const contentLine = lines[0];
			assert.ok(contentLine.includes(`${frame} Busy`));
			assert.strictEqual(contentLine.indexOf("Busy"), 6);
			context.mock.timers.tick(120);
		}

		assert.strictEqual(renderRequests, frames.length + 1);
	} finally {
		loader.stop();
		restoreGlyphMode();
	}
});

test("can place the unchanged animation after a stable line prefix", (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
	const restoreGlyphMode = useGlyphMode("unicode");
	const loader = new Loader(
		{ requestRender() {} } as unknown as TUI,
		(value) => value,
		(value) => value,
		"Busy",
		{ prefix: "* ", indicatorPosition: "after" },
	);

	try {
		for (const frame of getSignalFrames("unicode")) {
			assert.ok(loader.render(40)[0]?.includes(`* Busy ${frame}`));
			context.mock.timers.tick(120);
		}
	} finally {
		loader.stop();
		restoreGlyphMode();
	}
});

test("uses ASCII signal glyphs in compatibility mode", (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
	const restoreGlyphMode = useGlyphMode("ascii");
	const loader = new Loader(
		{ requestRender() {} } as unknown as TUI,
		(value) => value,
		(value) => value,
		"Busy",
	);

	try {
		for (const frame of getSignalFrames("ascii")) {
			const contentLine = loader.render(40)[0] ?? "";
			assert.ok(contentLine.includes(`${frame} Busy`));
			assert.strictEqual(contentLine.indexOf("Busy"), 6);
			context.mock.timers.tick(120);
		}
	} finally {
		loader.stop();
		restoreGlyphMode();
	}
});
