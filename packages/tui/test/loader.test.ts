import assert from "node:assert";
import { test } from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

const GRENADE_FRAMES = [
	"،    ",
	"′    ",
	" ´   ",
	"  ‾  ",
	"   ⸌ ",
	"    ⸌",
	"    ⸊",
	"    |",
	"    ⁎",
	"    ⁕",
	"   ⁎⁕",
	"  ⁕෴⁕",
	" ⁕⁎⁕ ",
	"⁕⁎෴⁎⁕",
	" ⁎⁕⁎ ",
	"  ෴  ",
	"  ⁕  ",
	"     ",
	"     ",
	"     ",
];

test("uses the fixed-width grenade animation by default", (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
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

	for (const frame of GRENADE_FRAMES) {
		const lines = loader.render(40);
		assert.strictEqual(lines.length, 1);
		const contentLine = lines[0];
		assert.ok(contentLine.includes(`${frame} Busy`));
		assert.strictEqual(contentLine.indexOf("Busy"), 7);
		context.mock.timers.tick(80);
	}

	assert.strictEqual(renderRequests, GRENADE_FRAMES.length + 1);
	loader.stop();
});

test("can place the unchanged animation after a stable line prefix", (context) => {
	context.mock.timers.enable({ apis: ["setInterval"] });
	const loader = new Loader(
		{ requestRender() {} } as unknown as TUI,
		(value) => value,
		(value) => value,
		"Busy",
		{ prefix: "* ", indicatorPosition: "after" },
	);

	for (const frame of GRENADE_FRAMES) {
		assert.ok(loader.render(40)[0]?.includes(`* Busy ${frame}`));
		context.mock.timers.tick(80);
	}

	loader.stop();
});
