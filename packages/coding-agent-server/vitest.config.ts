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
					find: /^@diffexai\/diffex-client\/websocket$/,
					replacement: fileURLToPath(new URL("../client/src/websocket.ts", import.meta.url)),
				},
				{
					find: /^@diffexai\/diffex-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@diffexai\/diffex$/,
					replacement: workspaceSourcePaths.codingAgentIndex,
				},
				{
					find: /^@diffexai\/diffex-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{
					find: /^@diffexai\/diffex-server\/testing$/,
					replacement: fileURLToPath(new URL("../server/src/testing/index.ts", import.meta.url)),
				},
				{
					find: /^@diffexai\/diffex-server\/websocket$/,
					replacement: fileURLToPath(new URL("../server/src/transports/websocket/index.ts", import.meta.url)),
				},
				{
					find: /^@diffexai\/diffex-server$/,
					replacement: fileURLToPath(new URL("../server/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
