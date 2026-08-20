import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const harnessStateSource = fileURLToPath(new URL("../harness-state/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/diffex-harness-state$/, replacement: harnessStateSource }],
	},
});
