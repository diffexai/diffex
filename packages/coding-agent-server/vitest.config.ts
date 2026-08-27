import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: { include: ["test/**/*.test.ts"], testTimeout: 30000 },
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/diffex-client\/websocket$/,
					replacement: fileURLToPath(new URL("../client/src/websocket.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/diffex-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/diffex-coding-agent$/,
					replacement: workspaceSourcePaths.codingAgentIndex,
				},
				{
					find: /^@earendil-works\/diffex-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/diffex-server\/testing$/,
					replacement: fileURLToPath(new URL("../server/src/testing/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/diffex-server\/websocket$/,
					replacement: fileURLToPath(new URL("../server/src/transports/websocket/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/diffex-server$/,
					replacement: fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
