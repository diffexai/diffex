/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   diffex --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/diffex-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(diffex: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = diffex.getSessionName();
	return session ? `Diffex - ${session} - ${cwd}` : `Diffex - ${cwd}`;
}

export default function (diffex: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(diffex));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = diffex.getSessionName();
			const title = session ? `${frame} Diffex - ${session} - ${cwd}` : `${frame} Diffex - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	diffex.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	diffex.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	diffex.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
