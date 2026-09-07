import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	harnessStateIndex: fileURLToPath(new URL("./packages/harness-state/src/index.ts", import.meta.url)),
	harnessTraceIndex: fileURLToPath(new URL("./packages/harness-trace/src/index.ts", import.meta.url)),
	evolutionIndex: fileURLToPath(new URL("./packages/evolution/src/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^#evolution$/, replacement: workspaceSourcePaths.evolutionIndex },
			{ find: /^#harness-trace$/, replacement: workspaceSourcePaths.harnessTraceIndex },
			{ find: /^@earendil-works\/diffex-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@earendil-works\/diffex-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@earendil-works\/diffex-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@earendil-works\/diffex-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@earendil-works\/diffex-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@earendil-works\/diffex-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@earendil-works\/diffex-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@earendil-works\/diffex-agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@earendil-works\/diffex-harness-state$/, replacement: workspaceSourcePaths.harnessStateIndex },
			{ find: /^@earendil-works\/diffex-harness-trace$/, replacement: workspaceSourcePaths.harnessTraceIndex },
			{ find: /^@earendil-works\/diffex-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
