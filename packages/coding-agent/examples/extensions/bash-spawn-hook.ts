/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   diffex -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@earendil-works/diffex-coding-agent";
import { createBashTool } from "@earendil-works/diffex-coding-agent";

export default function (diffex: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, DIFFEX_SPAWN_HOOK: "1" },
		}),
	});

	diffex.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
