import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{ find: /^@diffexai\/diffex-telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@diffexai\/diffex-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@diffexai\/diffex-ai$/, replacement: aiSrcIndex },
			{ find: /^@diffexai\/diffex-ai\/compat$/, replacement: aiSrcCompat },
		],
	},
});
